/**
 * 进场特效：把一个页面「抹白再用光标群重新画出来」。
 *
 * 这不是扩展。效果本体是 assets/swarm-rebuild.js，由 Playwright 直接注入当前
 * 页面执行，所以它跑在插件自己那个窗口里 —— 也就是用户已经登录的那个浏览器。
 *
 * **授权状态（0.8.1 起已解决）**：那份脚本来自 Dhvanil Patel 的
 * github.com/DhvanilPatel/swarm-cursors。2026-11-11 他邮件书面许可本项目
 * **打包与修改**（"you are welcome to bundle and modify it as needed"），
 * 所以资产重新随 npm 包分发；许可没有附 MIT 许可文本，也只覆盖本项目，
 * 不给第三方通用许可。底层的动效设计与编排来自 Joel Califa 的
 * califa/swarm-site，他 2026-11-08 已书面许可、唯一条件是署名。
 * 功能仍然**默认关闭**（config.swarm.enabled），打开才播。
 *
 * 三个约束决定了这里的实现方式：
 *
 * 1. 只在「新网站第一次打开」时播（config.swarm.oncePerSite）。每页都播会
 *    拖慢真正的工作，也会让人烦。播放过的域名记在
 *    ~/.dsh/dsh-browser-swarm.json，删掉这个文件就全部重来。
 * 2. 播完自己结束，不等用户操作：这里只负责等它，超时（config.swarm.maxMs，
 *    0 = 完整播完）就主动叫停，避免长页面上卡着不动。
 * 3. 被整屏遮罩盖住的页面（登录墙、密码框）默认不播：遮罩普遍是前端做的，
 *    底下没解锁的内容也在 DOM 里，画出来等于替人泄露。开关是
 *    config.swarm.playOnVeiled / 设置卡上的「遮罩页面也播」。
 *
 * @module dsh-browser-playwright-codex/swarm-intro
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright-core'
import * as runtimeState from './runtime-state.ts'
import { dropCurtain } from './swarm-curtain.ts'

/** 正在播的页面。用 WeakSet：页面关掉就自动放松，不需要清理。 */
const PLAYING = new WeakSet<Page>()

/** 每个页面这次播放的「AI 动手时怎么办」，stopSwarm 靠它决定要不要让路。 */
const PLAY_MODES = new WeakMap<Page, 'auto-close' | 'keep-alive'>()

function scriptFile(): string {
  // lib/*.js 运行时就在包根下的 assets/ 里；src/*.ts 走 tsx 时也是同一个相对位置。
  return fileURLToPath(new URL('../assets/swarm-rebuild.js', import.meta.url))
}

function readScript(): string {
  // 每次现读，不缓存。这个文件才 10 KB，而"热更新之后还在跑旧脚本"这件事
  // 排查成本高得多（2026-11-08 就为了它多绕了两轮）。
  return fs.readFileSync(scriptFile(), 'utf8')
}

/**
 * 「这趟浏览器里播过哪些站」——默认只记在内存里。
 *
 * 用户 2026-11-09 的要求：把整个插件浏览器窗口关掉，下次再打开必须重新播，
 * 不能像以前那样写进磁盘、关了也记着。所以记录跟着浏览器上下文走：
 * 上下文一关（用户关窗 / 空闲回收 / 宿主重启），调用 forgetOnBrowserClose()
 * 把内存清空即可，磁盘上什么都不留。
 *
 * 只有设置卡里的「一直记住、不重播」打开时，才把记录写盘（见
 * runtimeState.getSwarmTuning().persistPlayed）。老版本留在磁盘上的那个文件
 * 不再被读取，避免「关了窗却还记着」。
 */
/**
 * 每个浏览器上下文各记各的：非持久化模式下可以同时开多个 context（多个会话
 * 窗口），关掉其中一个不能把别的窗口的记录一起清掉（2026-11-09 复核 find B）。
 * WeakMap 的键就是那个 context；context 被回收时它那份记录自动消失。
 */
const playedByContext = new WeakMap<object, Set<string>>()
/** 没有 context 可归属时（测试、启动页）用的兜底记录，跟随「关窗」一并遗忘。 */
let playedFallback = new Set<string>()
/** 当前活跃、可用于判断「还有没有别的窗口」的 context 集合。 */
const liveContexts = new Set<object>()

/** 测试的临时文件覆盖：让测试不必碰真实用户状态，也保留旧测试语义。 */
function playedFile(): string {
  const override = process.env.DSH_BROWSER_SWARM_FILE
  if (override !== undefined && override !== '') return override
  return path.join(os.homedir(), '.dsh', 'dsh-browser-swarm.json')
}

/** 这次查询/记账落在哪个容器里；没有指定 context 时用兜底那份。 */
function playedSet(ctx?: object): Set<string> {
  if (ctx === undefined) return playedFallback
  let set = playedByContext.get(ctx)
  if (set === undefined) {
    set = new Set()
    playedByContext.set(ctx, set)
    liveContexts.add(ctx)
  }
  return set
}

/** 把所有内存里的记录合起来（判断「这站播过没」用）。 */
function allPlayed(): Set<string> {
  const all = new Set(playedFallback)
  // WeakMap 不可遍历（且编译目标不含 .values）：用 liveContexts 逐个取。
  for (const ctx of liveContexts) {
    const set = playedByContext.get(ctx)
    if (set !== undefined) for (const h of set) all.add(h)
  }
  return all
}

function readPlayed(): Record<string, number> {
  if (runtimeState.getSwarmTuning().persistPlayed !== true) {
    const out: Record<string, number> = {}
    for (const h of allPlayed()) out[h] = 1
    return out
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(playedFile(), 'utf8')) as { hosts?: Record<string, unknown> } | null
    const hosts = parsed?.hosts
    if (hosts === undefined || hosts === null || typeof hosts !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [host, at] of Object.entries(hosts)) {
      if (typeof at === 'number') out[host] = at
    }
    // 内存里的这趟也要算上（用户可能中途才打开「一直记住」）。
    for (const h of allPlayed()) if (!(h in out)) out[h] = 1
    return out
  } catch {
    return {}
  }
}

/** 这个域名播过没有。跨所有活着的窗口判断。 */
export function hasPlayed(host: string): boolean {
  return typeof readPlayed()[host] === 'number'
}

/** 记下这个域名已经播过；ctx 传所属浏览器上下文，不传则用兜底。 */
export function markPlayed(host: string, ctx?: object): void {
  playedSet(ctx).add(host)
  if (runtimeState.getSwarmTuning().persistPlayed !== true) return
  flushPlayedToDisk()
}

/** 把内存里这趟的记录写回磁盘（只在「一直记住」打开时用）。 */
function flushPlayedToDisk(): void {
  try {
    const hosts = readPlayed()
    for (const h of allPlayed()) if (!(h in hosts)) hosts[h] = Date.now()
    const target = playedFile()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = target + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ hosts }, null, 2))
    fs.renameSync(tmp, target)
  } catch {
    /* 写不进去就只在这趟里记着 */
  }
}

/** 清空播放记录（设置卡上的「清空记录」用）：内存和磁盘一起清。 */
export function resetPlayed(): void {
  playedFallback = new Set()
  for (const ctx of liveContexts) playedByContext.set(ctx, new Set())
  try {
    fs.rmSync(playedFile(), { force: true })
  } catch {
    /* 已经不存在 */
  }
}

/**
 * 「一直记住」开关切换时调用：打开就把这趟已有记录立刻落盘（别等关窗，
 * 免得宿主崩溃丢记录）；关掉就删掉磁盘记录，防止以后切回来时幽灵复活
 * （2026-11-09 复核 find A）。这个文件是插件自己写的，删它不动用户数据。
 */
export function onPersistPlayedChanged(enabled: boolean): void {
  if (enabled === true) {
    flushPlayedToDisk()
    return
  }
  playedFallback = new Set()
  for (const ctx of liveContexts) playedByContext.set(ctx, new Set())
  try {
    fs.rmSync(playedFile(), { force: true })
  } catch {
    /* 已经不存在 */
  }
}

/**
 * 某个浏览器上下文关掉时调用：只忘掉**它自己**那趟播过哪些站。
 * 还有别的窗口活着时，别的窗口的记录一律保留（复核 find B）。
 * persist 打开时把这趟记录落盘，下次接着记。
 * 关单个标签不会走到这里 —— 那是 closeTab，不是 context 关闭。
 */
export function forgetOnBrowserClose(ctx?: object): void {
  if (runtimeState.getSwarmTuning().persistPlayed === true) {
    flushPlayedToDisk()
    return
  }
  if (ctx === undefined) {
    // 没带窗口标识 = 整个关掉：所有窗口的记录一起忘，下次全部重播。
    for (const live of liveContexts) playedByContext.set(live, new Set())
    playedFallback = new Set()
    return
  }
  playedByContext.delete(ctx)
  liveContexts.delete(ctx)
  // 还有别的窗口活着就只忘这一个窗口的；全关了才连兜底那份一起忘。
  if (liveContexts.size > 0) return
  playedFallback = new Set()
}

/** 这个页面正在播吗。 */
export function isPlaying(page: Page): boolean {
  return PLAYING.has(page)
}

/**
 * 关掉正在播的特效。任何工具动作开始前都调用它 —— 覆盖层本身不接管鼠标
 * （pointer-events: none），所以拦不住点击；但 AI 动手时它该让开，画面才
 * 不会被人当成页面坏了。
 *
 * 失败一律吞掉：页面可能已经关掉、正在跳转，或者根本没播过。
 */
export async function stopSwarm(page: Page): Promise<void> {
  if (!PLAYING.has(page)) return
  // 「动画继续跑」模式：这一层已经不接管鼠标了，AI 动手不需要动它，让它自己播完。
  // 但要把"AI 已经在用这个页面"记进页面里：整页模式的滚动循环看到这个标记就停滚，
  // 否则 AI 干活时页面还在脚下一屏屏跳（2026-11-09 复核提的语义问题）。
  if (PLAY_MODES.get(page) === 'keep-alive') {
    try {
      await page.evaluate(() => {
        ;(window as unknown as { __dshSwarmAiWorking?: boolean }).__dshSwarmAiWorking = true
      })
    } catch {
      /* 页面已经走了 */
    }
    return
  }
  PLAYING.delete(page)
  // 先把页面滚回播放前的位置，再停：停完 app 就没了，那时再想找"真正在滚的那个
  // 容器"已经找不到（局部滚动页面里 window.scrollY 永远是 0，2026-11-09 复核实测）。
  await restoreScroll(page)
  try {
    await page.evaluate(() => {
      const w = window as unknown as { __dshSwarmStop?: () => void; __dshSwarm?: { stop?: () => void } }
      if (typeof w.__dshSwarmStop === 'function') w.__dshSwarmStop()
      else if (typeof w.__dshSwarm?.stop === 'function') w.__dshSwarm.stop()
      // 让路必须立刻生效：资产退出时先恢复页面、再淡出 1.2 秒才移除宿主。那 1.2 秒里
      // 覆盖层还在，后续动作的命中测试会判成"被遮挡"（实测点击直接失败）。这里把它
      // 直接摘掉——页面在 destroy 开头就已经恢复可见了，摘掉不影响观感。
      for (const host of document.querySelectorAll('swarm-rebuild')) host.remove()
    })
  } catch {
    /* 页面没了，或者已经开始跳转：没有东西需要关 */
  }
}

/**
 * 把页面滚回播放前的位置。
 *
 * 关键：**不能只认 `window.scrollY`**。后台、小红书这类页面的滚动发生在某个
 * `overflow:auto` 的容器里，这时 window 一直是 0，只有引擎的 env 知道那个容器滚到
 * 哪儿了。位置在播放刚开始时就被记进 `window.__dshSwarmStart`（那时扫描还没滚），
 * 还原时优先用 env，拿不到才退回 window（2026-11-09 复核发现原实现只还原 window）。
 */
async function restoreScroll(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const w = window as unknown as {
        __dshSwarmStart?: { x: number; y: number }
        __swarmRebuild?: { app?: { env?: { scrollTo?: (y: number, x: number) => void } } }
      }
      const start = w.__dshSwarmStart
      if (start === undefined) return
      const env = w.__swarmRebuild?.app?.env
      if (env !== undefined && typeof env.scrollTo === 'function') env.scrollTo(start.y, start.x)
      else window.scrollTo(start.x, start.y)
      // 还原完就把这份位置清掉：别让它一直挂在页面上被页面脚本读到。
      delete w.__dshSwarmStart
    })
  } catch {
    /* 页面已经走了，没有东西要还原 */
  }
}

interface SwarmPlayOptions {
  /** 播最久多久（毫秒）。0 已在调用方换成很宽的上限，这里就是实际用的值。 */
  readonly maxMs: number
  /** 点几次速度按钮：0 = 1×，1 = 2×，2 = 3×。 */
  readonly speedClicks: number
  /** 播成功后要记进"已播过"的域名；空串表示不记（每次都要播）。 */
  readonly markHost?: string
  /**
   * AI 动手时：true = 动画继续跑（覆盖层不接管鼠标），false/省略 = 立刻关掉让路。
   */
  readonly keepAlive?: boolean
  /**
   * 播放范围：`page` = 由这里按节奏往下滚，一屏一屏把整页画完（会接管滚动）；
   * 省略 / `viewport` = 只画当前这一屏。
   */
  readonly range?: 'viewport' | 'page'
}

/** `HIDE_CONTROLS` 的回话：还没拿到影子树 / 藏好了 / 这个站把样式表挡了。 */
type HideResult = { status: 'ok' } | { status: 'pending' } | { status: 'blocked' }

/**
 * 藏掉原版脚本自带的控制条，并把速度调到最快、留下"立刻退出"的入口。
 *
 * 为什么现在是一个普通函数而不是拼字符串：以前用 `new Function(FIND_ROOT)` 在页面里
 * 造函数，页面一旦禁用 eval（CSP 里没有 'unsafe-eval'）或者注入后立刻导航，那一句就
 * 直接抛错，整段"藏控制条"一次都做不到 —— 控制条就留在屏幕上。改成普通函数后，
 * Playwright 直接把函数源码序列化进页面，不需要 eval（2026-11-09 改）。
 *
 * 返回 `pending` = 还没拿到影子树，调用方继续重试；`blocked` = 这个站的 CSP 把影子树里
 * 的样式表一起挡了，特效本身是坏的，调用方应当撤掉覆盖层且不记账。
 */
const HIDE_CONTROLS = ({
  clicks,
  keepAlive,
  pageMode,
}: {
  clicks: number
  keepAlive: boolean
  pageMode: boolean
}): HideResult => {
  const w = window as unknown as {
    __swarmRebuild?: {
      app?: {
        view?: { root?: ShadowRoot }
        root?: ShadowRoot
        engine?: { speed?: number; start?: () => void; started?: boolean }
        env?: { geom?: () => { sx: number; sy: number } }
        tour?: boolean
      }
      root?: ShadowRoot
      stop?: (reveal?: boolean) => void
    }
    __dshSwarmStop?: () => void
    __dshSwarmStart?: { x: number; y: number }
  }
  /** 找到效果挂上去的 shadow root（原版脚本用 mode: 'open' 建的那个）。 */
  const findRoot = (): ShadowRoot | null => {
    const a = w.__swarmRebuild && w.__swarmRebuild.app
    if (a && a.view && a.view.root) return a.view.root as ShadowRoot
    if (w.__swarmRebuild && w.__swarmRebuild.root) return w.__swarmRebuild.root
    for (const el of Array.from(document.body.children)) {
      if (el.shadowRoot && el.shadowRoot.querySelector('.hud')) return el.shadowRoot
    }
    // 兜底：宿主不一定是 body 的直接子节点，整页扫一遍（只在没拿到 app 时走）。
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const sr = el.shadowRoot
      if (sr && sr.querySelector('.hud')) return sr
    }
    return null
  }

  const root = findRoot()
  if (root === null) return { status: 'pending' }

  // 严格 CSP（`style-src 'self'`）的站点会连影子树里的 `<style>` 一起挡掉 —— 包括
  // 原版脚本自己的样式表。这时覆盖层没有样式、控制条退化成页面上一行普通文字，
  // 特效本身就是坏的，藏不藏控制条都没意义。判据：影子树里一张样式表都没有。
  // 2026-11-09 复核实测：普通页 styleSheets.length = 1；`style-src 'self'` 页 = 0，
  // 而且 .hud 的计算 display 回到默认值 block、高度 21px。
  if (root.styleSheets.length === 0) return { status: 'blocked' }

  // 藏控制条：**用 CSSOM 写内联样式**，而不是只靠 <style> 规则。
  // 随包那份脚本的控制条已经被补丁删掉了（scripts/swarm-patch.mjs），所以这段现在
  // 是兜底：万一有人把未打补丁的原版塞回来，控制条照样不会露面。
  // 写法上保留两层 —— ① 脚本写内联样式不受 `style-src` 限制；② <style> 规则能压住
  // 以后重建的节点（2026-11-09 实测：另造的 .hud 也是 display:none）。
  const hideNow = (): void => {
    const el = root.querySelector('.hud') as HTMLElement | null
    if (el !== null && el.style.display !== 'none') el.style.setProperty('display', 'none', 'important')
  }
  hideNow()

  // <style> 规则留作双保险（CSP 允许时生效，重建的节点也一并压住）。
  // 2026-11-09 实测：插规则后另造一个 .hud，同样 display:none，动画照常推进。
  if (root.querySelector('style[data-dsh-swarm-hide]') === null) {
    const st = document.createElement('style')
    st.setAttribute('data-dsh-swarm-hide', '1')
    st.textContent = '.hud{display:none!important}'
    root.appendChild(st)
  }

  // 兜底：脚本以后重建控制条时，观察者把新节点再压一次。**只在真的有控制条时才挂**：
  // 随包那份已经把控制条删了，而动画每帧都会大改影子树，观察者回调会把主线程吃满、
  // 引擎看着"没进展"（2026-11-09 实测：动画停在 32 个图层）。没控制条就别挂。
  const hadHud = root.querySelector('.hud') !== null
  const watched = root as ShadowRoot & { __dshHudWatched?: boolean }
  if (hadHud && watched.__dshHudWatched !== true) {
    watched.__dshHudWatched = true
    new MutationObserver(() => hideNow()).observe(root, { childList: true, subtree: true })
  }

  // 「动画继续跑」模式：必须对宿主元素下手。宿主自带内联的
  // pointer-events:auto !important，影子树里再写规则也压不过它 —— 同一元素上
  // 后写的 !important 才能覆盖（2026-11-08 实测：改之前点击 4 秒超时）。
  if (keepAlive) (root.host as HTMLElement).style.setProperty('pointer-events', 'none', 'important')

  // 播放速度：随包那份脚本的控制条已被删掉（见 scripts/swarm-patch.mjs），所以直接改
  // 引擎的速度值 —— 原版 speeds = [1, 2, 3]，按钮点 N 次本来就等于 1+N 倍。
  // 兜底保留点按钮：万一有人把没打补丁的原版塞回来，这条路仍然可用。
  const wanted = Math.min(3, Math.max(1, 1 + clicks))
  const engine = w.__swarmRebuild?.app?.engine
  if (engine !== undefined) {
    engine.speed = wanted
  } else {
    const speedBtn = root.querySelector('[data-a="speed"]') as HTMLElement | null
    for (let i = 0; i < clicks; i++) speedBtn?.click()
  }

  // 播放范围：整页模式交给**原版自己的 Tour 机制**，不再由插件外层硬滚。
  //
  // 原版控制条上的 Tour 按钮（`data-a="tour"`）点击后只做两件事：设 `this.tour=true`
  // 和 `engine.start()`，之后每帧 `tourStep()` 会按引擎自己的完成度慢慢往下滚
  // （backlog 小就滚、大就停），滚动和光标是同一个引擎驱动，从顶部连续往下。
  // 之前我自己写的"每 1.4 秒 env.scrollBy 一屏"和资产的扫描/frontier 打架，
  // 会把起点推到页面中段、光标反复飞（2026-11-09 用户实测）。这里直接打开原生开关。
  // 控制条已被补丁删掉，所以设字段而不是点按钮；`engine.start()` 只在真的没开始时调。
  if (pageMode) {
    const app = w.__swarmRebuild?.app
    if (app !== undefined) {
      app.tour = true
      const eng = app.engine
      if (eng !== undefined && typeof eng.start === 'function' && eng.started !== true) eng.start()
    }
  }

  // 退出：补丁后的脚本没有 ✕ 按钮了，直接调它自己的 `stop(false)`——那条路是
  // destroy(false)，立即取消 RAF 并移除宿主，比点按钮更干净。按钮那条留作兜底，
  // 兼容没打补丁的原版。
  w.__dshSwarmStop = () => {
    const api = w.__swarmRebuild
    if (api !== undefined && typeof api.stop === 'function') {
      api.stop(false)
      return
    }
    const again = findRoot()
    const button = again?.querySelector('[data-a="live"]') ?? again?.querySelector('[data-a="close"]')
    ;(button as HTMLElement | null)?.click()
  }
  return { status: 'ok' }
}

/** 注入并播放，播完自己退出。 */
async function playSwarm(page: Page, options: SwarmPlayOptions): Promise<void> {
  if (PLAYING.has(page)) return
  let code: string
  try {
    code = readScript()
  } catch {
    return // 资源缺失就当没这个功能，不能影响导航
  }
  PLAYING.add(page)
  PLAY_MODES.set(page, options.keepAlive === true ? 'keep-alive' : 'auto-close')
  try {
    // 记下播放前的位置：自动滚动会把页面带到下方，播完要送回来。
    // 先记一份 window 的位置兜底：注入前还拿不到引擎的 env。内滚容器（overflow:auto）
    // 的位置会在注入后由 HIDE_CONTROLS 用 env.geom() 覆盖掉。
    await page
      .evaluate(() => {
        ;(window as unknown as { __dshSwarmStart?: { x: number; y: number } }).__dshSwarmStart = {
          x: window.scrollX,
          y: window.scrollY,
        }
      })
      .catch(() => {})
    // 「同一个引擎」：导航前打了标记时，原版引擎已在第一帧由 addInitScript 启动。
    // 这时**绝不能再注入一遍** —— 重新执行会新建 App、白底和 18 个光标全部重来，
    // 等于又换了一次人，正是用户反复指出的断层。只有引擎确实没在才回退到旧的注入。
    const early = await page
      .evaluate(() => {
        const w = window as unknown as {
          __dshSwarmEarly?: boolean
          __swarmRebuild?: { app?: { view?: unknown } }
        }
        return w.__dshSwarmEarly === true && w.__swarmRebuild?.app?.view !== undefined
      })
      .catch(() => false)
    if (early !== true) await page.evaluate(code)
    // 注入刚返回时 App 已经建好（含 env），而它的扫描（会滚一遍页面催懒加载）还没开始
    // —— 这是唯一能拿准"真正滚动位置"的时机。局部滚动页面里 window.scrollY 恒为 0，
    // 只有 env.geom() 知道那个 overflow:auto 的容器滚到哪儿了（2026-11-09 实测验过：
    // 放到重试循环里记，会记到扫描滚到半路的位置，回滚就停在中途）。
    await page
      .evaluate(() => {
        const w = window as unknown as {
          __swarmRebuild?: { app?: { env?: { geom?: () => { sx: number; sy: number } } } }
          __dshSwarmStart?: { x: number; y: number }
        }
        const g = w.__swarmRebuild?.app?.env?.geom?.()
        if (g !== undefined) w.__dshSwarmStart = { x: g.sx, y: g.sy }
      })
      .catch(() => {})
    // 记账挪到"界面也藏好了"之后再写：注入成功但藏控制条十二次全失败时，
    // 名额不该被占掉（否则这个站以后再也不会重试）。

    // 原版脚本自带一条底部控制条（速度 / Tour / Go live / ✕）。自动播放时它
    // 只是噪音：藏掉，把速度调到最快、打开自动滚动，并留下一个"立刻退出"的
    // 入口给 stopSwarm 用。
    //
    // 这一步必须重试：脚本是异步建界面的，注入刚返回时影子节点可能还没挂上，
    // 一次没找到就永远留着那条控制条（2026-11-08 实测到过）。
    // 这一步必须重试：脚本是异步建界面的，注入刚返回时影子节点可能还没挂上
    // （2026-11-08 实测到过）。窗口给到 25 × 160ms ≈ 4 秒：慢页面也要藏得到。
    let hidden = false
    let blocked = false
    for (let attempt = 0; attempt < 25; attempt++) {
      // 页面关了、或者这一页已经被别处收掉，就别再空转剩下的重试。
      if (page.isClosed() || !PLAYING.has(page)) return
      let status: HideResult['status'] = 'pending'
      try {
        const result = await page.evaluate(HIDE_CONTROLS, {
          clicks: options.speedClicks,
          keepAlive: options.keepAlive === true,
          pageMode: options.range === 'page',
        })
        status = result.status
      } catch {
        // 重试期间页面导航或关闭：这一轮跳过，不能让整段流程断在这里。
        status = 'pending'
      }
      if (status === 'ok') {
        hidden = true
        break
      }
      if (status === 'blocked') {
        blocked = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 160))
    }
    if (blocked) {
      // 这个站把影子树里的样式表挡了：覆盖层没有样式、控制条裸在外面，是半成品。
      // 撤掉它，并且**不记账** —— 站点的 CSP 以后可能变，留着以后重试的机会。
      // 先还原滚动：扫描阶段照样会滚一遍页面，不还原就把人扔在半路。
      await dropCurtain(page)
      await restoreScroll(page)
      await page
        .evaluate(() => {
          const host = document.querySelector('swarm-rebuild')
          if (host !== null) host.remove()
        })
        .catch(() => {})
      return
    }
    // 藏好控制条后**不要撤任何东西**：现在画面就是原版引擎自己（自造白幕已删），
    // 它要继续往下画。旧代码在这里撤白幕，是两套引擎时代留下的动作。
    // 只有真的藏到了才算"播过"。藏不到还占名额，等于把"藏不住"升级成"再也不重试"，
    // 正是 2026-11-09 复核抓到的坑。带上所属 context，关窗时只忘这一趟的。
    // 测试的假页面没有 context()，读不到就落回兜底那份，不能让记账把播放带崩。
    if (hidden && options.markHost !== undefined && options.markHost !== '') {
      let ctx: object | undefined
      try {
        ctx = page.context()
      } catch {
        ctx = undefined
      }
      markPlayed(options.markHost, ctx)
    }

    // 短页面（没有可滚动距离）时，脚本里的 gate 永远等不到 frontier 推进 —— 下半页任务
    // 就永久不可用，引擎永远到不了 complete，只能靠看门狗硬收尾。这里一次性把 frontier
    // 拉满：那些任务在视口外画完（看不见），但状态是"完成"，收尾干净。
    await page
      .evaluate(() => {
        const app = (
          window as unknown as {
            __swarmRebuild?: {
              app?: {
                engine?: { frontier?: number }
                env?: { geom?: () => { vh: number }; scrollHeight?: () => number }
              }
            }
          }
        ).__swarmRebuild?.app
        if (app === undefined) return
        const g = app.env?.geom?.()
        const height = app.env?.scrollHeight?.()
        if (g === undefined || height === undefined) return
        if (height <= g.vh + 8) {
          const engine = app.engine
          if (engine !== undefined) engine.frontier = height + 1000
        }
      })
      .catch(() => {})

    const deadline = Date.now() + options.maxMs
    let reachedEnd = false
    // 进度看门狗：连续 2.5 秒画不出新图层就当画完了。
    // 整页模式的滚动完全由原版 Tour 机制在页内驱动（HIDE_CONTROLS 里设 app.tour），
    // 插件外层只负责等它播完、回滚、收尾，不再自己滚 —— 之前外层硬滚会打架，
    // 把起点推到页面中段（2026-11-09 用户实测"从中间开始、上下重复"）。
    let lastDone = -1
    let stalledMs = 0
    while (Date.now() < deadline) {
      if (page.isClosed()) return
      const state = await page.evaluate(() => {
        const app = (
          window as unknown as {
            __swarmRebuild?: {
              app?: { complete?: boolean; engine?: { doneCount?: number; started?: boolean } }
            }
          }
        ).__swarmRebuild?.app
        if (app === undefined) return { kind: 'gone', done: -1, started: false }
        const engine = app.engine
        return {
          kind: app.complete === true ? 'complete' : 'playing',
          done: engine?.doneCount ?? -1,
          // 还没开始画（等放行 / 扫描中）：不算停滞，否则看门狗会在开场就收掉。
          started: engine?.started === true,
        }
      })
      if (state.kind === 'gone') {
        // 外部把动画停了（AI 动手、用户点了退出）：先还原滚动再走，别把人扔在半路。
        await restoreScroll(page)
        return
      }
      if (state.kind === 'complete') {
        reachedEnd = true
        break
      }
      if (state.started !== true) {
        // 开场阶段（等放行 / 扫描中）：不算停滞。
        lastDone = state.done
        stalledMs = 0
        await new Promise((resolve) => setTimeout(resolve, 350))
        continue
      }
      if (state.done === lastDone) {
        stalledMs += 350
        if (stalledMs >= 2500) {
          reachedEnd = true
          break
        }
      } else {
        lastDone = state.done
        stalledMs = 0
      }
      await new Promise((resolve) => setTimeout(resolve, 350))
    }

    // 播完了，停一下让人看清最后成形的样子，然后退回真实页面；
    // 超时没播完也照样退，别让页面一直动下去。
    if (reachedEnd) await new Promise((resolve) => setTimeout(resolve, 1200))
    // 还原滚动要赶在 stop **之前**：停完 app 就没了，那时再想找"真正在滚的那个容器"
    // 已经找不到（局部滚动页面里 window.scrollY 恒为 0，2026-11-09 复核实测）。
    // 覆盖层是 fixed 且每帧跟随滚动，所以"边滚边播"不会打架，不需要等宿主消失。
    await restoreScroll(page)
    PLAYING.delete(page)
    try {
      await page.evaluate(() => {
        const stop = (window as unknown as { __dshSwarmStop?: () => void }).__dshSwarmStop
        if (typeof stop === 'function') stop()
      })
    } catch {
      /* 页面已经走了 */
    }
  } catch {
    // 注入失败（页面受保护、正在跳转、已经被关掉）都不是错误：静默跳过。
  } finally {
    PLAYING.delete(page)
  }
}

/** 把设置里的数夹到合理范围，坏值不会把页面卡死。 */
function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, num))
}

/**
 * 页面是不是被一层全屏遮罩盖着（登录墙、密码框、年龄确认这类）。
 *
 * 这类遮罩普遍是**前端**做的：真正的内容早就写在 DOM 里，只是被一块不透明的
 * 层盖住。特效会跳过透明度和 display 检查，却看不见"被谁盖住"，于是会把底下
 * 的内容画出来 —— 等于绕过遮罩放了一遍。实测 2026-11-08：WorkBuddy 面板没输
 * 密码时，页面树里已经能读到全部账号与模型清单。
 *
 * 所以只要检测到这样的遮罩就不播：宁可少一次观感，不替人泄露他没解锁的东西。
 */
async function hasBlockingVeil(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const nodes = document.body ? document.body.querySelectorAll('div,section,main,aside,article') : []
      for (const el of nodes) {
        const cs = getComputedStyle(el)
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue
        const z = Number.parseInt(cs.zIndex, 10)
        if (!(z >= 100)) continue
        const r = el.getBoundingClientRect()
        if (r.width * r.height < vw * vh * 0.9) continue
        const bg = cs.backgroundColor
        const m = /^rgba?\(([^)]+)\)$/.exec(bg)
        let alpha = 1
        if (m !== null) {
          const parts = (m[1] ?? '').split(',').map((s) => Number.parseFloat(s))
          if (parts.length === 4) alpha = parts[3] ?? 1
        }
        if (alpha > 0.35) return true // 接近不透明的整屏盖板
        // 半透明登录墙（最常见的写法）常常 alpha 只有 0.3–0.5：只要这块盖板里
        // 有密码框或表单，就按遮罩处理，别把底下的内容画出来。
        if (alpha > 0.05 && el.querySelector('input[type="password"], form') !== null) return true
        if (cs.backdropFilter !== 'none' && cs.backdropFilter !== '') return true
      }
      return false
    })
  } catch {
    // 读不出来就不播：安全默认值。
    return true
  }
}

/**
 * 启动页。原来浏览器刚打开时停在 about:blank —— 一张纯白页，除了占位没有
 * 任何用处，用户看见只会问「这是干嘛的」。这里换成一张说明卡：告诉人它已经
 * 就绪、地址栏为什么是 about:blank、以及怎么用。没有外部资源，纯内联样式，
 * 断网也是秒开。
 */
export const WELCOME_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>浏览器已就绪</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f5f6f8; color: #1d1d1f;
    font: 15px/1.7 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .card {
    width: min(560px, 86vw); padding: 38px 40px 34px; background: #fff; border-radius: 18px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 12px 40px rgba(0,0,0,.08);
  }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #34c759; display: inline-block; margin-right: 9px; vertical-align: middle; }
  h1 { font-size: 23px; margin: 0 0 6px; letter-spacing: -.01em; }
  .sub { color: #6b6b70; margin: 0 0 26px; }
  .row { display: flex; gap: 12px; padding: 13px 0; border-top: 1px solid #ececf0; }
  .k { color: #8a8a8f; min-width: 96px; font-size: 13px; }
  .v { flex: 1; font-size: 14px; }
  code { font-family: ui-monospace, Consolas, monospace; background: #f2f2f5; padding: 1px 6px; border-radius: 5px; font-size: 13px; }
  .foot { margin: 24px 0 0; color: #9a9aa0; font-size: 12.5px; }
</style></head><body>
<div class="card">
  <h1><span class="dot"></span>浏览器已就绪</h1>
  <p class="sub">想让我打开哪个网站，说一句就行。</p>
  <div class="row"><div class="k">地址栏</div><div class="v"><code>about:blank</code> —— 浏览器内置的空白页，表示还没去任何网站</div></div>
  <div class="row"><div class="k">这一页</div><div class="v">是光标一笔一笔画出来的，按 <code>Esc</code> 可以立即跳过</div></div>
  <div class="row"><div class="k">登录状态</div><div class="v">保存在这个浏览器里，关掉窗口也不会丢</div></div>
  <p class="foot">第一次打开某个网站时，那页也会这样自己长出来一次。</p>
</div></body></html>`

/**
 * 把空白页换成启动卡片，并在上面放一次特效。特效不等它播完（启动不能被
 * 拖住 9 秒），放出去就返回；真有工具动作要执行时 stopSwarm 会先把它关掉。
 */
export async function showWelcome(
  page: Page,
  config: { swarm?: { enabled?: boolean; speed?: number; maxMs?: number } } | undefined,
): Promise<void> {
  try {
    await page.setContent(WELCOME_HTML, { waitUntil: 'domcontentloaded' })
  } catch {
    return // 页面还没准备好：留一张空白页也不影响任何事
  }
  const userChoice = runtimeState.getSwarm()
  const enabled = userChoice ?? config?.swarm?.enabled ?? true
  if (!enabled) return
  const tuning = runtimeState.getSwarmTuning()
  const speed = clamp(tuning.speed ?? config?.swarm?.speed, 1, 3, 3)
  const rawMax = tuning.maxMs ?? config?.swarm?.maxMs
  void playSwarm(page, {
    maxMs: rawMax === 0 ? 120000 : clamp(rawMax, 3000, 30000, 15000),
    speedClicks: speed - 1,
  })
}

/**
 * 这次导航要不要播（只看不费时的条件，用来决定"开场白幕"要不要提前挂）。
 *
 * 注意传的是**目标地址**：导航前的 `page.url()` 还是旧页面，拿它判断会永远不播。
 * 遮罩页那种需要读页面的判断留到注入之后做，那时会顺手把白幕撤掉。
 */
export function willPlaySwarm(
  targetUrl: string,
  config: Parameters<typeof maybePlaySwarm>[1],
  headless?: boolean,
): boolean {
  try {
    if (headless === true) return false
    if (!/^https?:/i.test(targetUrl)) return false
    const host = new URL(targetUrl).hostname
    if (host === '') return false
    const userChoice = runtimeState.getSwarm()
    const enabled = userChoice ?? config?.swarm?.enabled ?? true
    if (!enabled) return false
    const tuning = runtimeState.getSwarmTuning()
    const oncePerSite = tuning.oncePerSite ?? config?.swarm?.oncePerSite ?? true
    if (oncePerSite && hasPlayed(host)) return false
    return true
  } catch {
    return false
  }
}

/** 导航之后调用：够条件就播一次，不等它播完（导航照常立刻返回快照）。 */
export function maybePlaySwarm(
  page: Page,
  config:
    | {
        swarm?: {
          enabled?: boolean
          oncePerSite?: boolean
          speed?: number
          maxMs?: number
          playOnVeiled?: boolean
          range?: 'viewport' | 'page'
        }
      }
    | undefined,
  headless?: boolean,
): void {
  void (async () => {
    try {
      // 无头浏览器没人看着：不播。测试和无头任务都跑在这里，播了只会挡住点击。
      // 也不去碰过场：无头下 `shouldShowPrelude` 本来就返回 false，从没盖过。
      if (headless === true) return
      const url = page.url()
      if (!/^https?:/i.test(url)) return // about:blank、chrome:// 这类页面没有意义
      const host = new URL(url).hostname
      if (host === '') return

      // 用户的开关优先；没表态就用配置里的默认值（出厂是开）。
      const userChoice = runtimeState.getSwarm()
      const enabled = userChoice ?? config?.swarm?.enabled ?? true
      if (!enabled) {
        // 关着也要把可能已提前启动的引擎撤掉：标记可能是上一次导航残留的，
        // 不清就会白屏卡住（2026-11-09 复核 find B）。
        await dropCurtain(page)
        return
      }

      // 设置卡上的三行参数优先，没有就落到配置默认值。
      const tuning = runtimeState.getSwarmTuning()
      const oncePerSite = tuning.oncePerSite ?? config?.swarm?.oncePerSite ?? true
      if (oncePerSite && hasPlayed(host)) {
        await dropCurtain(page)
        return
      }

      // 被全屏遮罩盖着的页面默认不播（登录墙/密码框），也不记账：等真正解锁后
      // 再访问时会正常播一次。用户可以在设置里把「遮罩页面也播」打开。
      const allowVeiled = tuning.playOnVeiled ?? config?.swarm?.playOnVeiled ?? false
      if (!allowVeiled && (await hasBlockingVeil(page))) {
        await dropCurtain(page)
        return
      }

      const speed = clamp(tuning.speed ?? config?.swarm?.speed, 1, 3, 3)
      const rawMax = tuning.maxMs ?? config?.swarm?.maxMs
      // 0 = 完整播完：给一个很宽的上限，仍然留一条兜底，免得哪天真卡住。
      const maxMs = rawMax === 0 ? 120000 : clamp(rawMax, 3000, 30000, 15000)
      // 播放范围：默认只画首屏；选「整页」时由 playSwarm 一屏一屏滚着画。
      const range = (tuning.range ?? config?.swarm?.range) === 'page' ? 'page' : 'viewport'

      await playSwarm(page, {
        maxMs,
        speedClicks: speed - 1,
        // 「AI 工作时」：auto-close（默认）= 动作前让路；keep-alive = 动画继续但不挡点击。
        keepAlive: tuning.whileAiWorks === 'keep-alive',
        // 记账交给 playSwarm：注入成功之后才写，失败不占名额。
        markHost: oncePerSite ? host : '',
        range,
      })
    } catch {
      // 任何意外都不能影响导航本身。
    }
  })()
}
