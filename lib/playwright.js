/**
 * Playwright provider for the browser capability: owns the browser binary,
 * one context per owner key, idle disposal, and the snapshot engine.
 * @module dsh-browser-playwright-codex/playwright
 */
import { PlaywrightProvider } from "./provider.js";
import { diffEntry, flagsDeltaOf, flagsOf, resolveSnapshotEngine } from "./page-snapshot.js";
import { hoverNote, withAbort } from "./page-actions.js";
import { asTimeoutError, isAbortError, isContextDestroyed, isCrashError } from "./page-diagnostics.js";
import { AUTO_CHANNELS, HUMANIZED_LAUNCH, REF_PATTERN } from "./config.js";
import { assertAllowedUrl } from "./url-policy.js";
import { createBackgroundPage, isWindowMinimized } from "./browser-lifecycle.js";
import { chromium, } from 'playwright-core';
import z from '@deepseek-ai/schemastery';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { BrowserError, launchFailed } from "./errors.js";
import { SNAPSHOT_SCRIPT } from "./injected.js";
import { captureAriaSnapshot } from "./snapshot-aria.js";
import { clearLabelTargets, elementStabilityProbe, labelTargetProbe, pageStabilityProbe } from "./page-probes.js";
import { getEnabled, getSnapshotEngine, publishConfiguredEngine, subscribe as subscribeEnabled, } from "./runtime-state.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-playwright';
/** The browser runtime this provider registers into. */
export const inject = ['browser'];
/**
 * Register this provider on the browser runtime for the plugin's lifetime.
 * @param ctx - plugin context carrying the browser runtime.
 * @param config - launch and fleet configuration.
 */
export function apply(ctx, config) {
    const provider = new PlaywrightProvider(config);
    ctx.browser.registerProvider(provider);
    // Runtime on/off switch: when disabled the UI (or a future hot reload)
    // flips the flag and the provider tears down every active window so the
    // user does not keep seeing a phantom browser on their desktop.
    subscribeEnabled((enabled) => {
        if (enabled)
            return;
        void provider.dispose();
    });
}
