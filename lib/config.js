/**
 * 插件配置与常量：schema、启动参数、通道白名单、ref 形态。
 * @module dsh-browser-playwright-codex/config
 */
import z from '@deepseek-ai/schemastery';
/** Schemastery validation for {@link PlaywrightConfig}. */
export const Config = z.object({
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
        navigationTimeoutMs: z.number().default(30000),
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
        // 出厂开：不装扩展、不改配置，第一次打开一个网站就能看见这个效果。
        enabled: z.boolean().default(true),
        // 只在每个网站第一次打开时播，避免每次导航都把页面盖住。
        oncePerSite: z.boolean().default(true),
        // 1–3 档，脚本里对应点几次速度按钮。
        speed: z.number().default(3),
        // 硬上限：到点无条件退回真实页面。原版脚本在长页面上要约 12 秒，留 15 秒。
        maxMs: z.number().default(15000),
        // 默认关：遮罩后面的内容没解锁就不该被画出来。自己的面板想看可以打开。
        playOnVeiled: z.boolean().default(false),
    })
        .default({ enabled: true, oncePerSite: true, speed: 3, maxMs: 15000, playOnVeiled: false }),
});
/** Channels probed in order when none is configured. */
export const AUTO_CHANNELS = ['chromium', 'chrome', 'msedge', 'edge'];
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
};
export const REF_PATTERN = /^e[0-9]+$/;
