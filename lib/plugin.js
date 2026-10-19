import z from '@deepseek-ai/schemastery';
import BrowserRuntime, { Config as ServiceConfig } from "./service.js";
import * as playwright from "./playwright.js";
import * as tool from "./tool.js";
import * as settingsCard from "./settings-card.js";
import { Config as PlaywrightConfigSchema } from "./config.js";
import { Config as ToolConfigSchema } from "./tool.js";
/** Schemastery validation for {@link BrowserPluginConfig}. */
export const Config = z.object({
    service: ServiceConfig,
    playwright: PlaywrightConfigSchema,
    tool: ToolConfigSchema,
});
/** Cordis plugin name used by loader diagnostics (this is the row id in patches). */
export const name = 'browser';
/**
 * Mount the whole capability: the seam, the Playwright provider, the tool family,
 * and — when the deployment has a web server — the Settings card.
 *
 * @param ctx - plugin context
 * @param config - nested config for each concern; the loader fills defaults
 */
export function apply(ctx, config) {
    ctx.plugin(BrowserRuntime, config.service ?? {});
    ctx.plugin(playwright, config.playwright);
    ctx.plugin(tool, config.tool);
    // The card's host half injects `webServer`, so in a CLI deployment this child
    // simply stays pending instead of failing the whole plugin.
    ctx.plugin(settingsCard);
}
export default { name, Config, apply };
