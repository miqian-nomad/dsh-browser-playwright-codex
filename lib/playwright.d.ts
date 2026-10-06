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
export declare function apply(ctx: Context, config: PlaywrightConfig): void;
