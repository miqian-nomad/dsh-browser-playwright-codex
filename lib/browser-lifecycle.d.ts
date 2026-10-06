import type { PlaywrightProvider } from './provider.ts';
/**
 * Ensure the shared persistent context is alive (persistent mode). A
 * profile-backed window is launched once and reused until closed by the
 * last owner, idle disposal, or an external close; login state lives in
 * the profile plus the exported state file, so reopening is seamless.
 */
export declare function ensureContext(provider: PlaywrightProvider): Promise<import("playwright-core").BrowserContext>;
/** Remove stale Chrome singleton lock files inside the profile directory. */
export declare function clearChromeLocks(provider: PlaywrightProvider): Promise<void>;
/** Launch the browser once, probing the configured or auto-detected channel. */
export declare function ensureBrowser(provider: PlaywrightProvider): Promise<import("playwright-core").Browser>;
