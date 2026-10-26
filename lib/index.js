/**
 * dsh-browser-playwright-codex: Playwright-powered browser capability for
 * DeepSeek Harness. Snapshot-first interaction with stable element refs,
 * session-scoped browser contexts, screenshots as attachments.
 * @module dsh-browser-playwright-codex
 */
export { BrowserError, cdpDisabled, evaluateDisabled, launchFailed } from "./errors.js";
export { ALWAYS_ON_SUFFIXES, ERROR_CODES, GATED_SUFFIXES, TOOL_SUFFIXES, registeredSuffixes, registeredToolNames, toolNames, } from "./contract.js";
export { CallId, toolCallId } from "./compat.js";
export { SNAPSHOT_SCRIPT } from "./injected.js";
export { default as BrowserRuntime } from "./service.js";
export { PlaywrightProvider } from "./provider.js";
export { assertAllowedUrl, isHostAllowed } from "./url-policy.js";
export { installHostGuard } from "./navigation-guard.js";
export { Config as PlaywrightConfigSchema } from "./config.js";
// Single loader row (2026-10-19): the package root is the plugin. The three
// sub-entries below stay importable, but the loader mounts this one.
export { Config as BrowserPluginConfigSchema, apply, name } from "./plugin.js";
export { apply as applyPlaywright, name as playwrightEntry, Config as PlaywrightEntryConfig } from "./playwright.js";
export { apply as applyTools, name as toolEntry, Config as ToolEntryConfig } from "./tool.js";
export { Config } from "./plugin.js";
