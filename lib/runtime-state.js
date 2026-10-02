/**
 * Shared user settings for dsh-browser-playwright-codex, used by the three host
 * entries (browser / browser-playwright / browser-tool) and by the settings-page
 * switches in dsh-browser-toggle.
 *
 * Two settings, both user-facing:
 *   - `enabled` (default true)  — are the browser tools available at all.
 *   - `engine`  (default: unset) — how a page is read into the snapshot tree.
 *       'legacy' = the plugin's own DOM walk (most tested).
 *       'aria'   = the browser's official accessibility tree (what a screen
 *                  reader sees), usually more faithful on complex pages.
 *     Unset means "follow the configured default", which is 'legacy'.
 *
 * State persists to ~/.dsh/dsh-browser-playwright.state.json so both settings
 * survive a DSH restart. The FILE name deliberately keeps the pre-rename
 * spelling: it is persisted user state, and renaming it would silently reset the
 * user's switches.
 *
 * The file is re-read on every call (no read-once caching), so a change made on
 * one side (web or desktop) is visible to the other immediately, and flipping a
 * switch needs no restart and no config edit.
 *
 * `DSH_BROWSER_STATE_FILE` redirects the file; tests use it so they never touch
 * real user state.
 * @module dsh-browser-playwright-codex/runtime-state
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Shared layer: the web and desktop sides read the same switch file, so one
// agent can never see two different states depending on which side is open.
const STATE_DIR = path.join(os.homedir(), '.dsh');
const DEFAULT_STATE_FILE = path.join(STATE_DIR, 'dsh-browser-playwright.state.json');
/** The state file in use, resolved per call so tests can redirect it. */
function stateFile() {
    const override = process.env.DSH_BROWSER_STATE_FILE;
    return override !== undefined && override !== '' ? override : DEFAULT_STATE_FILE;
}
let _enabled = true;
let _engine = undefined;
/** Default pushed in by the provider that is actually loaded (display only). */
let _configuredEngine = undefined;
/** Effective tool gates, pushed in by the tool family when it is applied (display only). */
let _gates = undefined;
const _subscribers = new Set();
function load() {
    // Re-read the file on every call: whichever side flips the switch, the
    // other side follows immediately (no read-once caching).
    const previous = _enabled;
    try {
        const txt = fs.readFileSync(stateFile(), 'utf8');
        const obj = JSON.parse(txt);
        if (obj !== null && typeof obj === 'object') {
            if (typeof obj.enabled === 'boolean')
                _enabled = obj.enabled;
            // The file is authoritative for the page-reading mode: an absent or
            // unknown value means "follow the configured default" (undefined here).
            // Files written before this setting existed therefore stay valid.
            _engine = obj.engine === 'legacy' || obj.engine === 'aria' ? obj.engine : undefined;
        }
    }
    catch {
        // Missing file / parse error / unreadable: keep the current values.
    }
    if (_enabled !== previous) {
        for (const fn of [..._subscribers]) {
            try {
                fn(_enabled);
            }
            catch {
                // One subscriber failing must not affect the others.
            }
        }
    }
}
function persist() {
    try {
        const target = stateFile();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Atomic write: rename(2) is atomic on the same filesystem, so a crash
        // mid-write leaves either the old file or the new file, never half of
        // both.
        const tmp = target + '.tmp';
        // Keep the historical shape until the user actually picks a page-reading
        // mode: an absent `engine` means "use the configured default".
        const payload = _engine === undefined ? { enabled: _enabled } : { enabled: _enabled, engine: _engine };
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
        fs.renameSync(tmp, target);
    }
    catch {
        // Persist failure must not break the in-memory switches; the next set
        // will retry.
    }
}
/** Current enable state (loads from disk on first call). */
export function getEnabled() {
    load();
    return _enabled;
}
/** Set the enable state. Returns true if the value actually changed. */
export function setEnabled(next) {
    load();
    if (typeof next !== 'boolean')
        return false;
    if (_enabled === next)
        return false;
    _enabled = next;
    persist();
    for (const fn of [..._subscribers]) {
        try {
            fn(next);
        }
        catch {
            // One subscriber failing must not prevent others from reacting.
        }
    }
    return true;
}
/** Subscribe to enable-state transitions. Returns an unsubscribe function. */
export function subscribe(fn) {
    _subscribers.add(fn);
    return () => {
        _subscribers.delete(fn);
    };
}
/**
 * The page-reading mode the user picked, or undefined when they never picked
 * one — the configured default then applies.
 */
export function getSnapshotEngine() {
    load();
    return _engine;
}
/** Pick the page-reading mode. Returns true if the value actually changed. */
export function setSnapshotEngine(next) {
    load();
    if (next !== 'legacy' && next !== 'aria')
        return false;
    if (_engine === next)
        return false;
    _engine = next;
    persist();
    return true;
}
/**
 * Report the mode this deployment was configured with, so the settings page can
 * display what is actually in effect instead of guessing. Called by the provider
 * when it is constructed; not persisted (it comes from config).
 * @param engine - the configured default mode.
 */
export function publishConfiguredEngine(engine) {
    if (engine === 'legacy' || engine === 'aria')
        _configuredEngine = engine;
}
/**
 * What a capture will use right now: the user's pick, else the configured
 * default, else 'legacy'. This is what the settings page shows.
 */
export function getEffectiveEngine() {
    load();
    return _engine ?? _configuredEngine ?? 'legacy';
}
/** Whether the current mode is the user's own pick rather than the default. */
export function isEngineUserChosen() {
    load();
    return _engine !== undefined;
}
/**
 * The tool family's effective gates, published at registration. The Settings page
 * needs to show what is actually in effect — including whatever a profile patch
 * or a home-level patch decided — instead of guessing at the package default.
 * Not persisted: it is derived from config every time the plugin is applied.
 * @param gates - whether browser_evaluate / browser_cdp are registered.
 */
export function publishGates(gates) {
    _gates = { allowEvaluate: gates.allowEvaluate === true, allowCdp: gates.allowCdp === true };
}
/** The published gates, or undefined while the tool family has not been applied. */
export function getGates() {
    return _gates === undefined ? undefined : { ..._gates };
}
