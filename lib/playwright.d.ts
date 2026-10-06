import { type PlaywrightConfig } from './config.ts';
import type { Context } from '@deepseek-ai/cordis';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "browser-playwright";
/** The browser runtime this provider registers into. */
export declare const inject: string[];
/**
 * Register this provider on the browser runtime for the plugin's lifetime.
 * @param ctx - plugin context carrying the browser runtime.
 * @param config - launch and fleet configuration.
 */
export { Config, type PageData, type PlaywrightConfig } from './config.ts';
export { PlaywrightProvider } from './provider.ts';
export { assertAllowedUrl } from './url-policy.ts';
export { resolveSnapshotEngine } from './page-snapshot.ts';
export declare function apply(ctx: Context, config: PlaywrightConfig): void;
