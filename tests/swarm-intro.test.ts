/**
 * 进场特效的门槛与账本（0.7.x）。
 *
 * 这些行为此前一条测试都没有：无头也真在播（把 scenarios 测试挡红过）、
 * 注入失败也占名额、keep-alive 下动作被覆盖层吃掉。它们都发生在"还没进
 * 浏览器动作"之前，所以可以用假 page 在毫秒级钉住，不需要真浏览器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'

// 账本与运行态都必须落在临时文件里：真实用户的状态不能被测试读到或改写。
const dir = mkdtempSync(join(tmpdir(), 'dsh-swarm-test-'))
process.env.DSH_BROWSER_SWARM_FILE = join(dir, 'played.json')
process.env.DSH_BROWSER_STATE_FILE = join(dir, 'state.json')

const swarm = await import('../src/swarm-intro.ts')
const runtimeState = await import('../src/runtime-state.ts')
const { swarmBootScript } = await import('../src/swarm-curtain.ts')

/** 一次 evaluate 调用的分类，方便断言"有没有真的去注入/去停"。 */
interface Recorded {
  readonly kind: string
  readonly arg?: unknown
}

/**
 * 假页面：按调用的形状回答，不执行任何真实脚本。
 * 形状判定的顺序很重要 —— 设置控制条那次调用既带对象参数、函数体里又出现
 * `__dshSwarmStop`，必须先按参数认出来。
 */
function fakePage() {
  const calls: Recorded[] = []
  /** 每次以函数形式 evaluate 的源码，用来断言"发给页面的指令里有什么"。 */
  const sources: string[] = []
  const state = {
    poll: 'playing' as 'playing' | 'complete' | 'gone',
    /** 资产的"已画完图层数"，看门狗靠它判断有没有进展。 */
    done: 5,
    /** 藏控制条那一调用的回话：ok / pending（拿不到影子树）/ blocked（样式表被 CSP 挡）。 */
    hide: 'ok' as 'ok' | 'pending' | 'blocked',
    /** 整页模式：引擎积压数与"是否到底"。滚两次就到底，测试不用等 40 步兜底。 */
    backlog: 0,
    atBottom: true,
    scrollSteps: 0,
    /** AI 是否已经动手（keep-alive 下 stopSwarm 会在页面里打这个标记）。 */
    aiWorking: false,
    /** 引擎是否已开始画（看门狗：没开始前不算停滞）。默认 true = 直接进主循环。 */
    started: true,
    /** 这次导航是不是已由 addInitScript 提前启动了同一个引擎。 */
    early: false,
    hostGone: true,
    scrollY: 12,
    scrolled: [] as number[],
  }
  const page = {
    url: () => 'https://example.com/demo',
    isClosed: () => false,
    evaluate: async (target: unknown, arg?: unknown) => {
      if (typeof target === 'string') {
        calls.push({ kind: 'inject' })
        return undefined
      }
      sources.push(String(target))
      if (arg !== undefined && arg !== null && typeof arg === 'object' && 'clicks' in arg) {
        calls.push({ kind: 'hud', arg })
        return { status: state.hide }
      }
      const src = String(target)
      // 提前启动探测：只有 __dshSwarmEarly 且 app.view 已在才算「同一个引擎」已就位。
      if (src.includes('__dshSwarmEarly') && src.includes('app?.view')) {
        calls.push({ kind: 'early-check' })
        return state.early === true
      }
      if (src.includes('backdropFilter')) {
        calls.push({ kind: 'veil' })
        return false
      }
      // 短页面把 frontier 拉满那一次：只认这一个特征，别和主循环的轮询混了。
      if (src.includes('frontier')) {
        calls.push({ kind: 'frontier' })
        return undefined
      }
      // 整页模式的"往下滚一屏"。
      if (src.includes('scrollBy')) {
        calls.push({ kind: 'scroll-step' })
        state.scrollSteps += 1
        if (state.scrollSteps >= 2) state.atBottom = true
        return undefined
      }
      // 记录/还原播放前的滚动位置：两段代码都带这个标记，别让它们被当成轮询。
      if (src.includes('__dshSwarmStart')) {
        calls.push({ kind: 'scroll-restore' })
        return undefined
      }
      // keep-alive 下"AI 已动手"的标记（只打一次；轮询那段的源码里还带 __swarmRebuild，
      // 所以这里要排除掉，否则会把轮询认成打标记）。
      if (src.includes('__dshSwarmAiWorking') && !src.includes('__swarmRebuild')) {
        calls.push({ kind: 'ai-flag' })
        state.aiWorking = true
        return undefined
      }
      // 关闭指令要排在宿主轮询前面：stopSwarm 现在会顺手 `remove()` 掉
      // `swarm-rebuild` 宿主，函数体里也出现 "swarm-rebuild"，先判它会认错。
      if (src.includes('__dshSwarmStop')) {
        calls.push({ kind: 'stop' })
        return undefined
      }
      if (src.includes('swarm-rebuild')) {
        calls.push({ kind: 'host-poll' })
        return state.hostGone
      }
      if (src.includes('window.scrollY')) {
        calls.push({ kind: 'scroll-read' })
        return state.scrollY
      }
      if (src.includes('scrollTo')) {
        calls.push({ kind: 'scroll-write', arg })
        state.scrolled.push(Number(arg))
        return undefined
      }
      if (src.includes('__swarmRebuild')) {
        calls.push({ kind: 'poll' })
        return {
          kind: state.poll,
          done: state.done,
          backlog: state.backlog,
          atBottom: state.atBottom,
          aiWorking: state.aiWorking,
          started: state.started,
        }
      }
      calls.push({ kind: 'other' })
      return undefined
    },
  }
  return { page: page as unknown as Page, calls, state, sources }
}

const count = (calls: Recorded[], kind: string): number => calls.filter((call) => call.kind === kind).length
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

/** 默认配置：开着、不限制站点记录，测试要看的不是"该不该播"的默认值。 */
const CONFIG = { swarm: { enabled: true, oncePerSite: false, speed: 3, maxMs: 15_000 } }

test('播放记录默认只在这趟浏览器里：关窗即忘，不落盘', () => {
  runtimeState.setSwarmTuning({ persistPlayed: false })
  swarm.onPersistPlayedChanged(false)
  swarm.resetPlayed()
  const file = process.env.DSH_BROWSER_SWARM_FILE
  assert.ok(file !== undefined)
  assert.equal(swarm.hasPlayed('a.example'), false)

  swarm.markPlayed('a.example')
  swarm.markPlayed('b.example')
  assert.equal(swarm.hasPlayed('a.example'), true)
  assert.equal(swarm.hasPlayed('b.example'), true)
  assert.equal(swarm.hasPlayed('c.example'), false)
  // 默认不写盘：这正是「关掉整个窗口下次重播」的关键。
  let diskExists = true
  try {
    readFileSync(file, 'utf8')
  } catch {
    diskExists = false
  }
  assert.equal(diskExists, false, '默认不该把播放记录写进磁盘')

  // 关掉整个浏览器窗口 = 忘掉这趟，下次重开全部重播。
  swarm.forgetOnBrowserClose()
  assert.equal(swarm.hasPlayed('a.example'), false)
  assert.equal(swarm.hasPlayed('b.example'), false)
})

test('打开「一直记住」后：写盘，关窗也不重播', () => {
  runtimeState.setSwarmTuning({ persistPlayed: true })
  swarm.onPersistPlayedChanged(true)
  swarm.resetPlayed()
  const file = process.env.DSH_BROWSER_SWARM_FILE
  assert.ok(file !== undefined)

  swarm.markPlayed('a.example')
  swarm.markPlayed('b.example')
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { hosts: Record<string, number> }
  assert.deepEqual(Object.keys(saved.hosts).sort(), ['a.example', 'b.example'])

  swarm.forgetOnBrowserClose()
  assert.equal(swarm.hasPlayed('a.example'), true, '一直记住时关窗不该清掉')
  assert.equal(swarm.hasPlayed('b.example'), true)
  swarm.resetPlayed()
  runtimeState.setSwarmTuning({ persistPlayed: false })
})

test('切回「关窗重播」会删盘：再切回「一直记住」也不会幽灵复活', () => {
  runtimeState.setSwarmTuning({ persistPlayed: true })
  swarm.onPersistPlayedChanged(true)
  swarm.resetPlayed()
  swarm.markPlayed('ghost.example')
  swarm.forgetOnBrowserClose()
  assert.equal(swarm.hasPlayed('ghost.example'), true)

  // 切回默认：磁盘记录必须一起删，否则以后切回来会复活。
  runtimeState.setSwarmTuning({ persistPlayed: false })
  swarm.onPersistPlayedChanged(false)
  assert.equal(swarm.hasPlayed('ghost.example'), false, '切回默认后这趟就当没播过')
  const file = process.env.DSH_BROWSER_SWARM_FILE
  assert.ok(file !== undefined)
  assert.equal(existsSync(file), false, '磁盘上的旧记录要删掉')

  runtimeState.setSwarmTuning({ persistPlayed: true })
  swarm.onPersistPlayedChanged(true)
  assert.equal(swarm.hasPlayed('ghost.example'), false, '再切回来也不能复活')
  swarm.resetPlayed()
  runtimeState.setSwarmTuning({ persistPlayed: false })
  swarm.onPersistPlayedChanged(false)
})

test('多个窗口各记各的：关掉一个不清掉另一个', () => {
  runtimeState.setSwarmTuning({ persistPlayed: false })
  swarm.onPersistPlayedChanged(false)
  swarm.resetPlayed()
  const a = {}
  const b = {}
  swarm.markPlayed('a.example', a)
  swarm.markPlayed('b.example', b)
  assert.equal(swarm.hasPlayed('a.example'), true)
  assert.equal(swarm.hasPlayed('b.example'), true)

  swarm.forgetOnBrowserClose(a) // 只关 A 窗口
  assert.equal(swarm.hasPlayed('a.example'), false, 'A 窗口的记录随 A 一起忘掉')
  assert.equal(swarm.hasPlayed('b.example'), true, 'B 窗口还开着，它的记录不能被清掉')

  swarm.forgetOnBrowserClose(b) // 全关了才彻底清空
  assert.equal(swarm.hasPlayed('b.example'), false)
})

test('中途打开「一直记住」：立刻落盘，不用等关窗', () => {
  runtimeState.setSwarmTuning({ persistPlayed: false })
  swarm.onPersistPlayedChanged(false)
  swarm.resetPlayed()
  swarm.markPlayed('mid.example')
  const file = process.env.DSH_BROWSER_SWARM_FILE
  assert.ok(file !== undefined)
  assert.equal(existsSync(file), false, '默认不写盘')

  runtimeState.setSwarmTuning({ persistPlayed: true })
  swarm.onPersistPlayedChanged(true)
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { hosts: Record<string, number> }
  assert.equal(saved.hosts['mid.example'] !== undefined, true, '打开开关那一刻就要把这趟补写进磁盘')

  swarm.resetPlayed()
  runtimeState.setSwarmTuning({ persistPlayed: false })
  swarm.onPersistPlayedChanged(false)
})

test('同一个引擎：提前启动时不再注入第二遍（否则白底和光标全部重来）', async () => {
  swarm.resetPlayed()
  const { page, calls, state } = fakePage()
  state.early = true
  swarm.maybePlaySwarm(page, CONFIG, false)
  await settle()
  assert.equal(count(calls, 'early-check'), 1, '要先探测引擎是不是已经提前起来了')
  assert.equal(count(calls, 'inject'), 0, '已经起来的同一个引擎绝不能再注入一遍')
  assert.equal(count(calls, 'hud'), 1, '设置速度/控制条那些动作照常要做')
  state.poll = 'gone'
  await settle(400)
})

test('同一个引擎：没提前启动时回退到旧的加载后注入', async () => {
  swarm.resetPlayed()
  const { page, calls, state } = fakePage()
  swarm.maybePlaySwarm(page, CONFIG, false)
  await settle()
  assert.equal(count(calls, 'early-check'), 1)
  assert.equal(count(calls, 'inject'), 1, '标记没落到最终文档时要补注入，功能不能丢')
  state.poll = 'gone'
  await settle(400)
})

test('记过账的站点在 oncePerSite 下不再注入', async () => {
  runtimeState.setSwarmTuning({ persistPlayed: false })
  swarm.onPersistPlayedChanged(false)
  swarm.resetPlayed()
  swarm.markPlayed('example.com')
  const { page, calls } = fakePage()
  swarm.maybePlaySwarm(page, { swarm: { ...CONFIG.swarm, oncePerSite: true } }, false)
  await settle()
  assert.equal(count(calls, 'inject'), 0, '已经播过的站点不该再注入一次')
})

test('无头模式一次都不注入', async () => {
  swarm.resetPlayed()
  const { page, calls } = fakePage()
  swarm.maybePlaySwarm(page, CONFIG, true)
  await settle()
  assert.deepEqual(calls, [], '无头下连遮罩检测都不该跑')
})

test('stopSwarm：auto-close 会去关，keep-alive 不碰它', async () => {
  // --- auto-close ---
  swarm.resetPlayed()
  runtimeState.setSwarmTuning({ whileAiWorks: 'auto-close' })
  const first = fakePage()
  swarm.maybePlaySwarm(first.page, CONFIG, false)
  await settle()
  assert.equal(count(first.calls, 'inject'), 1, 'auto-close 应该正常注入')
  const stopBefore = count(first.calls, 'stop')
  await swarm.stopSwarm(first.page)
  assert.equal(count(first.calls, 'stop'), stopBefore + 1, 'auto-close 下应发出关闭指令')
  first.state.poll = 'gone'
  await settle(400)

  // --- keep-alive ---
  swarm.resetPlayed()
  runtimeState.setSwarmTuning({ whileAiWorks: 'keep-alive' })
  const second = fakePage()
  swarm.maybePlaySwarm(second.page, CONFIG, false)
  await settle()
  assert.equal(count(second.calls, 'inject'), 1)
  const stopBefore2 = count(second.calls, 'stop')
  await swarm.stopSwarm(second.page)
  assert.equal(count(second.calls, 'stop'), stopBefore2, 'keep-alive 下不该去关它')
  second.state.poll = 'gone'
  await settle(400)
})

test('maxMs：0 表示完整播完，越界值被夹进 3000–30000', async () => {
  const realNow = Date.now
  // 假时钟：每次读 Date.now 前进 40 秒，用真实 350ms 的轮询间隔把"播多久"
  // 在毫秒内测出来。4 万 < 12 万（完整播完），但远大于 3 万（上限）。
  let clock = 0
  Date.now = () => (clock += 40_000)
  try {
    swarm.resetPlayed()
    const zero = fakePage()
    swarm.maybePlaySwarm(zero.page, { swarm: { ...CONFIG.swarm, maxMs: 0 } }, false)
    await settle(120)
    assert.ok(count(zero.calls, 'poll') >= 1, 'maxMs=0 应该还在播（上限 12 万），不该被夹成 3 秒')
    zero.state.poll = 'gone'
    await settle(400)

    swarm.resetPlayed()
    const over = fakePage()
    swarm.maybePlaySwarm(over.page, { swarm: { ...CONFIG.swarm, maxMs: 999_999 } }, false)
    await settle(120)
    assert.equal(count(over.calls, 'poll'), 0, 'maxMs 上限应是 3 万，假时钟一步 4 万就该直接结束')
    over.state.poll = 'gone'
    await settle(400)
  } finally {
    Date.now = realNow
  }
})

test('默认首屏不点 Tour 按钮：只调速度，不触发滚动', async () => {
  swarm.resetPlayed()
  const { page, calls, sources, state } = fakePage()
  swarm.maybePlaySwarm(page, CONFIG, false)
  await settle()

  assert.equal(count(calls, 'hud'), 1, '应该有一次设置控制条的调用')
  const hud = sources.find((src) => src.includes('data-dsh-swarm-hide'))
  assert.ok(hud !== undefined, '找不到设置控制条的那段代码')
  // 控制条被补丁删掉后，速度改成直接写引擎的速度值；点按钮那条只作兜底。
  assert.ok(hud.includes('engine.speed'), '速度仍要调（直接写引擎的速度值）')
  // 不点按钮（按钮已被删）。整页模式改用 app.tour 字段，由原版 tourStep 自己滚；
  // 这里只钉"没有点击 tour 按钮"，不去匹配代码里出现的 tour 字样。
  assert.ok(!/\[data-a="tour"\][\s\S]{0,80}\.click\(/.test(hud), '不该用点按钮的方式触发 Tour')

  state.poll = 'gone'
  await settle(400)
})

test('控制条靠影子树里的样式规则压掉（不是一次性 display:none，也不用 eval）', async () => {
  swarm.resetPlayed()
  const { page, sources, state } = fakePage()
  swarm.maybePlaySwarm(page, CONFIG, false)
  await settle()

  const hud = sources.find((src) => src.includes('data-dsh-swarm-hide'))
  assert.ok(hud !== undefined, '找不到设置控制条的那段代码')
  // 2026-11-09 用户实测：控制条会"又弹出来"。一次性的内联 display:none 只压得住
  // 当时那个节点；脚本晚建、或把节点重建一遍，它又露回去。改成插一条样式规则后，
  // 之后新建的节点同样被压住（真机实测：另造的 .hud 也是 display:none，动画照常推进）。
  assert.ok(hud.includes('.hud{display:none!important}'), '要插一条 .hud 的隐藏规则')
  assert.ok(hud.includes('data-dsh-swarm-hide'), '规则要带标记，重试时不能重复插')
  // 原来用 new Function 把函数体拼进页面，页面禁用 eval 时这句直接抛错，
  // 于是"藏控制条"一次都没做到，控制条留在屏幕上。
  assert.ok(!hud.includes('new Function'), '不许再用 new Function（CSP 禁 eval 时会抛错）')
  assert.ok(!/\beval\(/.test(hud), '不许用 eval')

  state.poll = 'gone'
  await settle(400)
})

test('连续 2.5 秒画不出新图层就收尾，不会空转', async () => {
  swarm.resetPlayed()
  const f = fakePage()
  f.state.poll = 'playing'
  f.state.done = 7 // 一直不变 = 没有新图层

  const started = Date.now()
  swarm.maybePlaySwarm(f.page, { swarm: { ...CONFIG.swarm, maxMs: 15_000 } }, false)
  let elapsed = 0
  while (Date.now() - started < 8000) {
    if (count(f.calls, 'stop') >= 1) {
      elapsed = Date.now() - started
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  assert.ok(elapsed >= 2500, '看门狗至少要等满 2.5 秒，实测 ' + String(elapsed) + 'ms')
  assert.ok(elapsed < 7000, '看门狗应该在 2.5 秒后很快收尾，实测 ' + String(elapsed) + 'ms')
})

test('藏不到控制条就不记账（否则这个站以后再也不重试）', async () => {
  swarm.resetPlayed()
  const f = fakePage()
  f.state.hide = 'pending'
  f.state.poll = 'gone'
  swarm.maybePlaySwarm(f.page, { swarm: { ...CONFIG.swarm, maxMs: 15_000 } }, false)
  // 重试窗口是 25 × 160ms ≈ 4 秒，等它走完再断言。
  await new Promise((resolve) => setTimeout(resolve, 4800))
  assert.equal(swarm.hasPlayed('example.com'), false, '藏不到控制条不该占掉这个站的名额')
  assert.equal(count(f.calls, 'hud'), 25, '应该把整个重试窗口走满')
})

test('提前启动 + 严格 CSP：照样撤干净、不记账、不重复注入', async () => {
  swarm.resetPlayed()
  const f = fakePage()
  f.state.early = true
  f.state.hide = 'blocked'
  swarm.maybePlaySwarm(f.page, CONFIG, false)
  await settle(200)
  assert.equal(count(f.calls, 'inject'), 0, '引擎已提前启动，不该再注入一遍')
  assert.equal(count(f.calls, 'early-check'), 1)
  assert.equal(swarm.hasPlayed('example.com'), false, '半成品不该占名额')
  assert.equal(count(f.calls, 'stop'), 0, '撤掉半成品不需要再走一次收尾')
})

test('严格 CSP 挡掉样式表的站点：撤掉覆盖层，也不记账', async () => {
  swarm.resetPlayed()
  const f = fakePage()
  f.state.hide = 'blocked'
  swarm.maybePlaySwarm(f.page, CONFIG, false)
  await settle(200)
  assert.equal(swarm.hasPlayed('example.com'), false, '半成品不该占名额')
  assert.equal(count(f.calls, 'inject'), 1)
  assert.equal(count(f.calls, 'stop'), 0, '撤掉半成品不需要再走一次收尾')
})

test('随包的特效脚本已去掉控制条，上游原文件仍在（可校验、可还原）', () => {
  const root = new URL('..', import.meta.url)
  const shipped = readFileSync(new URL('assets/swarm-rebuild.js', root), 'utf8')
  const upstream = readFileSync(new URL('assets/swarm-rebuild.upstream.js', root))

  // 上游原文件必须还是逐字节那一份：换过上游就得先核对，补丁不能盲打。
  assert.equal(
    createHash('sha256').update(upstream).digest('hex'),
    '6a30f19daaa182d52673035feaeae775c398fa426655cc71a87a451fe00c7bfe',
    'assets/swarm-rebuild.upstream.js 与上游 commit 3d49e0ac 不一致',
  )

  // 控制条整块标记和按钮都不该还在。
  assert.ok(!shipped.includes('class="hud"'), '控制条的标记应该已经删掉')
  assert.ok(!shipped.includes('data-a="speed"'), '控制条上的按钮不该还在')

  // 但那些字段仍被到处写，所以必须换成离屏哑元素，否则一开局就抛 TypeError。
  assert.ok(shipped.includes('document.createElement("div")'), '控制条字段要换成离屏哑元素')

  // 补丁还要在：扫描被压到"等插件放行"，否则它会先滚页面、和拍快照打架。
  assert.ok(shipped.includes('__dshSwarmGo'), '扫描要等插件放行')

  // 「同一个引擎」的三处新补丁：白底不淡入、等 <html> 再启动、提前启动后重认滚动环境。
  assert.ok(shipped.includes('setProperty("transition", "none", "important")'), '白底第一帧就要满不透明')
  assert.ok(shipped.includes('MutationObserver'), 'document_start 注入要等 <html> 出现再启动')
  assert.ok(shipped.includes('__dshSwarmEarly === true'), '提前启动要在放行后重认一次滚动环境')
  assert.ok(shipped.includes('newTarget.addEventListener("scroll"'), '重认滚动容器后要补绑 scroll 监听')
  assert.ok(shipped.includes('waitFrom < 5000'), '放行兜底不能白屏太久')
})

test('提前启动脚本：只在顶层、带时效标记的那次启动，并清掉标记', () => {
  const boot = swarmBootScript()
  assert.ok(boot.includes('window.top === window'), 'iframe 里不该另起一套引擎')
  assert.ok(boot.includes('< 30000'), '残留标记要能自己过期')
  assert.ok(boot.includes('window.name = ""'), '读到标记要立刻清掉')
  assert.ok(boot.includes('__dshSwarmEarly = true'))
  assert.ok(boot.includes('MutationObserver'), '资产里等的 <html> 补丁要在')
  // 资产里有反引号和 ${}，必须用字符串拼接，不能被外层模板字符串插值吃掉。
  assert.ok(boot.includes('`'), '资产全文要原样在里面')
})

test('默认只画首屏：不打开原版的 Tour，也不接管滚动', async () => {
  swarm.resetPlayed()
  const f = fakePage()
  f.state.atBottom = false
  swarm.maybePlaySwarm(f.page, CONFIG, false)
  await settle(600)
  const hud = f.sources.find((s) => s.includes('data-dsh-swarm-hide'))
  assert.ok(hud !== undefined)
  // 页面模式才设 app.tour；默认（首屏）这段代码虽有分支，但入参 pageMode=false，
  // 用假页面无法执行页内逻辑，所以这里只钉：外层没有发任何滚动指令。
  assert.equal(count(f.calls, 'scroll-step'), 0, '默认不该动用户的滚动')
  assert.equal(count(f.calls, 'hud'), 1, '设置控制条那次调用仍然要有')
  f.state.poll = 'gone'
  await settle(400)
})

test('整页模式：把 range=page 传进页内，交给原版 Tour 自己滚（外层不滚）', async () => {
  swarm.resetPlayed()
  runtimeState.setSwarmTuning({ range: 'page' })
  const f = fakePage()
  f.state.atBottom = false
  try {
    swarm.maybePlaySwarm(f.page, { swarm: { ...CONFIG.swarm, maxMs: 6000 } }, false)
    await settle(800)
    // HIDE_CONTROLS 的入参要带 pageMode:true，页内才会设 app.tour=true。
    const hudCall = f.calls.find((c) => c.kind === 'hud')
    assert.ok(hudCall !== undefined, '应该有一次设置控制条的调用')
    const arg = hudCall.arg as { pageMode?: boolean } | undefined
    assert.equal(arg?.pageMode, true, '整页模式要把 pageMode 传进页内')
    // 关键：滚动完全由原版 Tour 驱动，插件外层一条 scrollBy 都不发。
    assert.equal(count(f.calls, 'scroll-step'), 0, '外层不该再自己滚页面')
    const hud = f.sources.find((s) => s.includes('data-dsh-swarm-hide'))
    assert.ok(hud?.includes('app.tour = true'), '页内代码要打开原版的 Tour 开关')
  } finally {
    runtimeState.setSwarmTuning({ range: 'viewport' })
    f.state.poll = 'gone'
    await settle(400)
  }
})
