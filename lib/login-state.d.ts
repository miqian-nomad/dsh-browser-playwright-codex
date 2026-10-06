import type { BrowserContext } from 'playwright-core';
import type { PlaywrightProvider } from './provider.ts';
/** Export the login-state fallback to the state file (session-cookie fallback). */
export declare function persistState(provider: PlaywrightProvider, context: BrowserContext): Promise<void>;
/**
 * Re-inject a previously exported state. Durable cookies already live in
 * the profile; this covers session cookies the browser drops on close and
 * localStorage entries, so logins survive window close/reopen.
 */
export declare function restoreState(provider: PlaywrightProvider, context: BrowserContext): Promise<void>;
