/**
 * Playwright provider for the browser capability: owns the browser binary,
 * one context per owner key, idle disposal, and the snapshot engine.
 * @module dsh-browser-playwright-codex/playwright
 */
import { PlaywrightProvider } from './provider.ts'
import { diffEntry, flagsDeltaOf, flagsOf, resolveSnapshotEngine, type RefSignature } from './page-snapshot.ts'
import { hoverNote, withAbort } from './page-actions.ts'
import { asTimeoutError, isAbortError, isContextDestroyed, isCrashError } from './page-diagnostics.ts'
import { AUTO_CHANNELS, HUMANIZED_LAUNCH, REF_PATTERN, type PageData, type PlaywrightConfig } from './config.ts'
import { assertAllowedUrl } from './url-policy.ts'
import { createBackgroundPage, isWindowMinimized } from './browser-lifecycle.ts'
import type { Context } from '@deepseek-ai/cordis'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Dialog,
  type Locator,
  type Page,
  type Request,
} from 'playwright-core'
import z from '@deepseek-ai/schemastery'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { BrowserError, launchFailed } from './errors.ts'
import { SNAPSHOT_SCRIPT, type SnapshotOptions } from './injected.ts'
import { captureAriaSnapshot } from './snapshot-aria.ts'
import { clearLabelTargets, elementStabilityProbe, labelTargetProbe, pageStabilityProbe } from './page-probes.ts'
import {
  getEnabled,
  getSnapshotEngine,
  publishConfiguredEngine,
  subscribe as subscribeEnabled,
} from './runtime-state.ts'
// Type-only: makes the ctx.browser declaration merge visible to this module.
import type {} from './service.ts'
import type {
  BrowserNode,
  BrowserProvider,
  BrowserSession,
  BrowserSnapshot,
  DiagnosticsEntry,
  DiagnosticsValue,
  LoadState,
  ScreenshotCapture,
  SnapshotDiff,
  SnapshotDiffEntry,
  TabInfo,
} from './types.ts'
/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-playwright'
/** The browser runtime this provider registers into. */
export const inject = ['browser']

/**
 * Register this provider on the browser runtime for the plugin's lifetime.
 * @param ctx - plugin context carrying the browser runtime.
 * @param config - launch and fleet configuration.
 */
export function apply(ctx: Context, config: PlaywrightConfig) {
  const provider = new PlaywrightProvider(config)
  ctx.browser.registerProvider(provider)
  // Runtime on/off switch: when disabled the UI (or a future hot reload)
  // flips the flag and the provider tears down every active window so the
  // user does not keep seeing a phantom browser on their desktop.
  subscribeEnabled((enabled) => {
    if (enabled) return
    void provider.dispose()
  })
}
