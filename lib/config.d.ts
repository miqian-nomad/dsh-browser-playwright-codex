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
