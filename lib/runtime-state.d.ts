/**
 * Shared user settings for dsh-browser-playwright-codex, used by the three host
 * entries (browser / browser-playwright / browser-tool) and by the settings-page
 * switches in dsh-browser-toggle.
 *
 * Two settings, both user-facing:
 *   - `enabled` (default true)  — are the browser tools available at all.
 *   - `engine`  (default: unset) — how a page is read into the snapshot tree.
 *       'legacy' = the plugin's own DOM walk (most tested).
 *       'aria'   = the browser's official accessibility tree (what a screen
 *                  reader sees), usually more faithful on complex pages.
 *     Unset means "follow the configured default", which is 'legacy'.
 *
 * State persists to ~/.dsh/dsh-browser-playwright.state.json so both settings
 * survive a DSH restart. The FILE name deliberately keeps the pre-rename
 * spelling: it is persisted user state, and renaming it would silently reset the
 * user's switches.
 *
 * The file is re-read on every call (no read-once caching), so a change made on
 * one side (web or desktop) is visible to the other immediately, and flipping a
 * switch needs no restart and no config edit.
 *
 * `DSH_BROWSER_STATE_FILE` redirects the file; tests use it so they never touch
 * real user state.
 * @module dsh-browser-playwright-codex/runtime-state
 */
import type { LoginSites } from './login-sites.ts';
/** How a page is read into a snapshot tree. */
export type SnapshotEngine = 'legacy' | 'aria';
/** 进场特效的播放参数（速度/时长/是否只播一次），只存用户改过的项。 */
export interface SwarmTuning {
    speed?: number;
    maxMs?: number;
    oncePerSite?: boolean;
    /** 遮罩页面（登录墙、密码框）也播。默认关：会把没解锁的内容画出来。 */
    playOnVeiled?: boolean;
    /** AI 要动手时怎么办：'auto-close' = 立刻关掉动画（默认）；'keep-alive' = 动画继续但不挡点击。 */
    whileAiWorks?: 'auto-close' | 'keep-alive';
    /** 播放范围：只画首屏 / 整页（由插件接管滚动，一屏一屏画完）。 */
    range?: 'viewport' | 'page';
    /** 一直记住播过哪些站：关掉整个浏览器窗口也不重播。默认关（关窗就重播）。 */
    persistPlayed?: boolean;
}
/** Current enable state (loads from disk on first call). */
export declare function getEnabled(): boolean;
/** Set the enable state. Returns true if the value actually changed. */
export declare function setEnabled(next: boolean): boolean;
/** Subscribe to enable-state transitions. Returns an unsubscribe function. */
export declare function subscribe(fn: (enabled: boolean) => void): () => void;
/**
 * The window mode the user picked (true = headless), or undefined when they
 * never picked one — the configured default then applies.
 */
export declare function getHeadless(): boolean | undefined;
/** Persist the window-mode choice. Returns true when the value changed. */
export declare function setHeadless(next: boolean): boolean;
/**
 * 进场特效的开关：用户自己选过的值，没选过返回 undefined（由配置默认值说话）。
 */
export declare function getSwarm(): boolean | undefined;
/** 记下用户对进场特效的选择。Returns true when the value changed. */
export declare function setSwarm(next: boolean): boolean;
/** 用户自己选过吗？（设置卡用来区分「你选的」和「默认的」。） */
export declare function isSwarmUserChosen(): boolean;
/** 播放参数：只含用户改过的项，其余跟配置默认值。 */
export declare function getSwarmTuning(): SwarmTuning;
/** 改播放参数（只传要改的项）。Returns true when something changed. */
export declare function setSwarmTuning(patch: SwarmTuning): boolean;
/** Publish the configured default (launch.headless) for display. */
export declare function publishConfiguredHeadless(value: boolean): void;
/** The configured default, when the provider has published it. */
export declare function getConfiguredHeadless(): boolean | undefined;
/**
 * Effective window mode: the user's choice, else the configured default, else
 * the shipped default (headful).
 *
 * @param configuredFallback - config default when the provider has not published one
 */
export declare function getEffectiveHeadless(configuredFallback?: boolean): boolean;
/** Did the user pick the window mode themselves? (The card shows "你选的".) */
export declare function isHeadlessUserChosen(): boolean;
/**
 * The page-reading mode the user picked, or undefined when they never picked
 * one — the configured default then applies.
 */
export declare function getSnapshotEngine(): SnapshotEngine | undefined;
/** Pick the page-reading mode. Returns true if the value actually changed. */
export declare function setSnapshotEngine(next: SnapshotEngine): boolean;
/**
 * Report the mode this deployment was configured with, so the settings page can
 * display what is actually in effect instead of guessing. Called by the provider
 * when it is constructed; not persisted (it comes from config).
 * @param engine - the configured default mode.
 */
export declare function publishConfiguredEngine(engine: SnapshotEngine): void;
/**
 * What a capture will use right now: the user's pick, else the configured
 * default, else 'legacy'. This is what the settings page shows.
 */
export declare function getEffectiveEngine(): SnapshotEngine;
/** Whether the current mode is the user's own pick rather than the default. */
export declare function isEngineUserChosen(): boolean;
/**
 * The tool family's effective gates, published at registration. The Settings page
 * needs to show what is actually in effect — including whatever a profile patch
 * or a home-level patch decided — instead of guessing at the package default.
 * Not persisted: it is derived from config every time the plugin is applied.
 * @param gates - whether browser_evaluate / browser_cdp are registered.
 */
export declare function publishGates(gates: {
    allowEvaluate: boolean;
    allowCdp: boolean;
    diagnostics: boolean;
}): void;
/** The published gates, or undefined while the tool family has not been applied. */
export declare function getGates(): {
    allowEvaluate: boolean;
    allowCdp: boolean;
    diagnostics: boolean;
} | undefined;
/**
 * The last computed "which sites look logged in" summary, or undefined before anything
 * published one. In-memory only: it is derived from cookies, contains no cookie values or
 * names, and must never be persisted — the moment it lands on disk it is a dossier.
 * @param next - the summary to show on the settings card.
 */
export declare function publishLoginSites(next: LoginSites): void;
/**
 * The published login summary. The settings card reads this; no tool and no model can.
 * @returns a defensive copy, or undefined while nothing has been published.
 */
export declare function getLoginSites(): LoginSites | undefined;
