import type { PlaywrightProvider } from './provider.ts';
/**
 * Ensure the shared persistent context is alive (persistent mode). A
 * profile-backed window is launched once and reused until closed by the
 * last owner, idle disposal, or an external close; login state lives in
 * the profile plus the exported state file, so reopening is seamless.
 *
 * Concurrent callers share ONE launch. Without this, two sessions waking up at
 * the same moment both saw "no context" and both called launchPersistentContext
 * on the same profile directory: the loser died on Chrome's profile singleton,
 * the recovery path deleted the running browser's lock files, and the caller was
 * told "install a Chromium-family browser" (measured 2026-10-26).
 */
export declare function ensureContext(provider: PlaywrightProvider): Promise<import("playwright-core").BrowserContext>;
/** Remove stale Chrome singleton lock files inside the profile directory. */
export declare function clearChromeLocks(provider: PlaywrightProvider): Promise<void>;
/**
 * Launch the browser once, probing the configured or auto-detected channel.
 *
 * Concurrent callers share one launch, for the same reason ensureContext does:
 * otherwise two sessions wake up, both see `browser === undefined`, and two
 * browsers are launched (the reported "两个任务同时唤醒会多开浏览器").
 */
export declare function ensureBrowser(provider: PlaywrightProvider): Promise<import("playwright-core").Browser>;
