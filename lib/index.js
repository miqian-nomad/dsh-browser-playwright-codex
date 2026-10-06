/**
 * dsh-browser-playwright-codex: Playwright-powered browser capability for
 * DeepSeek Harness. Snapshot-first interaction with stable element refs,
 * session-scoped browser contexts, screenshots as attachments.
 * @module dsh-browser-playwright-codex
 */
export { BrowserError, launchFailed } from "./errors.js";
export { ALWAYS_ON_SUFFIXES, ERROR_CODES, GATED_SUFFIXES, TOOL_SUFFIXES, registeredSuffixes, registeredToolNames, toolNames, } from "./contract.js";
export { CallId, toolCallId } from "./compat.js";
export { SNAPSHOT_SCRIPT } from "./injected.js";
export { default as BrowserRuntime } from "./service.js";
export { PlaywrightProvider } from "./provider.js";
export { assertAllowedUrl } from "./url-policy.js";
export { Config as PlaywrightConfigSchema } from "./config.js";
