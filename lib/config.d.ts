/**
 * 插件配置与常量：schema、启动参数、通道白名单、ref 形态。
 * @module dsh-browser-playwright-codex/config
 */
import z from '@deepseek-ai/schemastery';
/** Schemastery validation for {@link PlaywrightConfig}. */
/** Launch configuration for the Playwright provider. */
export interface PlaywrightConfig {
    launch: {
        /** Absolute path to a Chromium-family binary; takes precedence over channel. */
        executablePath?: string;
        /** Browser channel: chromium, chrome, msedge. Omitted = auto-detect in that order. */
        channel?: string;
        /** Run headful so the user can watch and rescue the browser by hand. */
        headless: boolean;
        /** Persistent mode: one shared profile-backed window whose login survives. */
        persistent: boolean;
        /** Profile directory for persistent mode; empty means ~/.dsh/browser-profiles/playwright. */
        profileDir: string;
        viewport: {
            width: number;
            height: number;
        };
        /** Per-action navigation/click timeout in milliseconds. */
        navigationTimeoutMs: number;
        /** Ignore HTTPS certificate errors. */
        ignoreHTTPSErrors: boolean;
    };
    /** Host suffixes the browser may visit. Empty = any http(s) host. */
    allowedDomains?: string[];
    /** Close an idle session's browser context after this many milliseconds. 0 disables. */
    idleTimeoutMs: number;
    /** Maximum concurrent browser contexts; acquiring beyond it evicts the least recently used. */
    maxSessions: number;
    snapshot: {
        /** 'legacy' keeps the injected DOM walker; 'aria' uses the official ariaSnapshot(mode:'ai') engine. */
        engine: 'legacy' | 'aria';
        maxNodes: number;
        maxNameLength: number;
        maxTextLength: number;
        /** Incremental ref-diff mode; false = always full snapshots (zero behavioral change). */
        diff: boolean;
    };
    /**
     * 进场特效：把一个页面抹白，再用一群光标把它重新画出来。
     *
     * 可选：老配置对象里没有这一节时，由 Schemastery 的 Config 补齐默认值
     * （见下面的 `swarm: z.object(...).default(...)`）。做成可选是为了让手写的
     * 测试配置、以及旧部署的 patch 层都能直接通过类型检查。
     */
    swarm?: {
        /** 出厂默认关（0.8.0 起）：动效资产不再随 npm 包分发，打开了也读不到。把资产放回 assets/ 再开。 */
        enabled: boolean;
        /** 只在某个网站第一次打开时播；false = 每次导航都播（不建议）。 */
        oncePerSite: boolean;
        /** 播放速度档位 1–3（3 最快）。 */
        speed: number;
        /** 最多播多久（毫秒）。0 = 不限制，完整播完。 */
        maxMs: number;
        /** 遮罩页面（登录墙、密码框）也播。默认关：会把没解锁的内容画出来。 */
        playOnVeiled: boolean;
        /** 一直记住播过哪些站：关掉整个浏览器窗口也不重播。默认关（关窗就重播）。 */
        persistPlayed: boolean;
        /**
         * 播放范围：`viewport` = 只画当前这一屏（默认，1–10 秒结束）；
         * `page` = 由插件按节奏往下滚，一屏一屏把整页画完（会接管滚动，时间长得多）。
         */
        range: 'viewport' | 'page';
    };
}
/** Bounded page data the extraction consumer feeds to a model. */
export interface PageData {
    readonly url: string;
    readonly title: string;
    readonly text: string;
    readonly truncated: boolean;
    readonly links: readonly {
        readonly text: string;
        readonly href: string;
    }[];
    readonly inputs: readonly {
        readonly tag: string;
        readonly type: string;
        readonly name: string;
        readonly value: string;
        readonly label: string;
        readonly checked: boolean | null;
    }[];
}
/** Schemastery validation for {@link PlaywrightConfig}. */
export declare const Config: z<PlaywrightConfig>;
/** Channels probed in order when none is configured. */
export declare const AUTO_CHANNELS: string[];
/**
 * Launch flags that strip Playwright's obvious automation markers (anti-bot
 * detection layer L1). --enable-automation is what sets navigator.webdriver
 * and the "controlled by automated test software" infobar; dropping it plus
 * --disable-blink-features=AutomationControlled makes the browser present as
 * a plain real Chrome, which it is. No fingerprint spoofing is added: real
 * Chrome's own values are consistent by construction (spoofing would invent
 * a device that never existed and draw MORE suspicion).
 */
export declare const HUMANIZED_LAUNCH: {
    ignoreDefaultArgs: string[];
    args: string[];
};
export declare const REF_PATTERN: RegExp;
