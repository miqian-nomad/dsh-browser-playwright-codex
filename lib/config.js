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
