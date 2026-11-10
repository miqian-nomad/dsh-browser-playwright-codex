/**
 * 插件配置与常量：schema、启动参数、通道白名单、ref 形态。
 * @module dsh-browser-playwright-codex/config
 */
import z from '@deepseek-ai/schemastery'

/** Schemastery validation for {@link PlaywrightConfig}. */
/** Launch configuration for the Playwright provider. */
export interface PlaywrightConfig {
  launch: {
    /** Absolute path to a Chromium-family binary; takes precedence over channel. */
    executablePath?: string
    /** Browser channel: chromium, chrome, msedge. Omitted = auto-detect in that order. */
    channel?: string
    /** Run headful so the user can watch and rescue the browser by hand. */
    headless: boolean
    /** Persistent mode: one shared profile-backed window whose login survives. */
    persistent: boolean
    /** Profile directory for persistent mode; empty means ~/.dsh/browser-profiles/playwright. */
    profileDir: string
    viewport: { width: number; height: number }
    /** Per-action navigation/click timeout in milliseconds. */
    navigationTimeoutMs: number
    /** Ignore HTTPS certificate errors. */
    ignoreHTTPSErrors: boolean
  }
  /** Host suffixes the browser may visit. Empty = any http(s) host. */
  allowedDomains?: string[]
  /** Close an idle session's browser context after this many milliseconds. 0 disables. */
  idleTimeoutMs: number
  /** Maximum concurrent browser contexts; acquiring beyond it evicts the least recently used. */
  maxSessions: number
  snapshot: {
    /** 'legacy' keeps the injected DOM walker; 'aria' uses the official ariaSnapshot(mode:'ai') engine. */
    engine: 'legacy' | 'aria'
    maxNodes: number
    maxNameLength: number
    maxTextLength: number
    /** Incremental ref-diff mode; false = always full snapshots (zero behavioral change). */
    diff: boolean
  }
  /**
   * 进场特效：把一个页面抹白，再用一群光标把它重新画出来。
   *
   * 可选：老配置对象里没有这一节时，由 Schemastery 的 Config 补齐默认值
   * （见下面的 `swarm: z.object(...).default(...)`）。做成可选是为了让手写的
   * 测试配置、以及旧部署的 patch 层都能直接通过类型检查。
   */
  swarm?: {
    /** 出厂就开着：这是装完就能看见的那一下「哇」。设置卡上的开关可以随时关掉。 */
    enabled: boolean
    /** 只在某个网站第一次打开时播；false = 每次导航都播（不建议）。 */
    oncePerSite: boolean
    /** 播放速度档位 1–3（3 最快）。 */
    speed: number
    /** 最多播多久（毫秒）。0 = 不限制，完整播完。 */
    maxMs: number
    /** 遮罩页面（登录墙、密码框）也播。默认关：会把没解锁的内容画出来。 */
    playOnVeiled: boolean
    /** 一直记住播过哪些站：关掉整个浏览器窗口也不重播。默认关（关窗就重播）。 */
    persistPlayed: boolean
    /**
     * 播放范围：`viewport` = 只画当前这一屏（默认，1–10 秒结束）；
     * `page` = 由插件按节奏往下滚，一屏一屏把整页画完（会接管滚动，时间长得多）。
     */
    range: 'viewport' | 'page'
  }
}

/** Bounded page data the extraction consumer feeds to a model. */
export interface PageData {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly truncated: boolean
  readonly links: readonly { readonly text: string; readonly href: string }[]
  readonly inputs: readonly {
    readonly tag: string
    readonly type: string
    readonly name: string
    readonly value: string
    readonly label: string
    readonly checked: boolean | null
  }[]
}

/** Schemastery validation for {@link PlaywrightConfig}. */
export const Config: z<PlaywrightConfig> = z.object({
  launch: z.object({
    executablePath: z.string(),
    channel: z.string(),
    // Visible window by default: the agent drives a browser the user can
    // watch and rescue by hand (login, captcha, dialogs).
    headless: z.boolean().default(false),
    // Persistent context mode: one shared profile-backed window whose
    // login state survives close/reopen. false = legacy launch() mode.
    persistent: z.boolean().default(true),
    // Profile directory for persistent mode. Empty = ~/.dsh/browser-profiles/playwright.
    profileDir: z.string().default(''),
    // Headless only: a headful window must behave like a normal Chrome the
    // user opened by hand, so the fixed CSS viewport is ignored there (see
    // ensureContext) and the page tracks the real window size instead.
    viewport: z
      .object({ width: z.number().default(1280), height: z.number().default(800) })
      .default({ width: 1280, height: 800 }),
    // 0 used to be accepted, and Playwright reads timeout: 0 as "no timeout",
    // so a stuck page could hang the tool forever (issue #5). Require at least
    // one second; the default stays 30s.
    navigationTimeoutMs: z.number().min(1000).default(30000),
    ignoreHTTPSErrors: z.boolean().default(false),
  }),
  allowedDomains: z.array(z.string()),
  idleTimeoutMs: z.number().default(600000),
  maxSessions: z.number().default(8),
  snapshot: z
    .object({
      // 'legacy' keeps the injected DOM walker as the default: existing
      // tests, verify and every consumer see byte-identical snapshots until
      // a caller opts into the aria engine.
      engine: z.union([z.const('legacy'), z.const('aria')]).default('legacy'),
      maxNodes: z.number().default(500),
      maxNameLength: z.number().default(120),
      maxTextLength: z.number().default(300),
      // diff=false keeps every return path a full snapshot: zero behavioral
      // change unless a caller explicitly turns the incremental mode on.
      diff: z.boolean().default(false),
    })
    .default({ engine: 'legacy', maxNodes: 500, maxNameLength: 120, maxTextLength: 300, diff: false }),
  swarm: z
    .object({
      // 出厂关：动效资产不再随 npm 包分发（0.8.0 起），默认开会让每个新用户
      // 在"文件根本不存在"的状态下开箱报错。想要的人把资产放回 assets/ 再打开。
      enabled: z.boolean().default(false),
      // 只在每个网站第一次打开时播，避免每次导航都把页面盖住。
      oncePerSite: z.boolean().default(true),
      // 1–3 档，脚本里对应点几次速度按钮。
      speed: z.number().default(3),
      // 硬上限：到点无条件退回真实页面。原版脚本在长页面上要约 12 秒，留 15 秒。
      maxMs: z.number().default(15000),
      // 默认关：遮罩后面的内容没解锁就不该被画出来。自己的面板想看可以打开。
      playOnVeiled: z.boolean().default(false),
      // 默认关：整个浏览器窗口一关就忘掉这趟播过哪些站，下次重开全部重播。
      persistPlayed: z.boolean().default(false),
      // 只画首屏：长页面不动，短页面也不会卡在"下半页永远等不到"。想看整页的人
      // 到设置卡选「整页」——那会把滚动接过去几秒，所以不做默认。
      range: z.union([z.const('viewport'), z.const('page')]).default('viewport'),
    })
    .default({ enabled: false, oncePerSite: true, speed: 3, maxMs: 15000, playOnVeiled: false, persistPlayed: false }),
})

/** Channels probed in order when none is configured. */
export const AUTO_CHANNELS = ['chromium', 'chrome', 'msedge', 'edge']

/**
 * Launch flags that strip Playwright's obvious automation markers (anti-bot
 * detection layer L1). --enable-automation is what sets navigator.webdriver
 * and the "controlled by automated test software" infobar; dropping it plus
 * --disable-blink-features=AutomationControlled makes the browser present as
 * a plain real Chrome, which it is. No fingerprint spoofing is added: real
 * Chrome's own values are consistent by construction (spoofing would invent
 * a device that never existed and draw MORE suspicion).
 */
export const HUMANIZED_LAUNCH = {
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
}

export const REF_PATTERN = /^e[0-9]+$/
