/**
 * dsh-browser-playwright-codex: Playwright-powered browser capability for
 * DeepSeek Harness. Snapshot-first interaction with stable element refs,
 * session-scoped browser contexts, screenshots as attachments.
 * @module dsh-browser-playwright-codex
 */
export { BrowserError, cdpDisabled, evaluateDisabled, launchFailed } from './errors.ts';
export type { BrowserErrorCode } from './errors.ts';
export { ALWAYS_ON_SUFFIXES, ERROR_CODES, GATED_SUFFIXES, TOOL_SUFFIXES, registeredSuffixes, registeredToolNames, toolNames, } from './contract.ts';
export type { ToolSuffix, ToolSurfaceConfig } from './contract.ts';
export { CallId, toolCallId } from './compat.ts';
export type { ToolCallId } from './compat.ts';
export { SNAPSHOT_SCRIPT } from './injected.ts';
export type { SnapshotOptions, PageDataOptions } from './injected.ts';
export { default as BrowserRuntime } from './service.ts';
export type { BrowserRuntimeConfig } from './service.ts';
export { PlaywrightProvider } from './provider.ts';
export { assertAllowedUrl, isHostAllowed } from './url-policy.ts';
export { installHostGuard } from './navigation-guard.ts';
export type { BlockedRequest } from './navigation-guard.ts';
export { DEFAULT_WAIT_TIMEOUT_MS, describeWait, normalizeWaitCondition } from './wait-conditions.ts';
export { Config as PlaywrightConfigSchema } from './config.ts';
export type { PlaywrightConfig, PageData } from './config.ts';
export type { BrowserNode, BrowserProvider, BrowserSession, BrowserSnapshot, LoadState, ScreenshotCapture, TabInfo, WaitCondition, WaitOutcome, } from './types.ts';
export type { ToolConfig } from './tool.ts';
export { Config as BrowserPluginConfigSchema, apply, name } from './plugin.ts';
export type { BrowserPluginConfig } from './plugin.ts';
export { apply as applyPlaywright, name as playwrightEntry, Config as PlaywrightEntryConfig } from './playwright.ts';
export { apply as applyTools, name as toolEntry, Config as ToolEntryConfig } from './tool.ts';
export { Config } from './plugin.ts';
