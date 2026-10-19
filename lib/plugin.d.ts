/**
 * The single loader entry: one package = one plugin (2026-10-19).
 *
 * Why this file exists: `dsh-client-modules` rejects distinct active Loader
 * sources that resolve to the same package name, and a Settings card needs a
 * client module. The browser capability used to be mounted as three rows
 * (`/service`, `/playwright`, `/tool`) because it has three configurable
 * concerns, which forced the card into a second package (dsh-browser-toggle).
 * One row per package makes the card legal inside this package, so the whole
 * product is now one plugin: this entry mounts the three concerns as child
 * plugins and keeps their own config schemas untouched.
 *
 * Config shape (see cordis.patch.yml):
 *
 *     service:    { provider }                     browser seam
 *     playwright: { launch, idleTimeoutMs, ... }   provider / window / snapshot
 *     tool:       { toolPrefix, allowEvaluate, ... } the model-facing tools
 *
 * Each child still exports its original schema and apply(), so the subpath
 * entries (`./service`, `./playwright`, `./tool`) keep working for tests, the
 * verify script and anyone importing the package directly.
 *
 * @module dsh-browser-playwright-codex/plugin
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type BrowserRuntimeConfig } from './service.ts';
import { type PlaywrightConfig } from './config.ts';
import { type ToolConfig } from './tool.ts';
/** Config accepted by the single loader row. */
export interface BrowserPluginConfig {
    /** Browser seam: which registered provider to use. */
    service?: BrowserRuntimeConfig;
    /** Provider: window, launch and snapshot settings. */
    playwright?: PlaywrightConfig;
    /** Model-facing tools: prefix, capability gates, wait caps. */
    tool?: ToolConfig;
}
/** Schemastery validation for {@link BrowserPluginConfig}. */
export declare const Config: z<BrowserPluginConfig>;
/** Cordis plugin name used by loader diagnostics (this is the row id in patches). */
export declare const name = "browser";
/**
 * Mount the whole capability: the seam, the Playwright provider, the tool family,
 * and — when the deployment has a web server — the Settings card.
 *
 * @param ctx - plugin context
 * @param config - nested config for each concern; the loader fills defaults
 */
export declare function apply(ctx: Context, config: BrowserPluginConfig): void;
declare const _default: {
    name: string;
    Config: z<BrowserPluginConfig>;
    apply: typeof apply;
};
export default _default;
