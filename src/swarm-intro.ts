/**
 * 进场特效：把一个页面「抹白再用光标群重新画出来」。
 *
 * 这不是扩展。效果本体是 assets/swarm-rebuild.js，由 Playwright 直接注入当前
 * 页面执行，所以它跑在插件自己那个窗口里 —— 也就是用户已经登录的那个浏览器。
 *
 * **授权状态（发布前必须处理）**：那份脚本来自 Dhvanil Patel 的
 * github.com/DhvanilPatel/swarm-cursors，仓库当前**没有许可证**，README 明确
 * 写着「尚未授权，重用代码前请先问 Joel Califa」。底层的动效设计与编排又来自
 * Joel Califa 的 califa/swarm-site（同样没有许可证）。两人都点头之前，这个
 * 功能只能自己用，不能随公开版本分发。
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

/** 播过的域名，记在这里。删掉文件 = 每个网站都可以再播一次。 */
function playedFile(): string {
  // 测试可以指到临时文件，不去碰真实用户状态
  const override = process.env.DSH_BROWSER_SWARM_FILE
  if (override !== undefined && override !== '') return override
  return path.join(os.homedir(), '.dsh', 'dsh-browser-swarm.json')
}

function readPlayed(): Record<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(playedFile(), 'utf8')) as { hosts?: Record<string, unknown> } | null
    const hosts = parsed?.hosts
    if (hosts === undefined || hosts === null || typeof hosts !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [host, at] of Object.entries(hosts)) {
      if (typeof at === 'number') out[host] = at
    }
    return out
  } catch {
    return {}
  }
}

/** 这个域名播过没有。 */
export function hasPlayed(host: string): boolean {
  return typeof readPlayed()[host] === 'number'
}

/** 记下这个域名已经播过（立刻写盘：页面随时可能被关掉）。 */
export function markPlayed(host: string): void {
  try {
    const hosts = readPlayed()
    hosts[host] = Date.now()
    const target = playedFile()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const tmp = target + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ hosts }, null, 2))
    fs.renameSync(tmp, target)
  } catch {
    // 写不进去不影响播放，只是下次还会再播一遍。
  }
}

/** 清空播放记录（设置卡上的「清空记录」用）。 */
export function resetPlayed(): void {
  try {
    fs.rmSync(playedFile(), { force: true })
  } catch {
    /* 已经不存在 */
  }
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
  if (PLAY_MODES.get(page) === 'keep-alive') return
  PLAYING.delete(page)
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
}

/** 找到效果挂上去的 shadow root（原版脚本用 mode: 'open' 建的那个）。 */
const FIND_ROOT = `
  const findRoot = () => {
    const a = window.__swarmRebuild && window.__swarmRebuild.app
    if (a && a.view && a.view.root) return a.view.root
    if (a && a.root) return a.root
    for (const el of document.body.children) {
      if (el.shadowRoot && el.shadowRoot.querySelector('.hud')) return el.shadowRoot
    }
    // 兜底：宿主不一定是 body 的直接子节点，整页扫一遍（只在没拿到 app 时走）。
    for (const el of document.querySelectorAll('*')) {
      const sr = el.shadowRoot
      if (sr && sr.querySelector('.hud')) return sr
    }
    return null
  }
`

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
    const startScroll = await page.evaluate(() => window.scrollY).catch(() => 0)
    await page.evaluate(code)
    // 记账挪到"界面也藏好了"之后再写：注入成功但藏控制条十二次全失败时，
    // 名额不该被占掉（否则这个站以后再也不会重试）。

    // 原版脚本自带一条底部控制条（速度 / Tour / Go live / ✕）。自动播放时它
    // 只是噪音：藏掉，把速度调到最快、打开自动滚动，并留下一个"立刻退出"的
    // 入口给 stopSwarm 用。
    //
    // 这一步必须重试：脚本是异步建界面的，注入刚返回时影子节点可能还没挂上，
    // 一次没找到就永远留着那条控制条（2026-11-08 实测到过）。
    for (let attempt = 0; attempt < 12; attempt++) {
      const ready = await page.evaluate(
        ({ findRootSource, clicks, keepAlive }: { findRootSource: string; clicks: number; keepAlive: boolean }) => {
          const findRoot = new Function(`${findRootSource}; return findRoot`)() as () => ShadowRoot | null
          const root = findRoot()
          if (root === null) return false
          const hud = root.querySelector('.hud') as HTMLElement | null
          if (hud !== null) hud.style.display = 'none'
          // 「动画继续跑」模式：必须对宿主元素下手。宿主自带内联的
          // pointer-events:auto !important，影子树里再写规则也压不过它 —— 同一元素上
          // 后写的 !important 才能覆盖（2026-11-08 实测：改之前点击 4 秒超时）。
          if (keepAlive) (root.host as HTMLElement).style.setProperty('pointer-events', 'none', 'important')
          const speed = root.querySelector('[data-a="speed"]') as HTMLElement | null
          for (let i = 0; i < clicks; i++) speed?.click()
          ;(root.querySelector('[data-a="tour"]') as HTMLElement | null)?.click()
          ;(window as unknown as { __dshSwarmStop?: () => void }).__dshSwarmStop = () => {
            const again = findRoot()
            const button = again?.querySelector('[data-a="live"]') ?? again?.querySelector('[data-a="close"]')
            ;(button as HTMLElement | null)?.click()
          }
          return true
        },
        { findRootSource: FIND_ROOT, clicks: options.speedClicks, keepAlive: options.keepAlive === true },
      )
      if (ready) break
      await new Promise((resolve) => setTimeout(resolve, 160))
    }
    // 注入成功、控制条也藏好了，这才算真的"播过了"。
    if (options.markHost !== undefined && options.markHost !== '') markPlayed(options.markHost)

    const deadline = Date.now() + options.maxMs
    let reachedEnd = false
    while (Date.now() < deadline) {
      if (page.isClosed()) return
      const state = await page.evaluate(() => {
        const app = (window as unknown as { __swarmRebuild?: { app?: { complete?: boolean } } }).__swarmRebuild?.app
        if (app === undefined) return 'gone'
        return app.complete === true ? 'complete' : 'playing'
      })
      if (state === 'gone') return
      if (state === 'complete') {
        reachedEnd = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 350))
    }

    // 播完了，停一下让人看清最后成形的样子，然后退回真实页面；
    // 超时没播完也照样退，别让页面一直动下去。
    if (reachedEnd) await new Promise((resolve) => setTimeout(resolve, 1200))
    PLAYING.delete(page)
    try {
      await page.evaluate(() => {
        const stop = (window as unknown as { __dshSwarmStop?: () => void }).__dshSwarmStop
        if (typeof stop === 'function') stop()
      })
    } catch {
      /* 页面已经走了 */
    }

    // 停稳之后把人送回播放前的位置（导航打开新页面时就是顶部），
    // 这样播完看到的是网页开头，而不是被自动滚动带走的中段。
    // 停稳之后再回滚：资产从开始淡出到 host.remove() 要 1.2 秒左右，等它整块
    // 消失再滚，才不会"滚了但动画还在动"。最多等 2.4 秒，等不到就算了。
    for (let i = 0; i < 12; i++) {
      try {
        if (await page.evaluate(() => document.querySelector('swarm-rebuild') === null)) break
      } catch {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    try {
      await page.evaluate((y: number) => window.scrollTo(0, y), startScroll)
    } catch {
      /* 页面关掉了 */
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

/** 导航之后调用：够条件就播一次，不等它播完（导航照常立刻返回快照）。 */
export function maybePlaySwarm(
  page: Page,
  config:
    | { swarm?: { enabled?: boolean; oncePerSite?: boolean; speed?: number; maxMs?: number; playOnVeiled?: boolean } }
    | undefined,
  headless?: boolean,
): void {
  void (async () => {
    try {
      // 无头浏览器没人看着：不播。测试和无头任务都跑在这里，播了只会挡住点击。
      if (headless === true) return
      const url = page.url()
      if (!/^https?:/i.test(url)) return // about:blank、chrome:// 这类页面没有意义
      const host = new URL(url).hostname
      if (host === '') return

      // 用户的开关优先；没表态就用配置里的默认值（出厂是开）。
      const userChoice = runtimeState.getSwarm()
      const enabled = userChoice ?? config?.swarm?.enabled ?? true
      if (!enabled) return

      // 设置卡上的三行参数优先，没有就落到配置默认值。
      const tuning = runtimeState.getSwarmTuning()
      const oncePerSite = tuning.oncePerSite ?? config?.swarm?.oncePerSite ?? true
      if (oncePerSite && hasPlayed(host)) return

      // 被全屏遮罩盖着的页面默认不播（登录墙/密码框），也不记账：等真正解锁后
      // 再访问时会正常播一次。用户可以在设置里把「遮罩页面也播」打开。
      const allowVeiled = tuning.playOnVeiled ?? config?.swarm?.playOnVeiled ?? false
      if (!allowVeiled && (await hasBlockingVeil(page))) return

      const speed = clamp(tuning.speed ?? config?.swarm?.speed, 1, 3, 3)
      const rawMax = tuning.maxMs ?? config?.swarm?.maxMs
      // 0 = 完整播完：给一个很宽的上限，仍然留一条兜底，免得哪天真卡住。
      const maxMs = rawMax === 0 ? 120000 : clamp(rawMax, 3000, 30000, 15000)

      await playSwarm(page, {
        maxMs,
        speedClicks: speed - 1,
        // 「AI 工作时」：auto-close（默认）= 动作前让路；keep-alive = 动画继续但不挡点击。
        keepAlive: tuning.whileAiWorks === 'keep-alive',
        // 记账交给 playSwarm：注入成功之后才写，失败不占名额。
        markHost: oncePerSite ? host : '',
      })
    } catch {
      // 任何意外都不能影响导航本身。
    }
  })()
}
