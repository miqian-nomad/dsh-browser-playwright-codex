/**
 * Registration entry for the browser capability. cordis.patch.yml points its loader row at
 * \`<pkg>/playwright\`, so this is the module Cordis loads: it must keep exporting \`Config\` (the
 * schemastery schema for the plugin's config — without it Cordis cannot fill in defaults),
 * \`name\`/\`inject\`, and \`apply\`, plus the pre-split public surface re-exported below.
 *
 * The implementation lives in sibling modules, one per responsibility:
 *   provider.ts            profile/context lifecycle, session registry, idle disposal
 *   session.ts             one session's interactions
 *   page-actions.ts        click / fill / press / hover / scroll / history / tabs
 *   page-snapshot.ts       capture, ref signatures, ref lookup
 *   page-diagnostics.ts    console messages, page errors, network records
 *   browser-lifecycle.ts   launching/reusing the persistent context, window state
 *   login-state.ts         exporting and restoring login state
 * @module dsh-browser-playwright-codex/playwright
 */
import { PlaywrightProvider } from "./provider.js";
import {} from "./config.js";
import { subscribe as subscribeEnabled } from "./runtime-state.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-playwright';
/** The browser runtime this provider registers into. */
export const inject = ['browser'];
/**
 * Register this provider on the browser runtime for the plugin's lifetime.
 * @param ctx - plugin context carrying the browser runtime.
 * @param config - launch and fleet configuration.
 */
// The loader row in cordis.patch.yml points at <pkg>/playwright, so this entry must keep
// exporting the config schema: without `Config`, Cordis cannot fill in defaults and the
// provider reads `config.snapshot.engine` off an un-defaulted object (regression 2026-10-06,
// introduced when the code was split into modules — the schema moved to config.ts and the
// subpath stopped re-exporting it). The other names keep the pre-split public surface intact.
export { Config } from "./config.js";
export { PlaywrightProvider } from "./provider.js";
export { assertAllowedUrl } from "./url-policy.js";
export { resolveSnapshotEngine } from "./page-snapshot.js";
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
