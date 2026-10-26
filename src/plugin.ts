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
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import BrowserRuntime, { Config as ServiceConfig, type BrowserRuntimeConfig } from './service.ts'
import * as playwright from './playwright.ts'
import * as tool from './tool.ts'
import * as settingsCard from './settings-card.ts'
import { Config as PlaywrightConfigSchema, type PlaywrightConfig } from './config.ts'
import { Config as ToolConfigSchema, type ToolConfig } from './tool.ts'
import { warnLegacyRows } from './legacy-config.ts'

/** Config accepted by the single loader row. */
export interface BrowserPluginConfig {
  /** Browser seam: which registered provider to use. */
  service?: BrowserRuntimeConfig
  /** Provider: window, launch and snapshot settings. */
  playwright?: PlaywrightConfig
  /** Model-facing tools: prefix, capability gates, wait caps. */
  tool?: ToolConfig
}

/** Schemastery validation for {@link BrowserPluginConfig}. */
export const Config: z<BrowserPluginConfig> = z.object({
  service: ServiceConfig,
  playwright: PlaywrightConfigSchema,
  tool: ToolConfigSchema,
})

/** Cordis plugin name used by loader diagnostics (this is the row id in patches). */
export const name = 'browser'

/**
 * Mount the whole capability: the seam, the Playwright provider, the tool family,
 * and — when the deployment has a web server — the Settings card.
 *
 * @param ctx - plugin context
 * @param config - nested config for each concern; the loader fills defaults
 */
export function apply(ctx: Context, config: BrowserPluginConfig): void {
  // 0.7.0 stopped reading the three legacy rows, and a stale row downgrades the
  // deployment to package defaults (both power gates off) without an error.
  // Advisory only: it reads the patch layers and never blocks the mount.
  void warnLegacyRows(ctx).catch(() => {})
  ctx.plugin(BrowserRuntime, config.service ?? {})
  ctx.plugin(playwright, config.playwright as PlaywrightConfig)
  ctx.plugin(tool, config.tool as ToolConfig)
  // The card's host half injects `webServer`, so in a CLI deployment this child
  // simply stays pending instead of failing the whole plugin.
  ctx.plugin(settingsCard)
}

export default { name, Config, apply }
