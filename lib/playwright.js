import { chromium, } from 'playwright-core';
import z from '@deepseek-ai/schemastery';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { BrowserError, launchFailed } from "./errors.js";
import { SNAPSHOT_SCRIPT } from "./injected.js";
import { captureAriaSnapshot } from "./snapshot-aria.js";
import { getEnabled, getSnapshotEngine, publishConfiguredEngine, subscribe as subscribeEnabled, } from "./runtime-state.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-playwright';
/** The browser runtime this provider registers into. */
export const inject = ['browser'];
/** Schemastery validation for {@link PlaywrightConfig}. */
export const Config = z.object({
    launch: z.object({
        executablePath: z.string(),
        channel: z.string(),
        // Visible window by default: the agent drives a browser the user can
        // watch and rescue by hand (login, captcha, dialogs).
        headless: z.boolean().default(false),
        // Persistent context mode: one shared profile-backed window whose
        // login state survives close/reopen. false = legacy launch() mode.
        persistent: z.boolean().default(true),
        // Profile directory for persistent mode. Empty = ~/.dsh/browser-profiles/playwright.
        profileDir: z.string().default(''),
        // Headless only: a headful window must behave like a normal Chrome the
        // user opened by hand, so the fixed CSS viewport is ignored there (see
        // ensureContext) and the page tracks the real window size instead.
        viewport: z
            .object({ width: z.number().default(1280), height: z.number().default(800) })
            .default({ width: 1280, height: 800 }),
        navigationTimeoutMs: z.number().default(30000),
        ignoreHTTPSErrors: z.boolean().default(false),
    }),
    allowedDomains: z.array(z.string()),
    idleTimeoutMs: z.number().default(600000),
    maxSessions: z.number().default(8),
    snapshot: z
        .object({
        // 'legacy' keeps the injected DOM walker as the default: existing
        // tests, verify and every consumer see byte-identical snapshots until
        // a caller opts into the aria engine.
        engine: z.union([z.const('legacy'), z.const('aria')]).default('legacy'),
        maxNodes: z.number().default(500),
        maxNameLength: z.number().default(120),
        maxTextLength: z.number().default(300),
        // diff=false keeps every return path a full snapshot: zero behavioral
        // change unless a caller explicitly turns the incremental mode on.
        diff: z.boolean().default(false),
    })
        .default({ engine: 'legacy', maxNodes: 500, maxNameLength: 120, maxTextLength: 300, diff: false }),
});
/** Channels probed in order when none is configured. */
const AUTO_CHANNELS = ['chromium', 'chrome', 'msedge', 'edge'];
/**
 * Launch flags that strip Playwright's obvious automation markers (anti-bot
 * detection layer L1). --enable-automation is what sets navigator.webdriver
 * and the "controlled by automated test software" infobar; dropping it plus
 * --disable-blink-features=AutomationControlled makes the browser present as
 * a plain real Chrome, which it is. No fingerprint spoofing is added: real
 * Chrome's own values are consistent by construction (spoofing would invent
 * a device that never existed and draw MORE suspicion).
 */
const HUMANIZED_LAUNCH = {
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
};
const REF_PATTERN = /^e[0-9]+$/;
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
/** Validate one absolute URL against the navigation policy. */
export function assertAllowedUrl(raw, allowedDomains) {
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        throw new BrowserError('URL_NOT_ALLOWED', 'invalid URL: ' + raw);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new BrowserError('URL_NOT_ALLOWED', 'only http(s) URLs can be navigated, got: ' + parsed.protocol);
    }
    if (allowedDomains.length > 0) {
        const host = parsed.hostname.toLowerCase();
        const allowed = allowedDomains.some((suffix) => host === suffix || host.endsWith('.' + suffix));
        if (!allowed) {
            throw new BrowserError('URL_NOT_ALLOWED', 'host ' + parsed.hostname + ' is not in allowedDomains');
        }
    }
    return parsed;
}
/**
 * Which page-reading mode a capture uses. The user's choice on the settings page
 * (Settings → 浏览器 → 页面识别方式) wins over the deployment default, so flipping
 * that switch changes the very next operation — no restart, no config edit.
 * @param configured - the mode from this provider's config.
 * @returns the effective mode.
 */
export function resolveSnapshotEngine(configured) {
    return getSnapshotEngine() ?? configured;
}
/** Wrap a Playwright op so an aborted signal rejects while the op keeps draining in the background. */
async function withAbort(promise, signal) {
    // Attach handlers FIRST: the caller's promise may still be draining (a
    // dialog can keep it pending forever), and an abandoned rejection would
    // become an unhandledRejection and can take the host down.
    const guarded = Promise.resolve(promise);
    guarded.catch(() => { });
    // A malformed signal (not an AbortSignal) is treated as "no signal".
    if (signal === undefined || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean')
        return guarded;
    if (signal.aborted)
        throw new DOMException('The operation was aborted', 'AbortError');
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        guarded.then((value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (reason) => {
            signal.removeEventListener('abort', onAbort);
            reject(reason);
        });
    });
}
/**
 * True when the OS window hosting this page is minimized. Tab selection lives
 * in the browser context, not in the OS window, so activation is a side effect
 * we are free to decline — and declining it is what keeps the agent from
 * yanking a minimized window into the user's face. If the window state cannot
 * be read we answer true (treat as minimized): the safe direction is to leave
 * the user's desktop alone, and a skipped bringToFront costs nothing functional.
 */
async function isWindowMinimized(page) {
    let session;
    try {
        session = await page.context().newCDPSession(page);
        const { windowId } = await session.send('Browser.getWindowForTarget');
        const { bounds } = await session.send('Browser.getWindowBounds', { windowId });
        return bounds.windowState === 'minimized';
    }
    catch {
        return true;
    }
    finally {
        await session?.detach().catch(() => { });
    }
}
/**
 * Create a tab without raising the window. context.newPage() routes through CDP
 * Target.createTarget without `background`, and Chromium activates the window
 * on every tab creation -- plainly visible once the user has minimized it.
 * Sending the command ourselves with background:true creates the tab silently;
 * Playwright still auto-attaches and returns a fully driveable Page (verified
 * live: Playwright learns the page and evaluate() runs on it). The URL is left
 * at about:blank on purpose so the caller's own goto keeps owning navigation
 * policy, timeouts and abort handling. On any failure this falls back to
 * newPage(): a tab that pops the window beats no tab at all.
 */
async function createBackgroundPage(context) {
    const anchor = context.pages()[0];
    if (anchor === undefined)
        return await context.newPage();
    let session;
    try {
        session = await context.newCDPSession(anchor);
        // Arm the listener before sending: Playwright attaches as soon as the
        // target exists, which can happen before createTarget resolves.
        const attached = context.waitForEvent('page', { timeout: 10000 });
        await session.send('Target.createTarget', { url: 'about:blank', background: true });
        return await attached;
    }
    catch {
        return await context.newPage();
    }
    finally {
        await session?.detach().catch(() => { });
    }
}
export class PlaywrightProvider {
    config;
    id = 'playwright';
    /** Legacy (persistent:false) shared browser instance. */
    browser;
    /** Persistent-mode shared profile-backed context (the personal window). */
    context;
    entries = new Map();
    launchError;
    /** Resolved profile directory (persistent mode only). */
    profileDir = '';
    /**
     * Where cookies+localStorage are exported for the session-cookie fallback.
     * Undefined outside persistent mode, and that is load-bearing: every writer
     * and reader below guards on `undefined`, while an empty string would make
     * `'' + '.tmp'` land in the process working directory.
     */
    stateFile = undefined;
    /** Owner that raised the dialog currently parked on a page. */
    lastActor;
    lastStatePersist = 0;
    constructor(config) {
        this.config = config;
        // Tell the settings card which page-reading mode this deployment was
        // configured with, so it can show "当前：X（默认）" truthfully instead of
        // assuming the built-in default.
        publishConfiguredEngine(config.snapshot.engine);
        if (config.launch.persistent) {
            const dir = config.launch.profileDir !== undefined && config.launch.profileDir.trim() !== ''
                ? config.launch.profileDir
                : path.join(os.homedir(), '.dsh', 'browser-profiles', 'playwright');
            this.profileDir = dir;
            this.stateFile = path.join(dir, 'dsh-storage-state.json');
        }
    }
    available() {
        return true;
    }
    /** Pages already carrying the dialog guard (WeakSet: pages stay collectable). */
    armedDialogs = new WeakSet();
    /** Pending native dialog per page: { dialog, type, message }. Never auto-resolved. */
    pendingDialogs = new Map();
    /** Resolvers waiting for the next dialog on a page (the action/dialog race). */
    dialogWaits = new Map();
    /**
     * Make a page report native dialogs instead of having them silently
     * dismissed. The dialog is parked as a per-page pending state and left
     * untouched: the page stays blocked until browser_dialog answers it, and
     * whichever action raised it returns early through the dialog race.
     * See DIALOG-POLICY.md for why this shape beats any parameter-level check.
     */
    armDialogGuard(page) {
        if (this.armedDialogs.has(page))
            return;
        this.armedDialogs.add(page);
        page.on('dialog', (dialog) => {
            this.pendingDialogs.set(page, { dialog, type: dialog.type(), message: dialog.message(), owner: this.lastActor });
            const waiters = this.dialogWaits.get(page);
            this.dialogWaits.delete(page);
            if (waiters !== undefined) {
                for (const wake of waiters)
                    wake();
            }
        });
    }
    /** The dialog currently blocking this page, or undefined. */
    pendingDialogFor(page) {
        return this.pendingDialogs.get(page);
    }
    /**
     * Remove and return the pending dialog (atomic: one dialog, one answer).
     * Only the owner that raised it may take it: in persistent mode several
     * sessions share one page, and answering another session's dialog would
     * execute its action on their behalf.
     */
    takePendingDialog(page, owner) {
        const pending = this.pendingDialogs.get(page);
        if (pending === undefined)
            return undefined;
        if (pending.owner !== undefined && owner !== undefined && pending.owner !== owner)
            return undefined;
        this.pendingDialogs.delete(page);
        return pending;
    }
    /**
     * Wake when a dialog appears on this page. cancel() unregisters the waiter
     * so a finished action leaves nothing behind.
     */
    armDialogWait(page) {
        const waiters = this.dialogWaits.get(page) ?? new Set();
        let wake = () => { };
        const promise = new Promise((resolve) => {
            wake = () => resolve(true);
        });
        waiters.add(wake);
        this.dialogWaits.set(page, waiters);
        return {
            promise,
            cancel: () => {
                waiters.delete(wake);
            },
        };
    }
    /** One line describing a parked dialog for the tool result. */
    dialogNoteFor(pending) {
        return ('[dialog] ' +
            pending.type +
            ' "' +
            pending.message.replace(/\s+/g, ' ').trim().slice(0, 300) +
            '"' +
            ' is PENDING and the page is blocked until it is answered. Nothing has been accepted or cancelled yet.' +
            ' Answer it with browser_dialog({ accept }) — accept only if the user authorized exactly this action,' +
            ' otherwise dismiss; no other tool can act until it is answered.');
    }
    async acquire(owner) {
        if (!getEnabled()) {
            throw new BrowserError('DISABLED', 'dsh-browser-playwright-codex is disabled; open Settings → Plugins → 浏览器 and turn it on to use the browser');
        }
        const existing = this.entries.get(owner);
        if (existing) {
            existing.lastUsed = Date.now();
            this.armIdle(existing);
            return existing.session;
        }
        if (this.config.launch.persistent) {
            // Personal-browser mode: all owners drive one shared profile-backed
            // window (Codex-style). Entries are lightweight session handles on
            // the shared context; the last owner to leave closes the window.
            const context = await this.ensureContext();
            const session = new PlaywrightSession(this, owner, context);
            const entry = { context, session, lastUsed: Date.now(), pending: 0, timer: undefined };
            this.entries.set(owner, entry);
            this.armIdle(entry);
            return session;
        }
        const browser = await this.ensureBrowser();
        while (this.entries.size >= this.config.maxSessions) {
            const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
            if (oldest === undefined)
                break;
            await this.disposeOwner(oldest[0]);
        }
        const context = await browser.newContext({
            // Headful: viewport: null lets each page track its real window
            // (system DPI respected) exactly like a hand-opened Chrome, instead
            // of Playwright forcing a fixed CSS viewport that overflows the
            // window on scaled displays. Headless keeps the fixed viewport.
            ...(this.config.launch.headless ? { viewport: this.config.launch.viewport } : { viewport: null }),
            ignoreHTTPSErrors: this.config.launch.ignoreHTTPSErrors,
        });
        context.on('page', (page) => this.armDialogGuard(page));
        await context.addInitScript(SNAPSHOT_SCRIPT);
        const session = new PlaywrightSession(this, owner, context);
        const entry = { context, session, lastUsed: Date.now(), pending: 0, timer: undefined };
        this.entries.set(owner, entry);
        this.armIdle(entry);
        void context.on('close', () => {
            if (this.entries.get(owner) === entry) {
                if (entry.timer !== undefined)
                    clearTimeout(entry.timer);
                this.entries.delete(owner);
            }
        });
        return session;
    }
    async disposeOwner(owner) {
        const entry = this.entries.get(owner);
        if (entry === undefined)
            return;
        if (entry.timer !== undefined)
            clearTimeout(entry.timer);
        this.entries.delete(owner);
        if (this.config.launch.persistent) {
            // Close the shared window only when the last owner leaves; the
            // profile and state file keep the login for the next launch.
            if (this.entries.size === 0 && this.context !== undefined) {
                const ctx = this.context;
                this.context = undefined;
                await this.persistState(ctx);
                await ctx.close().catch(() => { });
            }
            return;
        }
        await entry.context.close().catch(() => { });
    }
    async dispose() {
        const owners = [...this.entries.keys()];
        for (const owner of owners)
            await this.disposeOwner(owner);
        if (this.config.launch.persistent) {
            if (this.context !== undefined) {
                const ctx = this.context;
                this.context = undefined;
                await this.persistState(ctx);
                await ctx.close().catch(() => { });
            }
            return;
        }
        if (this.browser !== undefined) {
            await this.browser.close().catch(() => { });
            this.browser = undefined;
        }
    }
    /** Touch the entry's last-used clock and re-arm its idle timer. */
    touch(owner) {
        const entry = this.entries.get(owner);
        if (entry === undefined)
            return;
        entry.lastUsed = Date.now();
        this.armIdle(entry);
    }
    /** Mark one operation in flight so the idle timer cannot kill it mid-way. */
    beginOp(owner) {
        // Remember who is driving: a dialog raised during this call belongs to
        // that owner, and no other session may answer it.
        this.lastActor = owner;
        const entry = this.entries.get(owner);
        if (entry !== undefined)
            entry.pending += 1;
    }
    /** Settle one operation and restart the idle countdown. */
    endOp(owner) {
        const entry = this.entries.get(owner);
        if (entry === undefined)
            return;
        entry.pending = Math.max(0, entry.pending - 1);
        this.touch(owner);
        // Opportunistically export login state after actions (throttled) so a
        // manual window close by the user never loses session cookies.
        this.persistStateSoon(entry.context);
    }
    /** Ensure the session entry for an owner still exists. */
    isLive(owner) {
        return this.entries.has(owner);
    }
    /** Drop an owner's entry after a page-level crash without closing the window. */
    invalidateOwner(owner) {
        const entry = this.entries.get(owner);
        if (entry === undefined)
            return;
        if (entry.timer !== undefined)
            clearTimeout(entry.timer);
        this.entries.delete(owner);
    }
    armIdle(entry) {
        if (entry.timer !== undefined)
            clearTimeout(entry.timer);
        entry.timer = undefined;
        const idle = this.config.idleTimeoutMs;
        if (idle <= 0)
            return;
        entry.timer = setTimeout(() => {
            // A slow operation can outlive the idle window; defer disposal until
            // it settles instead of killing its browser context mid-flight.
            if (entry.pending > 0) {
                this.armIdle(entry);
                return;
            }
            void this.disposeOwner(entry.session.owner);
        }, idle);
        entry.timer.unref?.();
    }
    /**
     * Ensure the shared persistent context is alive (persistent mode). A
     * profile-backed window is launched once and reused until closed by the
     * last owner, idle disposal, or an external close; login state lives in
     * the profile plus the exported state file, so reopening is seamless.
     */
    async ensureContext() {
        if (this.context !== undefined) {
            try {
                const browser = this.context.browser();
                if (browser !== null && browser.isConnected())
                    return this.context;
            }
            catch {
                /* context died underneath us: relaunch */
            }
            this.context = undefined;
        }
        fs.mkdirSync(this.profileDir, { recursive: true });
        const { executablePath, channel, headless } = this.config.launch;
        const headful = !headless;
        const attempts = [];
        const baseOptions = {
            headless,
            // Headful windows must render like a normal Chrome the user opened
            // by hand: the page viewport equals the real window size and the
            // system DPI scaling (e.g. 150%) is honoured. Playwright's default
            // is the opposite — it pins every page to a fixed CSS viewport at
            // deviceScaleFactor 1 via Emulation.setDeviceMetricsOverride, which
            // on scaled displays overflows the window: content looks zoomed in
            // and clipped. viewport: null disables that override entirely.
            // Headless mode keeps the fixed viewport (no window to track).
            ...(headless ? { viewport: this.config.launch.viewport } : { viewport: null }),
            ignoreHTTPSErrors: this.config.launch.ignoreHTTPSErrors,
            ...HUMANIZED_LAUNCH,
            args: [
                '--no-first-run',
                '--no-default-browser-check',
                // Open maximised like a human would, so the first paint fills
                // the screen instead of a small default window.
                ...(headful ? ['--start-maximized'] : []),
                ...HUMANIZED_LAUNCH.args,
            ],
        };
        const start = async (extra) => {
            try {
                this.context = await chromium.launchPersistentContext(this.profileDir, { ...baseOptions, ...extra });
            }
            catch (error) {
                // A stale Chrome singleton lock from a dirty shutdown breaks a
                // relaunch into the same profile; clear the lock files and
                // retry once before surfacing the failure.
                if (error instanceof Error && /user data directory|SingletonLock|ProcessSingleton/i.test(error.message)) {
                    await this.clearChromeLocks();
                    this.context = await chromium.launchPersistentContext(this.profileDir, { ...baseOptions, ...extra });
                }
                else {
                    throw error;
                }
            }
            const ctx = this.context;
            // External close (user closed the window, crash): forget every
            // session handle bound to this context; the next acquire relaunches.
            void ctx.on('close', () => {
                if (this.context !== ctx)
                    return;
                this.context = undefined;
                for (const [key, entry] of [...this.entries]) {
                    if (entry.context !== ctx)
                        continue;
                    if (entry.timer !== undefined)
                        clearTimeout(entry.timer);
                    this.entries.delete(key);
                }
            });
            ctx.on('page', (page) => this.armDialogGuard(page));
            try {
                await this.restoreState(ctx);
            }
            catch {
                /* malformed state file must not block startup */
            }
            await ctx.addInitScript(SNAPSHOT_SCRIPT);
            // The initial blank page predates addInitScript: reload so the
            // snapshot engine and restored localStorage apply on first use.
            for (const page of ctx.pages()) {
                await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
            }
            return ctx;
        };
        if (executablePath !== undefined) {
            try {
                return await start({ executablePath });
            }
            catch (error) {
                this.launchError = error;
                attempts.push('executablePath ' + executablePath);
            }
        }
        else {
            const channels = channel !== undefined && channel !== '' ? [channel] : [...AUTO_CHANNELS];
            for (const candidate of channels) {
                try {
                    return await start({ channel: candidate });
                }
                catch (error) {
                    this.launchError = error;
                    attempts.push('channel ' + candidate);
                }
            }
        }
        const hint = 'Tried: ' +
            attempts.join(', ') +
            '. ' +
            'Install a Chromium-family browser, or run: npx playwright-core install chromium ' +
            '(in restricted networks set PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright), ' +
            'or configure launch.channel / launch.executablePath.';
        if (this.launchError instanceof Error && /executable doesn't exist|not found/i.test(this.launchError.message)) {
            throw new BrowserError('NO_BROWSER', hint);
        }
        throw launchFailed(this.launchError);
    }
    /** Remove stale Chrome singleton lock files inside the profile directory. */
    async clearChromeLocks() {
        for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
            try {
                fs.rmSync(path.join(this.profileDir, lock), { force: true });
            }
            catch {
                /* best-effort */
            }
        }
    }
    /**
     * Collect the login-state fallback WITHOUT ever opening a page while the
     * window is put away.
     *
     * `context.storageState()` is not a pure read. For every origin this context
     * has visited whose page is since gone, it opens a TEMPORARY PAGE, navigates
     * it to that origin, reads its storage, and closes it again
     * (playwright-core 1.62.1 `coreBundle.js:51663-51683`). The origins set is
     * accumulated by `addVisitedOrigin` on every navigation
     * (`coreBundle.js:22352` → `51634`) and only reset by `setStorageState`, so a
     * long-lived context always has leftovers. That temporary page is created
     * through `Target.createTarget` without `background: true`
     * (`coreBundle.js:38340-38342`) — and Chromium activates the window on every
     * tab creation. Same root as Cause 2 in FOCUS-STEALING.md, different trigger:
     * a bookkeeping step that ran after every call could drag a minimized window
     * back onto the screen.
     *
     * Cookies alone never open a page (`coreBundle.js:51639`), so when the window
     * is minimized — or its state cannot be read at all — export cookies only.
     * Nothing durable is lost: this file's job is the session-cookie fallback, and
     * localStorage already survives in the persistent profile. When the window is
     * positively visible we take the full `storageState()`, because a temporary
     * page cannot disturb someone who is already looking at the window.
     */
    async collectLoginState(context) {
        const anchor = context.pages()[0];
        if (anchor !== undefined && !(await isWindowMinimized(anchor)))
            return await context.storageState();
        return { cookies: await context.cookies(), origins: [] };
    }
    /** Export the login-state fallback to the state file (session-cookie fallback). */
    async persistState(context) {
        if (this.stateFile === undefined || context === undefined)
            return;
        try {
            const state = await this.collectLoginState(context);
            const tmp = this.stateFile + '.tmp';
            fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(state));
            fs.renameSync(tmp, this.stateFile);
            this.lastStatePersist = Date.now();
        }
        catch {
            /* best-effort: the profile itself already holds durable cookies */
        }
    }
    /**
     * Throttled, fire-and-forget variant called after every operation.
     *
     * The "is the window minimized?" question moved inside `collectLoginState`,
     * which answers it by choosing a safe API rather than by giving up: the export
     * now runs in either window state, so the session-cookie fallback stops having
     * a hole exactly where it matters most (a user who minimized the window is the
     * one most likely to close it by hand).
     */
    persistStateSoon(context) {
        if (this.stateFile === undefined || context === undefined)
            return;
        if (Date.now() - this.lastStatePersist < 1000)
            return;
        void this.persistState(context).catch(() => { });
    }
    /**
     * Re-inject a previously exported state. Durable cookies already live in
     * the profile; this covers session cookies the browser drops on close and
     * localStorage entries, so logins survive window close/reopen.
     */
    async restoreState(context) {
        if (this.stateFile === undefined)
            return;
        let state;
        try {
            state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        }
        catch {
            return;
        }
        if (state === null || typeof state !== 'object')
            return;
        const cookies = Array.isArray(state.cookies)
            ? state.cookies.filter((c) => c !== null &&
                typeof c === 'object' &&
                typeof c.name === 'string' &&
                c.value !== undefined &&
                typeof c.domain === 'string')
            : [];
        if (cookies.length > 0) {
            await context.addCookies(cookies.map((c) => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: typeof c.path === 'string' && c.path !== '' ? c.path : '/',
                ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
                ...(typeof c.httpOnly === 'boolean' ? { httpOnly: c.httpOnly } : {}),
                ...(typeof c.secure === 'boolean' ? { secure: c.secure } : {}),
                ...(typeof c.sameSite === 'string' ? { sameSite: c.sameSite } : {}),
            })));
        }
        const origins = Array.isArray(state.origins)
            ? state.origins.filter((o) => o !== null &&
                typeof o === 'object' &&
                typeof o.origin === 'string' &&
                Array.isArray(o.localStorage) &&
                o.localStorage.length > 0)
            : [];
        if (origins.length > 0) {
            await context.addInitScript(({ rows }) => {
                for (const o of rows) {
                    if (location.origin !== o.origin)
                        continue;
                    for (const kv of o.localStorage) {
                        try {
                            localStorage.setItem(kv.name, kv.value);
                        }
                        catch {
                            /* quota / privacy mode */
                        }
                    }
                }
            }, { rows: origins });
        }
    }
    /** Launch the browser once, probing the configured or auto-detected channel. */
    async ensureBrowser() {
        if (this.browser !== undefined)
            return this.browser;
        const { executablePath, channel, headless } = this.config.launch;
        const attempts = [];
        if (executablePath !== undefined) {
            try {
                this.browser = await chromium.launch({ executablePath, headless, ...HUMANIZED_LAUNCH });
                return this.browser;
            }
            catch (error) {
                this.launchError = error;
                attempts.push('executablePath ' + executablePath);
            }
        }
        else {
            const channels = channel !== undefined && channel !== '' ? [channel] : [...AUTO_CHANNELS];
            for (const candidate of channels) {
                try {
                    this.browser = await chromium.launch({ channel: candidate, headless, ...HUMANIZED_LAUNCH });
                    return this.browser;
                }
                catch (error) {
                    this.launchError = error;
                    attempts.push('channel ' + candidate);
                }
            }
        }
        const hint = 'Tried: ' +
            attempts.join(', ') +
            '. ' +
            'Install a Chromium-family browser, or run: npx playwright-core install chromium ' +
            '(in restricted networks set PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright), ' +
            'or configure launch.channel / launch.executablePath.';
        if (this.launchError instanceof Error && /executable doesn't exist|not found/i.test(this.launchError.message)) {
            throw new BrowserError('NO_BROWSER', hint);
        }
        throw launchFailed(this.launchError);
    }
}
/** Serialize a Playwright timeout into a stable browser error. Code is
 * prefixed on the message so the model sees a stable machine-readable label. */
function asTimeoutError(kind, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (kind === 'navigation')
        return new BrowserError('NAVIGATION_TIMEOUT', '[NAVIGATION_TIMEOUT] the browser operation timed out: ' + detail);
    return new BrowserError('ACTION_TIMEOUT', '[ACTION_TIMEOUT] the browser action timed out: ' + detail);
}
/** Feature flags carried by an added diff entry. */
function flagsOf(sig) {
    const flags = [];
    if (sig.checked === true)
        flags.push('checked');
    if (sig.selected === true)
        flags.push('selected');
    if (sig.disabled === true)
        flags.push('disabled');
    if (sig.level !== undefined)
        flags.push('level=' + String(sig.level));
    if (sig.href !== undefined)
        flags.push('href=' + sig.href);
    return flags;
}
/** Flag keys whose value changed between two signatures. */
function flagsDeltaOf(before, after) {
    const delta = [];
    const keys = ['checked', 'selected', 'disabled', 'level', 'href'];
    for (const key of keys) {
        const b = before[key];
        const a = after[key];
        if (String(b ?? '') === String(a ?? ''))
            continue;
        delta.push(a !== undefined && a !== false
            ? key === 'level'
                ? 'level=' + String(a)
                : key === 'href'
                    ? 'href=' + a
                    : key
            : key);
    }
    return delta;
}
/** Build a SnapshotDiffEntry, dropping undefined optionals (exactOptionalPropertyTypes). */
function diffEntry(input) {
    const out = { ref: input.ref };
    if (input.role !== undefined)
        out.role = input.role;
    if (input.name !== undefined)
        out.name = input.name;
    if (input.flags !== undefined)
        out.flags = input.flags;
    if (input.flagsDelta !== undefined)
        out.flagsDelta = input.flagsDelta;
    if (input.parentRef !== undefined)
        out.parentRef = input.parentRef;
    return out;
}
/** Live session over one browser context owned by one caller. */
class PlaywrightSession {
    provider;
    owner;
    context;
    currentIndex = 0;
    closed = false;
    /** Set while answering a dialog or reporting it: page access must not be refused then. */
    bypassDialogGuard = false;
    /** Reused CDP session for the current page (DOM nodeIds are session-bound). */
    cdpSession;
    /** The page the cached CDP session is attached to. */
    cdpPage;
    /** Pages already wired for console/network capture (WeakSet: pages stay collectable). */
    trackedPages = new WeakSet();
    /** Stable id per page, so diagnostics can be reported for one page only. */
    pageIds = new WeakMap();
    /** Ids handed out so far (monotonic within the session). */
    pageIdSeq = 0;
    /** Bounded console + pageerror ring, shared by every tracked page of this session. */
    consoleLog = [];
    /** Bounded network ring, shared by every tracked page of this session. */
    networkLog = [];
    /** Monotonic sequence handed to each captured entry. */
    diagSeq = 0;
    /** Evicted entries, so truncation is visible instead of silent. */
    diagDropped = { console: 0, network: 0 };
    /** In-flight requests keyed by request object, for status and duration attribution. */
    requestEntries = new WeakMap();
    /** Ring capacity per stream. */
    diagLimit = 200;
    /** ref -> feature signature of the previous capture (diff baseline). */
    lastRefSignatures = undefined;
    /** Nonce of the baseline ref space; a change means navigation reset. */
    lastRefNonce = undefined;
    constructor(provider, owner, context) {
        this.provider = provider;
        this.owner = owner;
        this.context = context;
    }
    /** Run one operation under busy tracking: idle disposal defers until it settles. */
    run(operation) {
        this.provider.beginOp(this.owner);
        return Promise.resolve()
            .then(operation)
            .catch((error) => {
            if (error instanceof BrowserError || isAbortError(error))
                throw error;
            // The browser or its page died mid-operation: forget this owner's
            // session handle so the next acquire relaunches the window (the
            // profile and state file restore the login). Surface a clear code
            // instead of a raw protocol error.
            if (isCrashError(error)) {
                this.closed = true;
                this.provider.invalidateOwner(this.owner);
                throw new BrowserError('BROWSER_CRASHED', 'the browser crashed or disconnected during the operation; the next browser call reopens it with the saved login state. Original error: ' +
                    (error.message ?? String(error)));
            }
            throw error;
        })
            .finally(() => this.provider.endOp(this.owner));
    }
    /** Fast actionability pre-check (visible/enabled/editable) before an action. */
    async assertActionable(locator, options = {}) {
        const editable = options.editable === true;
        const visible = await locator.isVisible().catch(() => false);
        if (!visible) {
            throw new BrowserError('ELEMENT_NOT_ACTIONABLE', 'the element is not visible — it may have moved or the page changed; take a fresh browser_snapshot and use a ref from its result');
        }
        const enabled = await locator.isEnabled().catch(() => false);
        if (!enabled) {
            throw new BrowserError('ELEMENT_NOT_ACTIONABLE', 'the element is disabled and cannot be acted on');
        }
        if (editable) {
            const canEdit = await locator.isEditable().catch(() => false);
            if (!canEdit) {
                throw new BrowserError('ELEMENT_NOT_ACTIONABLE', 'the element is not editable (read-only or locked by the page)');
            }
        }
    }
    /** Wait for an in-flight navigation (started by a click) to settle. */
    async settleNavigation(page) {
        await page.waitForLoadState('domcontentloaded', { timeout: this.timeoutMs() }).catch(() => { });
    }
    /** Page-level render stability, bounded — a busy page never stalls the agent. */
    async waitForPageStable(page, timeoutMs = 1200) {
        await page.evaluate(pageStabilityProbe, { frames: 2, timeoutMs }).catch(() => false);
    }
    /** Element-level stability before a pointer/keyboard action, bounded. Returns true when stable. */
    async waitForElementStable(locator) {
        const ok = await locator.evaluate(elementStabilityProbe, { frames: 2, timeoutMs: 1500 }).catch(() => false);
        return ok === true;
    }
    /** Post-action settle: wait out a real navigation, then render-stabilize before snapshotting. */
    async settleAndSnapshot(page, navChanged) {
        // Race the settle+capture against a fresh dialog: a chained dialog
        // (one raised the moment the previous was answered) would block
        // page.evaluate forever and hang this call.
        const raced = await this.runAction(page, async () => {
            if (navChanged) {
                await page.waitForLoadState('load', { timeout: this.timeoutMs() }).catch(() => { });
            }
            await this.waitForPageStable(page, navChanged ? 1500 : 800);
            return await this.capture(page, undefined);
        });
        if (raced.blocked)
            return this.blockedSnapshot(page, raced.pending);
        return raced.value;
    }
    /**
     * Snapshot substitute while a native dialog blocks the page: only locally
     * cached data (page.url() needs no round trip) — page.evaluate() and
     * page.title() would both stall behind the dialog.
     */
    blockedSnapshot(page, pending) {
        return {
            url: page.url(),
            title: '',
            nodes: [],
            totalRefs: 0,
            truncated: false,
            dialogNote: this.provider.dialogNoteFor(pending),
        };
    }
    /**
     * Run one page action that may raise a native dialog. Such an action never
     * resolves while the dialog is up, so race it against the dialog appearing
     * and hand the caller the pending state instead (Playwright-MCP pattern).
     */
    async runAction(page, action) {
        const already = this.provider.pendingDialogFor(page);
        if (already !== undefined)
            return { blocked: true, pending: already };
        const wait = this.provider.armDialogWait(page);
        const outcome = action().then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
        const winner = await Promise.race([outcome, wait.promise]);
        wait.cancel();
        if (winner === true)
            return { blocked: true, pending: this.provider.pendingDialogFor(page) };
        if (winner.ok !== true)
            throw winner.error;
        return { blocked: false, value: winner.value };
    }
    /**
     * Answer the pending native dialog and let the action blocked behind it
     * finish. This is the only place a dialog is ever accepted or dismissed.
     */
    async resolveDialog(accept, promptText, signal) {
        return this.run(async () => {
            this.assertLive();
            if (typeof accept !== 'boolean') {
                throw new BrowserError('PARAM_MISSING', 'browser_dialog needs accept: true (confirm) or false (cancel)');
            }
            const page = await this.withDialogGuardLifted(() => this.ensurePage());
            // Atomic take: two concurrent answers cannot both resolve one dialog.
            const pending = this.provider.takePendingDialog(page, this.owner);
            if (pending === undefined) {
                throw new BrowserError('NO_DIALOG', 'no native dialog is pending on this page: there is nothing to accept or dismiss');
            }
            const urlBefore = page.url();
            try {
                await withAbort(accept === true
                    ? promptText !== undefined
                        ? pending.dialog.accept(promptText)
                        : pending.dialog.accept()
                    : pending.dialog.dismiss(), signal);
            }
            catch (error) {
                if (isAbortError(error))
                    throw error;
                throw asTimeoutError('action', error);
            }
            const snap = await this.settleAndSnapshot(page, page.url() !== urlBefore);
            snap.landingNote =
                '[dialog] ' +
                    pending.type +
                    ' "' +
                    pending.message.replace(/\s+/g, ' ').trim().slice(0, 300) +
                    '" was ' +
                    (accept === true ? 'ACCEPTED' : 'DISMISSED') +
                    ' on request; the action blocked behind it has now resumed.';
            return snap;
        });
    }
    /** Read the snapshot tree from one page (must run inside a run()). */
    async capture(page, opts) {
        this.provider.armDialogGuard(page);
        const raw = resolveSnapshotEngine(this.provider.config.snapshot.engine) === 'aria'
            ? await this.captureAria(page, opts)
            : await this.captureLegacy(page, opts);
        return this.attachDiff(raw);
    }
    /**
     * Semantic-tree capture via Playwright's official ariaSnapshot(mode:'ai').
     * An unavailable or unreadable aria tree (`missing`) degrades to the legacy
     * DOM walker instead of returning an empty snapshot: the model must never
     * receive "the page has no elements" because the engine failed to parse.
     */
    async captureAria(page, opts) {
        const o = {
            interactiveOnly: opts?.interactiveOnly === true,
            maxNodes: this.provider.config.snapshot.maxNodes,
            maxNameLength: this.provider.config.snapshot.maxNameLength,
            maxTextLength: this.provider.config.snapshot.maxTextLength,
        };
        let raw;
        try {
            raw = await captureAriaSnapshot(page, o);
        }
        catch (error) {
            // Same mid-evaluate navigation race as the legacy path: settle once and retry.
            if (!isContextDestroyed(error))
                throw error;
            await this.settleNavigation(page);
            raw = await captureAriaSnapshot(page, o);
        }
        if (raw.missing === true) {
            // Degrade honestly: the tree below is the compatible engine's, and the
            // snapshot says so. Silence here is how a user who explicitly picked smart
            // mode keeps believing smart mode is what they are reading.
            const legacy = await this.captureLegacy(page, opts);
            return {
                ...legacy,
                engineNote: 'smart mode could not read this page, so it was rendered with the compatible engine. ' +
                    'The refs below belong to the compatible engine. Nothing is wrong with the page; ' +
                    'switch the page-reading mode in Settings if you want to stop seeing this.',
            };
        }
        return {
            url: page.url(),
            title: await page.title(),
            nodes: raw.nodes ?? [],
            totalRefs: raw.totalRefs ?? 0,
            truncated: raw.truncated ?? false,
        };
    }
    /** Legacy capture: injected DOM walker (default engine, byte-identical output). */
    async captureLegacy(page, opts) {
        const o = {
            ...(opts?.interactiveOnly !== undefined ? { interactiveOnly: opts.interactiveOnly } : {}),
            maxNodes: this.provider.config.snapshot.maxNodes,
            maxNameLength: this.provider.config.snapshot.maxNameLength,
            maxTextLength: this.provider.config.snapshot.maxTextLength,
        };
        const read = (options) => {
            const fn = window.__dshSnapshot;
            if (typeof fn !== 'function')
                return { nodes: [], truncated: false, totalRefs: 0, missing: true };
            return fn(options);
        };
        let raw;
        try {
            raw = await page.evaluate(read, o);
        }
        catch (error) {
            // A click can start a JS navigation that destroys the execution
            // context mid-evaluate; wait for the new document and retry once.
            if (!isContextDestroyed(error))
                throw error;
            await this.settleNavigation(page);
            raw = await page.evaluate(read, o);
        }
        return {
            url: page.url(),
            title: await page.title(),
            nodes: raw.nodes ?? [],
            totalRefs: raw.totalRefs ?? 0,
            truncated: raw.truncated ?? false,
        };
    }
    /**
     * Attach an incremental diff when snapshot.diff is enabled. Absence of the
     * diff field means "full snapshot follows": first capture of the session,
     * navigation reset, or a truncated tree. The diff is keyed by the stable
     * data-dsh-ref, so legacy and aria engines share the same contract.
     */
    attachDiff(snap) {
        if (this.provider.config.snapshot.diff !== true) {
            this.lastRefSignatures = undefined;
            this.lastRefNonce = undefined;
            return snap;
        }
        const sigs = this.buildRefSignatures(snap.nodes);
        const nonce = this.refNonce(snap.nodes);
        const base = this.lastRefSignatures;
        const baseNonce = this.lastRefNonce;
        this.lastRefSignatures = sigs;
        this.lastRefNonce = nonce;
        // No baseline yet (first capture) — the full snapshot is the baseline.
        if (base === undefined || baseNonce === undefined)
            return snap;
        // Navigation reset (ref nonce changed) or truncation: the delta is void.
        if (nonce !== baseNonce || snap.truncated === true) {
            return { ...snap, diff: { added: [], removed: [], changed: [], same: 0, navigationReset: true } };
        }
        const added = [];
        const removed = [];
        const changed = [];
        let same = 0;
        for (const [ref, sig] of sigs) {
            const oldSig = base.get(ref);
            if (oldSig === undefined) {
                added.push(diffEntry({ ref, role: sig.role, name: sig.name, flags: flagsOf(sig), parentRef: sig.parentRef }));
            }
            else {
                const delta = flagsDeltaOf(oldSig, sig);
                if (sig.role !== oldSig.role || sig.name !== oldSig.name || delta.length > 0) {
                    changed.push(diffEntry({ ref, role: sig.role, name: sig.name, flagsDelta: delta, parentRef: sig.parentRef }));
                }
                else {
                    same += 1;
                }
            }
        }
        for (const ref of base.keys()) {
            if (!sigs.has(ref))
                removed.push(ref);
        }
        return { ...snap, diff: { added, removed, changed, same, navigationReset: false } };
    }
    /** Build ref -> feature signature map from a captured tree, with parent refs. */
    buildRefSignatures(nodes) {
        const out = new Map();
        const walk = (list, parentRef) => {
            for (const node of list) {
                if (node.ref !== undefined) {
                    out.set(node.ref, {
                        role: node.role,
                        name: node.name,
                        ...(node.level !== undefined ? { level: node.level } : {}),
                        checked: node.checked === true,
                        selected: node.selected === true,
                        disabled: node.disabled === true,
                        ...(node.href !== undefined ? { href: node.href } : {}),
                        ...(parentRef !== undefined ? { parentRef } : {}),
                    });
                }
                walk(node.children ?? [], node.ref ?? parentRef);
            }
        };
        walk(nodes);
        return out;
    }
    /** The document nonce shared by this snapshot's refs, or undefined. */
    refNonce(nodes) {
        for (const node of nodes) {
            if (node.ref !== undefined && node.ref.length >= 10)
                return node.ref.slice(1, 10);
            const nested = this.refNonce(node.children ?? []);
            if (nested !== undefined)
                return nested;
        }
        return undefined;
    }
    async navigate(url, waitUntil, signal) {
        return this.run(async () => {
            const target = assertAllowedUrl(url, this.provider.config.allowedDomains ?? []);
            const page = await this.ensurePage();
            try {
                const racedNav = await this.runAction(page, () => withAbort(page.goto(target.toString(), { waitUntil, timeout: this.timeoutMs() }), signal));
                if (racedNav.blocked)
                    return this.blockedSnapshot(page, racedNav.pending);
            }
            catch (error) {
                if (isAbortError(error) || signal?.aborted === true)
                    throw error;
                throw asTimeoutError('navigation', error);
            }
            return this.settleAndSnapshot(page, true);
        });
    }
    async snapshot(opts) {
        return this.run(async () => {
            this.assertLive();
            const page = await this.withDialogGuardLifted(() => this.ensurePage());
            this.provider.touch(this.owner);
            // A parked dialog blocks the page: never round-trip into it.
            const pending = this.provider.pendingDialogFor(page);
            if (pending !== undefined)
                return this.blockedSnapshot(page, pending);
            const racedSnap = await this.runAction(page, async () => {
                await this.waitForPageStable(page, 400);
                return await this.capture(page, opts);
            });
            if (racedSnap.blocked)
                return this.blockedSnapshot(page, racedSnap.pending);
            return racedSnap.value;
        });
    }
    /**
     * Codex-style click-point resolution. Tries a scroll-alignment ladder
     * (centre, then end, then start). For each alignment: scroll the element
     * into view with a native scrollIntoView, wait for its bounding rect to
     * stop moving, sample the rect centre in-page (sub-pixel, no screenshot
     * measurement), then hit-test that exact point with elementFromPoint — so
     * an overlaying element can never swallow the click silently. Returns the
     * first unobstructed {x, y}, or throws describing what intercepted it.
     */
    async resolveClickPoint(locator, signal) {
        const alignments = [
            { block: 'center', inline: 'nearest' },
            { block: 'end', inline: 'end' },
            { block: 'start', inline: 'start' },
        ];
        const hitTest = (el) => {
            const r = el.getBoundingClientRect();
            const x = Math.max(0, r.left + r.width / 2);
            const y = Math.max(0, r.top + r.height / 2);
            const w = r.width;
            const h = r.height;
            if (w <= 0 || h <= 0)
                return { ok: false, reason: 'zero-size', x, y };
            const describe = (n) => {
                if (!n)
                    return '(nothing)';
                const cls = typeof n.className === 'string' && n.className.trim()
                    ? '.' + n.className.trim().split(/\s+/).filter(Boolean).join('.')
                    : '';
                const role = n.getAttribute && n.getAttribute('role');
                const text = n.childElementCount === 0 && n.textContent ? ' "' + n.textContent.trim().slice(0, 24) + '"' : '';
                return ((n.tagName ? n.tagName.toLowerCase() : n.nodeName) +
                    (n.id ? '#' + n.id : '') +
                    cls +
                    (role ? '[role=' + role + ']' : '') +
                    text);
            };
            let hit = null;
            try {
                hit = document.elementFromPoint(x, y);
            }
            catch {
                hit = null;
            }
            if (!hit)
                return { ok: false, reason: 'nothing-at-point', x, y };
            let belongs = false;
            if (hit === el || el.contains(hit)) {
                belongs = true;
            }
            else {
                // Walk up from the hit; crossing a shadow boundary hops to the
                // shadow host so targets inside shadow DOM still count.
                let node = hit;
                const seen = new Set();
                while (node && !seen.has(node)) {
                    seen.add(node);
                    if (node === el) {
                        belongs = true;
                        break;
                    }
                    const root = node.getRootNode
                        ? node.getRootNode()
                        : null;
                    node = node.parentNode || (root && root.host ? root.host : null);
                }
            }
            return belongs
                ? { ok: true, x, y, hitDesc: describe(hit), hitSelf: hit === el }
                : { ok: false, reason: 'intercepted', x, y, by: describe(hit) };
        };
        let lastBlockedBy;
        let lastReason;
        for (const align of alignments) {
            try {
                // Native scroll so block alignment is honoured; Playwright's
                // scrollIntoViewIfNeeded only promises *some* visibility.
                await withAbort(locator.evaluate((el, a) => {
                    if (typeof el.scrollIntoView === 'function')
                        el.scrollIntoView({ block: a.block, inline: a.inline, behavior: 'instant' });
                }, align), signal);
            }
            catch {
                /* try the next alignment */
            }
            // Wait out layout shifts before sampling the centre point.
            await this.waitForElementStable(locator);
            const probe = await withAbort(locator.evaluate(hitTest), signal).catch(() => null);
            if (probe && probe.ok)
                return { x: probe.x, y: probe.y, hitDesc: probe.hitDesc, hitSelf: probe.hitSelf };
            if (probe && probe.reason === 'intercepted') {
                lastBlockedBy = probe.by;
                lastReason = 'intercepted';
            }
            else if (lastReason === null) {
                lastReason = probe ? probe.reason : 'unreachable';
            }
        }
        if (lastReason === 'intercepted') {
            throw new BrowserError('ELEMENT_NOT_ACTIONABLE', 'the element does not receive pointer events at its centre: ' +
                (lastBlockedBy || 'another element') +
                ' intercepts the click (tried centre / end / start alignment)');
        }
        if (lastReason === 'zero-size') {
            throw new BrowserError('ELEMENT_NOT_ACTIONABLE', 'ref has no clickable geometry (zero size); take a fresh browser_snapshot');
        }
        throw new BrowserError('ELEMENT_NOT_ACTIONABLE', 'could not find an unobstructed click point for the ref; take a fresh browser_snapshot');
    }
    async click(ref, signal) {
        return this.run(async () => {
            const locator = await this.refLocator(ref);
            return this.clickLocator(locator, signal, 'ref ' + ref, 0);
        });
    }
    /**
     * Click an element the snapshot gave no ref, addressed by its visible label
     * (e.g. a menu item revealed by browser_hover that is plain text). The
     * label must equal an element's own direct text; the deepest match wins,
     * and the landing note names what was actually clicked plus how many
     * elements shared the label.
     */
    async clickText(text, signal) {
        return this.run(async () => {
            const page = this.currentPageSync();
            const found = await page.evaluate(labelTargetProbe, { text: String(text) }).catch(() => null);
            if (found === null || found.found !== true) {
                throw new BrowserError('CLICK_TARGET_NOT_FOUND', 'no visible element on this page has the label ' +
                    JSON.stringify(text) +
                    '; take a browser_snapshot and copy the label exactly as it is shown there, or click by ref');
            }
            const locator = page.locator('[data-dsh-label-target="' + found.token + '"]').first();
            try {
                return await this.clickLocator(locator, signal, JSON.stringify(text) + ' (' + found.desc + ')', found.total);
            }
            finally {
                // The stamp is only a locator handle: clear it once the click
                // has been delivered so no residue is left in the page. While a
                // dialog blocks the page this evaluate would hang, so skip it.
                if (this.provider.pendingDialogFor(page) === undefined)
                    await page.evaluate(clearLabelTargets).catch(() => { });
            }
        });
    }
    /**
     * Enforce the navigation policy for the link a click is about to follow.
     * Click navigation does not run through navigate(), so this is the only place
     * the rule lives and every click path (ref, text, geometric ref, raw x/y)
     * calls it — a new path cannot quietly skip the allow-list.
     *
     * The policy is about which HOSTS this browser may visit, so it applies to
     * http(s) destinations. An in-page `javascript:` link runs the page's own
     * code without navigating anywhere and is allowed (refusing it made ordinary
     * JS links unclickable); every other scheme — file:, data:, mailto:, tel:,
     * custom ones — stays refused.
     */
    assertClickTargetAllowed(href) {
        if (href === null || href === '')
            return;
        let target;
        try {
            target = new URL(href, this.currentPageSync().url());
        }
        catch {
            throw new BrowserError('URL_NOT_ALLOWED', 'invalid link target: ' + href);
        }
        if (target.protocol === 'javascript:')
            return;
        assertAllowedUrl(target.toString(), this.provider.config.allowedDomains ?? []);
    }
    /**
     * Enforce the host policy on a tab before this session starts driving it. A
     * page can open a tab by itself (`target="_blank"`, `window.open`) and the
     * plugin never sees that navigation, so the policy is applied at the point of
     * use instead: a tab outside the allow-list stays open — the user may well be
     * using it — but this agent refuses to switch to it.
     *
     * http(s) is checked against allowedDomains; `about:blank` is allowed because
     * it is the plugin's own interim state and has no host; every other scheme
     * (file:, data:, chrome:, devtools:) is refused outright.
     */
    assertTabAllowed(page) {
        const raw = page.url();
        if (raw === '')
            return;
        let target;
        try {
            target = new URL(raw);
        }
        catch {
            return;
        }
        if (target.protocol === 'about:')
            return;
        assertAllowedUrl(target.toString(), this.provider.config.allowedDomains ?? []);
    }
    /**
     * Shared click core: enforce the URL policy for link targets, run the
     * Codex-style geometry ladder with the Playwright actionability fallback,
     * then report what actually received the click. The label names the target
     * in the landing note; shared is how many elements matched it (0 for refs).
     */
    async clickLocator(locator, signal, label, shared) {
        this.assertClickTargetAllowed(await locator.getAttribute('href'));
        const page = this.currentPageSync();
        const urlBefore = page.url();
        let point;
        try {
            // Codex-style geometry pipeline first: alignment ladder →
            // stable rect → centre point → elementFromPoint hit-test.
            point = await this.resolveClickPoint(locator, signal);
        }
        catch (error) {
            if (isAbortError(error))
                throw error;
            if (error instanceof BrowserError) {
                // Ladder exhausted: let Playwright's own actionability
                // machinery retry (it waits for transient overlays to
                // disappear) and surface its verdict before ours.
                try {
                    const racedFallback = await this.runAction(page, () => withAbort(locator.click({ timeout: Math.min(this.timeoutMs(), 3000) }), signal));
                    if (racedFallback.blocked)
                        return this.blockedSnapshot(page, racedFallback.pending);
                    const snap = await this.settleAndSnapshot(page, page.url() !== urlBefore);
                    snap.landingNote =
                        'playwright actionability click delivered to ' +
                            label +
                            ' after the geometry ladder was blocked — verify the page state shows the intended change';
                    return snap;
                }
                catch (fallbackError) {
                    if (isAbortError(fallbackError))
                        throw fallbackError;
                    throw error;
                }
            }
            throw error;
        }
        let raced;
        try {
            raced = await this.runAction(page, () => withAbort(page.mouse.click(point.x, point.y), signal));
        }
        catch (error) {
            if (isAbortError(error))
                throw error;
            throw asTimeoutError('action', error);
        }
        if (raced.blocked)
            return this.blockedSnapshot(page, raced.pending);
        const snap = await this.settleAndSnapshot(page, page.url() !== urlBefore);
        const note = 'click delivered at (' +
            Math.round(point.x) +
            ',' +
            Math.round(point.y) +
            ') — landed on ' +
            point.hitDesc +
            (point.hitSelf ? ' (the targeted element itself)' : ' (inside the targeted element)');
        snap.landingNote =
            shared > 1
                ? 'clicked the FIRST of ' +
                    shared +
                    ' visible elements labelled ' +
                    label +
                    ' — if that is not the one you meant, take a browser_snapshot and click by ref. ' +
                    note
                : note;
        return snap;
    }
    async clickAt(x, y, signal) {
        return this.run(async () => {
            const page = this.currentPageSync();
            const urlBefore = page.url();
            // Raw mode has no locator: sample what sits at the target point so the
            // returned snapshot can say what actually received the click, and so the
            // URL policy can be enforced for the link that point belongs to.
            const probe = await page
                .evaluate((pt) => {
                const px = pt.x;
                const py = pt.y;
                let hit = null;
                try {
                    hit = document.elementFromPoint(px, py);
                }
                catch {
                    hit = null;
                }
                if (!hit)
                    return { desc: '(nothing — blank area or outside the viewport)', linkHref: null };
                const cls = typeof hit.className === 'string' && hit.className.trim()
                    ? '.' + hit.className.trim().split(/\s+/).filter(Boolean).join('.')
                    : '';
                const role = hit.getAttribute && hit.getAttribute('role');
                const text = hit.childElementCount === 0 && hit.textContent ? ' "' + hit.textContent.trim().slice(0, 24) + '"' : '';
                const anchor = hit.closest('a[href]');
                return {
                    desc: (hit.tagName ? hit.tagName.toLowerCase() : hit.nodeName) +
                        (hit.id ? '#' + hit.id : '') +
                        cls +
                        (role ? '[role=' + role + ']' : '') +
                        text,
                    linkHref: anchor === null ? null : anchor.getAttribute('href'),
                };
            }, { x, y })
                .catch(() => null);
            const hitDesc = probe === null ? '(unavailable)' : probe.desc;
            // A raw click can navigate: enforce the policy for the link under the
            // point before any input is delivered.
            this.assertClickTargetAllowed(probe === null ? null : probe.linkHref);
            let racedAt = { blocked: false };
            try {
                // Raw native click by viewport coordinates (CDP Input
                // dispatch, isTrusted=true — indistinguishable from a human
                // click). No ref lookup, no visibility/actionability gate:
                // the escape hatch for elements the snapshot tree cannot
                // represent or stubborn rows that refuse ref-based clicks.
                racedAt = await this.runAction(page, () => withAbort(page.mouse.click(x, y), signal));
            }
            catch (error) {
                if (isAbortError(error))
                    throw error;
                throw asTimeoutError('action', error);
            }
            if (racedAt.blocked)
                return this.blockedSnapshot(page, racedAt.pending);
            const snap = await this.settleAndSnapshot(page, page.url() !== urlBefore);
            snap.landingNote = 'raw click delivered at (' + x + ',' + y + ') — that point held: ' + hitDesc;
            return snap;
        });
    }
    async clickAtRef(ref, signal) {
        return this.run(async () => {
            const locator = await this.refLocator(ref);
            const page = this.currentPageSync();
            const urlBefore = page.url();
            // Ref mode resolves the element before clicking, so the link policy can
            // be enforced up front — the same rule browser_click applies.
            this.assertClickTargetAllowed(await locator.getAttribute('href'));
            try {
                // Codex-style geometry click with obstruction awareness:
                // scroll (centre → end → start), wait for the bounding rect to
                // stop moving, then click the RECT CENTRE computed in-page —
                // no screenshot measurement, no devicePixelRatio guesswork,
                // sub-pixel exact. Before committing, hit-test the point so an
                // overlay can never swallow the click silently; if something
                // intercepts, realign and retry up to the alignment ladder.
                const point = await this.resolveClickPoint(locator, signal);
                const racedRef = await this.runAction(page, () => withAbort(page.mouse.click(point.x, point.y), signal));
                if (racedRef.blocked)
                    return this.blockedSnapshot(page, racedRef.pending);
                const snap = await this.settleAndSnapshot(page, page.url() !== urlBefore);
                snap.landingNote =
                    'click delivered at (' +
                        Math.round(point.x) +
                        ',' +
                        Math.round(point.y) +
                        ') — landed on ' +
                        point.hitDesc +
                        (point.hitSelf ? ' (the targeted element itself)' : ' (inside the targeted element)');
                return snap;
            }
            catch (error) {
                if (isAbortError(error))
                    throw error;
                if (error instanceof BrowserError) {
                    // Escape hatch: when the geometry ladder reports an
                    // interception, still try ONE bare native click at the raw
                    // centre point. Some sites layer a transparent hit-catcher
                    // that reports interception but forwards the click anyway,
                    // or only listen for CDP-native isTrusted=true events.
                    const raw = await locator
                        .evaluate((el) => {
                        const r = el.getBoundingClientRect();
                        return {
                            x: Math.max(0, r.left + r.width / 2),
                            y: Math.max(0, r.top + r.height / 2),
                            w: r.width,
                            h: r.height,
                        };
                    })
                        .catch(() => null);
                    if (raw && raw.w > 0 && raw.h > 0) {
                        try {
                            await withAbort(page.mouse.click(raw.x, raw.y), signal);
                            const snap = await this.settleAndSnapshot(page, page.url() !== urlBefore);
                            // The bare click went to the same point the hit-test
                            // flagged as intercepted — so the topmost element at
                            // that point (NOT the intended target) received it,
                            // unless the overlay forwards events. Say so loudly.
                            snap.landingNote =
                                'CAUTION: the intended target was flagged as intercepted; a bare native click was sent to its centre (' +
                                    Math.round(raw.x) +
                                    ',' +
                                    Math.round(raw.y) +
                                    ') as a last resort. ' +
                                    'The element that was ON TOP at that point received the click unless it forwards events — check whether the page changed as intended (the interceptor, if any, is named in the error that would otherwise have been thrown).';
                            return snap;
                        }
                        catch (rawError) {
                            if (isAbortError(rawError))
                                throw rawError;
                        }
                    }
                }
                throw error;
            }
        });
    }
    async fill(ref, text, signal) {
        return this.run(async () => {
            const locator = await this.refLocator(ref);
            const page = this.currentPageSync();
            await this.waitForElementStable(locator);
            await this.assertActionable(locator, { editable: true });
            const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => 'input');
            let lastError;
            let written = false;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    if (tag === 'select') {
                        await withAbort(locator.selectOption({ label: text }, { timeout: this.timeoutMs() }), signal);
                    }
                    else {
                        await withAbort(locator.fill(text, { timeout: this.timeoutMs() }), signal);
                    }
                }
                catch (error) {
                    if (isAbortError(error))
                        throw error;
                    lastError = error;
                    continue;
                }
                // Post-action verification: read the value back. Lenient match
                // so formatted/masked inputs do not false-positive, but a value
                // that never stuck gets one retry then a clear diagnostic.
                written = await this.verifyFill(locator, tag, text);
                if (written)
                    break;
            }
            if (!written) {
                const detail = lastError instanceof Error ? lastError.message : '';
                throw new BrowserError('VALUE_NOT_SET', 'the fill did not stick after 2 attempts — the value was not written to the field' +
                    (detail ? ': ' + detail : ''));
            }
            return this.settleAndSnapshot(page, false);
        });
    }
    /** Read the field back and decide whether the fill landed. */
    async verifyFill(locator, tag, text) {
        try {
            if (tag === 'select') {
                const label = await locator.evaluate((el) => {
                    const o = el.selectedOptions[0];
                    return o === undefined ? '' : o.label;
                });
                return label === text;
            }
            const value = await locator.inputValue();
            if (value === text)
                return true;
            // Lenient: formatted inputs (masks, prefixes) rewrite the display
            // value; accept containment or a near-equal length as "written".
            return (text.length > 0 &&
                value.length > 0 &&
                (value.includes(text) || text.includes(value) || Math.abs(value.length - text.length) <= 2));
        }
        catch {
            return false;
        }
    }
    async press(ref, key, signal) {
        return this.run(async () => {
            const locator = await this.refLocator(ref);
            const page = this.currentPageSync();
            await this.waitForElementStable(locator);
            const urlBefore = page.url();
            try {
                const racedPress = await this.runAction(page, () => withAbort(locator.press(key, { timeout: this.timeoutMs() }), signal));
                if (racedPress.blocked)
                    return this.blockedSnapshot(page, racedPress.pending);
            }
            catch (error) {
                if (isAbortError(error))
                    throw error;
                throw asTimeoutError('action', error);
            }
            return this.settleAndSnapshot(page, page.url() !== urlBefore);
        });
    }
    /**
     * Hover the referenced element: rest the pointer on it so hover-revealed
     * content appears (CSS :hover rules, JS mouseenter handlers, submenus,
     * tooltips, chart values, player controls). Hover never activates
     * anything: it only reveals. The ref count before and after the pointer
     * moves is the only cheap proof that something appeared, so the returned
     * snapshot carries a note comparing them.
     */
    async hover(ref, signal) {
        return this.run(async () => {
            const locator = await this.refLocator(ref);
            return this.hoverLocator(locator, signal, 'ref ' + ref, 0);
        });
    }
    /**
     * Hover a trigger the snapshot gave no ref, addressed by its visible label
     * (e.g. a plain span that reveals a menu on mouseenter). The label must
     * equal an element's own direct text; the deepest match wins, and the
     * landing note names what was hovered plus how many elements shared it.
     */
    async hoverText(text, signal) {
        return this.run(async () => {
            const page = this.currentPageSync();
            const found = await page.evaluate(labelTargetProbe, { text: String(text) }).catch(() => null);
            if (found === null || found.found !== true) {
                throw new BrowserError('HOVER_TARGET_NOT_FOUND', 'no visible element on this page has the label ' +
                    JSON.stringify(text) +
                    '; take a browser_snapshot and copy the label exactly as it is shown there, or hover by ref');
            }
            const locator = page.locator('[data-dsh-label-target="' + found.token + '"]').first();
            try {
                return await this.hoverLocator(locator, signal, JSON.stringify(text) + ' (' + found.desc + ')', found.total);
            }
            finally {
                // The stamp is only a locator handle: clear it once the hover
                // has been delivered so no residue is left in the page.
                await page.evaluate(clearLabelTargets).catch(() => { });
            }
        });
    }
    /**
     * Shared hover core: rest the pointer on a resolved locator, then report
     * what the actionable ref count did. The label names the target in the
     * landing note; shared is how many elements matched that label (0 when the
     * target came from a ref).
     */
    async hoverLocator(locator, signal, label, shared) {
        await this.assertActionable(locator);
        const page = this.currentPageSync();
        await this.waitForElementStable(locator);
        const urlBefore = page.url();
        const before = await this.capture(page, undefined);
        try {
            await withAbort(locator.hover({ timeout: this.timeoutMs() }), signal);
        }
        catch (error) {
            if (isAbortError(error))
                throw error;
            throw asTimeoutError('action', error);
        }
        const navigated = page.url() !== urlBefore;
        const snap = await this.settleAndSnapshot(page, navigated);
        const note = hoverNote(label, before.totalRefs, snap.totalRefs, navigated);
        snap.landingNote =
            shared > 1
                ? 'hovered the FIRST of ' +
                    shared +
                    ' visible elements labelled ' +
                    label +
                    ' — if that is not the one you meant, take a browser_snapshot and hover by ref. ' +
                    note
                : note;
        return snap;
    }
    async scroll(direction, amount, ref, signal) {
        return this.run(async () => {
            const page = await this.ensurePage();
            try {
                if (ref !== undefined) {
                    await withAbort((await this.refLocator(ref)).scrollIntoViewIfNeeded({ timeout: this.timeoutMs() }), signal);
                }
                const delta = direction === 'down' ? amount : -amount;
                await withAbort(page.mouse.wheel(0, delta), signal);
            }
            catch (error) {
                if (isAbortError(error))
                    throw error;
                throw asTimeoutError('action', error);
            }
            // Lazy-loading pages fire async loaders after a wheel; a quiet page
            // that has not started loading yet would otherwise look "stable"
            // instantly and the snapshot would miss the late content. Give the
            // loaders a beat, then settle (bounded) before capturing.
            await withAbort(new Promise((resolve) => setTimeout(resolve, 450)), signal);
            await this.waitForPageStable(page, 1200);
            return this.capture(page, undefined);
        });
    }
    async back(signal) {
        return this.run(async () => {
            const page = await this.ensurePage();
            try {
                await withAbort(page.goBack({ timeout: this.timeoutMs() }), signal);
            }
            catch (error) {
                if (isAbortError(error))
                    throw error;
                throw asTimeoutError('navigation', error);
            }
            return this.settleAndSnapshot(page, true);
        });
    }
    async forward(signal) {
        return this.run(async () => {
            const page = await this.ensurePage();
            try {
                await withAbort(page.goForward({ timeout: this.timeoutMs() }), signal);
            }
            catch (error) {
                if (isAbortError(error))
                    throw error;
                throw asTimeoutError('navigation', error);
            }
            return this.settleAndSnapshot(page, true);
        });
    }
    async wait(ms, signal) {
        return this.run(async () => {
            this.provider.touch(this.owner);
            await withAbort(new Promise((resolve) => setTimeout(resolve, ms)), signal);
        });
    }
    async tabs() {
        return this.run(async () => {
            this.assertLive();
            this.provider.touch(this.owner);
            const pages = this.context.pages();
            // The tab the other tools act on, so the model never has to guess.
            const activeIndex = Math.min(this.currentIndex, Math.max(0, pages.length - 1));
            const out = [];
            for (let index = 0; index < pages.length; index += 1) {
                const page = pages[index];
                if (page === undefined)
                    continue;
                this.guardBlockedDialog(page);
                out.push({ index, url: page.url(), title: await page.title(), active: index === activeIndex });
            }
            return out;
        });
    }
    async switchTab(index, signal) {
        return this.run(async () => {
            this.assertLive();
            this.guardBlockedContext();
            const page = this.pageAt(index);
            if (page === undefined)
                throw new BrowserError('REF_NOT_FOUND', 'no tab at index ' + String(index));
            // Switching is the only way this session starts driving a tab it did not
            // open itself, so the host policy is applied here: a page-opened tab
            // outside the allow-list cannot be reached. The refusal happens before
            // currentIndex moves, so the session stays on the tab it was driving.
            this.assertTabAllowed(page);
            this.currentIndex = index;
            // A minimized window stays minimized: switching tabs is a
            // context-level operation that needs no OS window activation.
            if (!(await isWindowMinimized(page)))
                await withAbort(page.bringToFront(), signal);
            return this.snapshot();
        });
    }
    async openTab(url, waitUntil, signal) {
        return this.run(async () => {
            this.assertLive();
            this.guardBlockedContext();
            const target = assertAllowedUrl(url, this.provider.config.allowedDomains ?? []);
            // Background creation: a new tab must not yank a minimized window
            // into the user's face (see createBackgroundPage).
            const page = await createBackgroundPage(this.context);
            const index = this.context.pages().indexOf(page);
            this.currentIndex = index >= 0 ? index : this.context.pages().length - 1;
            this.provider.armDialogGuard(page);
            // Track before the first navigation. Attaching the console/network
            // listeners any later loses the requests that brought the tab into
            // existence, so an opened tab looked silent from its very first load.
            this.trackPage(page);
            try {
                await withAbort(page.goto(target.toString(), { waitUntil, timeout: this.timeoutMs() }), signal);
            }
            catch (error) {
                if (isAbortError(error))
                    throw error;
                throw asTimeoutError('navigation', error);
            }
            return this.settleAndSnapshot(page, true);
        });
    }
    async closeTab(index, signal) {
        return this.run(async () => {
            this.assertLive();
            this.guardBlockedContext();
            const pages = this.context.pages();
            const page = pages[index];
            if (page === undefined)
                throw new BrowserError('REF_NOT_FOUND', 'no tab at index ' + String(index));
            if (pages.length <= 1) {
                await withAbort(page.goto('about:blank'), signal);
                return;
            }
            await withAbort(page.close(), signal);
            this.currentIndex = Math.min(this.currentIndex, this.context.pages().length - 1);
        });
    }
    async screenshot(opts, signal) {
        return this.run(async () => {
            this.assertLive();
            this.provider.touch(this.owner);
            const page = await this.ensurePage();
            if (opts?.ref !== undefined) {
                const bytes = await withAbort((await this.refLocator(opts.ref)).screenshot({ type: 'png', timeout: this.timeoutMs() }), signal);
                return { mime: 'image/png', bytes };
            }
            const bytes = await withAbort(page.screenshot({
                type: 'png',
                fullPage: opts?.fullPage ?? false,
                animations: 'disabled',
                caret: 'hide',
                timeout: this.timeoutMs(),
            }), signal);
            return { mime: 'image/png', bytes };
        });
    }
    async pageData() {
        return this.run(async () => {
            this.assertLive();
            this.provider.touch(this.owner);
            const page = await this.ensurePage();
            const read = () => {
                const fn = window.__dshPageData;
                if (typeof fn !== 'function')
                    return { url: location.href, title: document.title, text: '', truncated: false, links: [], inputs: [] };
                return fn({ maxTextChars: 30000, maxLinks: 300, maxInputs: 200 });
            };
            let data;
            try {
                data = await page.evaluate(read);
            }
            catch (error) {
                if (!isContextDestroyed(error))
                    throw error;
                await this.settleNavigation(page);
                data = await page.evaluate(read);
            }
            return data;
        });
    }
    async evaluate(expression, signal) {
        return this.run(async () => {
            this.assertLive();
            this.provider.touch(this.owner);
            const page = await this.ensurePage();
            const fn = new Function('return (' + expression + ')');
            try {
                return await withAbort(page.evaluate(fn), signal);
            }
            catch (error) {
                if (!isContextDestroyed(error) || signal?.aborted === true)
                    throw error;
                await this.settleNavigation(page);
                return withAbort(page.evaluate(fn), signal);
            }
        });
    }
    /**
     * Send one raw CDP command on the current page's session and return its
     * result. This is the "direct protocol" escape hatch behind every other
     * tool — the model can inspect geometry, dispatch trusted input events or
     * query the DOM the same way Chrome DevTools does. Policy (which methods
     * are allowed) lives in the tool layer via lib/cdp-policy.js; this method
     * itself performs no filtering so internal callers keep full control.
     */
    async cdp(method, params, signal) {
        return this.run(async () => {
            this.assertLive();
            this.provider.touch(this.owner);
            const page = await this.ensurePage();
            // Reuse the cached CDP session when still on the same page: DOM
            // nodeIds and execution contexts are session-bound, so creating a
            // fresh session per call would invalidate ids from earlier calls.
            if (this.cdpSession === undefined || this.cdpSession === null || this.cdpPage !== page) {
                await this.cdpSession?.detach().catch(() => { });
                this.cdpSession = await this.context.newCDPSession(page);
                this.cdpPage = page;
            }
            try {
                // CDPSession.send is a prototype method: it needs its receiver, so bind it
                // before handing it to withAbort. An unbound reference dies on `this._channel`
                // inside the driver, and the failure gets reported as a protocol error.
                // CDPSession.send is a prototype method: it needs its receiver, so bind it
                // before handing it to withAbort. An unbound reference dies on `this._channel`
                // inside the driver, and the failure gets reported as a protocol error.
                const session = this.cdpSession;
                const send = session.send.bind(session);
                return await withAbort(send(method, params ?? {}), signal);
            }
            catch (error) {
                if (isAbortError(error))
                    throw error;
                // CDP protocol errors are already structured ("Protocol error
                // (DOM.foo): ..."); wrap non-abort failures in a stable code.
                const detail = error instanceof Error ? error.message : String(error);
                if (/Protocol error/.test(detail)) {
                    const m = /\(([^)]+)\): ([\s\S]+)/.exec(detail);
                    throw new BrowserError('CDP_ERROR', m
                        ? 'CDP command ' + (m[1] ?? '') + ' failed: ' + (m[2] ?? '').trim().slice(0, 400)
                        : 'CDP command failed: ' + detail.slice(0, 400));
                }
                throw new BrowserError('CDP_ERROR', 'CDP command ' + method + ' failed: ' + detail.slice(0, 400));
            }
        });
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        await this.cdpSession?.detach().catch(() => { });
        this.cdpSession = undefined;
        await this.provider.disposeOwner(this.owner);
    }
    timeoutMs() {
        return this.provider.config.launch.navigationTimeoutMs;
    }
    async ensurePage() {
        this.assertLive();
        const pages = this.context.pages();
        if (pages.length === 0) {
            const created = await this.context.newPage();
            this.currentIndex = 0;
            this.provider.armDialogGuard(created);
            this.guardBlockedDialog(created);
            this.trackPage(created);
            return created;
        }
        this.currentIndex = Math.min(this.currentIndex, pages.length - 1);
        const page = pages[this.currentIndex] ?? pages[0];
        if (page === undefined) {
            const created = await this.context.newPage();
            this.currentIndex = 0;
            this.provider.armDialogGuard(created);
            this.guardBlockedDialog(created);
            this.trackPage(created);
            return created;
        }
        this.provider.armDialogGuard(page);
        this.guardBlockedDialog(page);
        this.trackPage(page);
        return page;
    }
    /**
     * Wire bounded console/network capture onto one page, exactly once. Capture is
     * best-effort observation for the model: it must never throw into a page that is
     * otherwise healthy, and it must never grow without a bound.
     */
    trackPage(page) {
        if (this.trackedPages.has(page))
            return;
        this.trackedPages.add(page);
        const pageId = this.pageIdFor(page);
        const record = (kind, entry) => {
            this.diagSeq += 1;
            entry.n = this.diagSeq;
            entry.at = Date.now();
            // Tag the owner: the rings are session-wide, the readers are per page.
            entry.page = pageId;
            const ring = kind === 'console' ? this.consoleLog : this.networkLog;
            ring.push(entry);
            while (ring.length > this.diagLimit) {
                ring.shift();
                this.diagDropped[kind] += 1;
            }
        };
        try {
            page.on('console', (msg) => {
                record('console', { level: msg.type(), text: msg.text(), source: (msg.location() ?? {}).url ?? '' });
            });
            page.on('pageerror', (err) => {
                record('console', { level: 'pageerror', text: err?.message ?? String(err), source: page.url() });
            });
            page.on('request', (request) => {
                const entry = {
                    method: request.method(),
                    url: request.url(),
                    status: null,
                    kind: request.resourceType(),
                    ms: null,
                    failure: null,
                };
                this.requestEntries.set(request, { entry, startedAt: Date.now() });
                record('network', entry);
            });
            page.on('response', (response) => {
                const slot = this.requestEntries.get(response.request());
                if (slot === undefined)
                    return;
                slot.entry.status = response.status();
                slot.entry.ms = Date.now() - slot.startedAt;
                this.requestEntries.delete(response.request());
            });
            page.on('requestfailed', (request) => {
                const slot = this.requestEntries.get(request);
                if (slot === undefined)
                    return;
                slot.entry.ms = Date.now() - slot.startedAt;
                slot.entry.failure = request.failure()?.errorText ?? 'request failed';
                this.requestEntries.delete(request);
            });
        }
        catch {
            // Diagnostics are optional: a page that refuses hooks still works.
        }
    }
    /** Stable id for one page of this session (used to scope diagnostics). */
    pageIdFor(page) {
        const existing = this.pageIds.get(page);
        if (existing !== undefined)
            return existing;
        this.pageIdSeq += 1;
        this.pageIds.set(page, this.pageIdSeq);
        return this.pageIdSeq;
    }
    /** Id of the page this session is driving, or undefined when there is none. */
    currentPageId() {
        try {
            const page = this.pageAt(this.currentIndex);
            return page === undefined ? undefined : this.pageIdFor(page);
        }
        catch {
            return undefined;
        }
    }
    /**
     * Split diagnostics into "the page this session is driving" and "everything
     * else". The rings keep every page's entries so chronology and eviction stay
     * honest, but a reader that promises one tab must not serve another tab's
     * lines: that is how a model diagnoses an error that belongs to a page it is
     * not even looking at.
     */
    scopeToCurrentPage(entries) {
        const currentId = this.currentPageId();
        if (currentId === undefined)
            return { kept: entries.slice(), otherPages: 0 };
        const kept = [];
        let otherPages = 0;
        for (const entry of entries) {
            if (entry.page === currentId)
                kept.push(entry);
            else
                otherPages += 1;
        }
        return { kept, otherPages };
    }
    /** URL of the tab this session is driving right now, or null. */
    currentUrl() {
        try {
            return this.pageAt(this.currentIndex)?.url() ?? null;
        }
        catch {
            return null;
        }
    }
    /** Recent console messages and uncaught page errors, newest last. */
    consoleMessages(args) {
        const wanted = typeof args.level === 'string' && args.level.length > 0 ? args.level : 'all';
        const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? Math.max(1, Math.min(this.diagLimit, args.limit))
            : 50;
        const matches = (entry) => {
            if (wanted === 'all')
                return true;
            if (wanted === 'error')
                return entry.level === 'error' || entry.level === 'pageerror';
            if (wanted === 'warning')
                return entry.level === 'warning' || entry.level === 'warn';
            return entry.level === wanted;
        };
        const { kept, otherPages } = this.scopeToCurrentPage(this.consoleLog.filter(matches));
        return {
            url: this.currentUrl(),
            level: wanted,
            total: kept.length,
            returned: Math.min(limit, kept.length),
            dropped: this.diagDropped.console,
            otherPages,
            note: otherPages > 0
                ? 'Only the tab this session is driving is reported; ' +
                    String(otherPages) +
                    ' matching entries from other tabs of the same window are not shown.'
                : 'Capture starts when this session first drives a tab. In persistent mode every session shares one window; only the tab this session is driving is reported.',
            entries: kept.slice(-limit).map((entry) => ({
                n: entry.n,
                level: entry.level,
                text: (entry.text ?? '').slice(0, 400),
                source: String(entry.source).slice(0, 200),
            })),
        };
    }
    /** Recent network requests, newest last, with status and duration where known. */
    networkRequests(args) {
        const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? Math.max(1, Math.min(this.diagLimit, args.limit))
            : 50;
        const needle = typeof args.urlContains === 'string' ? args.urlContains.toLowerCase() : '';
        const failedOnly = args.failedOnly === true;
        let matching = this.networkLog;
        if (needle.length > 0)
            matching = matching.filter((entry) => (entry.url ?? '').toLowerCase().includes(needle));
        if (failedOnly)
            matching = matching.filter((entry) => entry.failure !== null || ((entry.status ?? null) !== null && (entry.status ?? 0) >= 400));
        const { kept, otherPages } = this.scopeToCurrentPage(matching);
        return {
            url: this.currentUrl(),
            total: kept.length,
            returned: Math.min(limit, kept.length),
            dropped: this.diagDropped.network,
            otherPages,
            note: otherPages > 0
                ? 'Only the tab this session is driving is reported; ' +
                    String(otherPages) +
                    ' matching requests from other tabs of the same window are not shown. Response bodies are not captured.'
                : 'Capture starts when this session first drives a tab. In persistent mode every session shares one window; only the tab this session is driving is reported. Response bodies are not captured.',
            entries: kept.slice(-limit).map((entry) => ({
                n: entry.n,
                method: entry.method,
                url: (entry.url ?? '').slice(0, 300),
                status: entry.status,
                kind: entry.kind,
                ms: entry.ms,
                failure: entry.failure,
            })),
        };
    }
    /**
     * Refuse page access while a native dialog blocks the page: every call
     * would otherwise stall until the action timeout. Only browser_dialog and
     * the blocked-snapshot report are allowed through (DIALOG-POLICY.md).
     */
    guardBlockedDialog(page) {
        if (this.bypassDialogGuard === true)
            return;
        const pending = this.provider.pendingDialogFor(page);
        if (pending !== undefined)
            throw new BrowserError('DIALOG_PENDING', this.provider.dialogNoteFor(pending));
    }
    /** Refuse context-wide tab work while any page in it has a parked dialog. */
    guardBlockedContext() {
        if (this.bypassDialogGuard === true)
            return;
        for (const page of this.context.pages()) {
            const pending = this.provider.pendingDialogFor(page);
            if (pending !== undefined)
                throw new BrowserError('DIALOG_PENDING', this.provider.dialogNoteFor(pending));
        }
    }
    /** Run one internal step with the dialog guard lifted. */
    async withDialogGuardLifted(fn) {
        this.bypassDialogGuard = true;
        try {
            return await fn();
        }
        finally {
            this.bypassDialogGuard = false;
        }
    }
    pageAt(index) {
        return this.context.pages()[index];
    }
    async refLocator(ref) {
        this.assertLive();
        if (!REF_PATTERN.test(ref)) {
            throw new BrowserError('REF_NOT_FOUND', 'invalid ref ' + JSON.stringify(ref) + ': use a ref from the latest browser_snapshot');
        }
        const locator = this.currentPageSync()
            .locator('[data-dsh-ref="' + ref + '"]')
            .first();
        // Fast-fail on stale refs (per-snapshot nonces make a reused number
        // impossible) instead of burning the full action timeout.
        if ((await locator.count()) === 0) {
            throw new BrowserError('REF_NOT_FOUND', 'ref ' +
                JSON.stringify(ref) +
                ' no longer matches an element; take a fresh browser_snapshot and use a ref from its result');
        }
        return locator;
    }
    currentPageSync() {
        const pages = this.context.pages();
        const page = pages[Math.min(this.currentIndex, Math.max(0, pages.length - 1))];
        if (page === undefined)
            throw new BrowserError('SESSION_CLOSED', 'the browser session has no open page');
        this.guardBlockedDialog(page);
        return page;
    }
    assertLive() {
        if (this.closed) {
            throw new BrowserError('SESSION_CLOSED', 'the browser session was closed via browser_close; the next browser call opens a fresh one');
        }
        if (!this.provider.isLive(this.owner)) {
            // The window went away without this session asking for it: idle
            // disposal, an external manual close, or a crash. Surface it as a
            // crash so the model retries — the next call relaunches with the
            // saved login state instead of reporting a misleading close.
            this.closed = true;
            throw new BrowserError('BROWSER_CRASHED', 'the browser window is no longer available (idle timeout, manual close, or a crash); the next browser call reopens it with the saved login state');
        }
    }
}
/** Whether an error is a caller-initiated abort, which must propagate untouched. */
function isAbortError(error) {
    return error instanceof DOMException && error.name === 'AbortError';
}
/** Whether a Playwright failure is a mid-evaluate navigation race. */
function isContextDestroyed(error) {
    return error instanceof Error && /Execution context was destroyed/.test(error.message);
}
/** Whether a failure means the browser or its page died and must be relaunched. */
function isCrashError(error) {
    if (!(error instanceof Error))
        return false;
    return /browser has disconnected|has been closed|Target closed|Target crashed|ProcessSingleton|Session closed|Cannot access object .* destroyed|The page .* was closed/i.test(error.message);
}
/**
 * Post-hover note. A hover proves nothing by itself: the call returning only
 * means the pointer moved. The cheap evidence that content appeared is how the
 * actionable ref count changed, so the note reports it and tells the model
 * what to do when nothing appeared (retarget the owner of the menu, never
 * retry the same hover, never fall back to raw coordinates).
 * @param target - description of what was hovered (a ref, or a quoted label).
 * @param refsBefore - actionable refs before the hover.
 * @param refsAfter - actionable refs in the returned snapshot.
 * @param navigated - whether the hover changed the page URL.
 */
function hoverNote(target, refsBefore, refsAfter, navigated) {
    const grew = refsAfter - refsBefore;
    if (navigated) {
        return ('hover on ' +
            target +
            ' triggered a navigation (' +
            refsBefore +
            ' refs before, ' +
            refsAfter +
            ' after) — a hover should not navigate: verify the new page before continuing');
    }
    if (grew > 0) {
        return ('hover delivered to ' +
            target +
            ': ' +
            refsBefore +
            ' refs before, ' +
            refsAfter +
            ' after (+' +
            grew +
            ') — hover-revealed content is in this snapshot; act on it next, because any other pointer action may close it (pre-hover refs are stale)');
    }
    return ('hover delivered to ' +
        target +
        ' but the page did not grow (' +
        refsBefore +
        ' refs before and after): if what you expected is still missing, THIS target does not reveal on hover — do NOT repeat this call and do NOT fall back to raw coordinates; hover the parent/container or the sibling that owns the menu instead, and if that reveals nothing either, hover is not implemented for this control');
}
/** Remove browser label stamps. Used via page.evaluate(clearLabelTargets). */
const clearLabelTargets = () => {
    for (const el of document.querySelectorAll('[data-dsh-label-target]'))
        el.removeAttribute('data-dsh-label-target');
};
/**
 * Page-side resolution for browser click/hover label mode: find the visible element
 * whose label (aria-label / alt / title / placeholder / own text) equals the
 * prefer the deepest match, stamp it with data-dsh-label-target, and describe
 * it so the landing note can name what was actually hovered. Runs inside the
 * page; used via page.evaluate(labelTargetProbe, { text }).
 */
const labelTargetProbe = (arg) => {
    const wanted = String(arg.text).replace(/\s+/g, ' ').trim();
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const ownText = (el) => {
        let out = '';
        for (const node of el.childNodes) {
            if (node.nodeType === 3)
                out += node.textContent;
            else if (node.nodeType === 1 && node.tagName.toLowerCase() === 'br')
                out += ' ';
        }
        return norm(out);
    };
    // Mirror the snapshot's name sources, so anything the page shows under a
    // name can be addressed by that name: aria-label / alt / title / placeholder
    // first, then the element's own visible text.
    const labelOf = (el) => {
        const attr = (name) => {
            const v = el.getAttribute(name);
            return v && v.trim() ? v : '';
        };
        return (norm(attr('aria-label')) || norm(attr('alt')) || norm(attr('title')) || norm(attr('placeholder')) || ownText(el));
    };
    const visible = (el) => {
        if (!(el instanceof Element))
            return false;
        if (el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true')
            return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden')
            return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 || rect.height > 0;
    };
    const depthOf = (el) => {
        let depth = 0;
        let cur = el;
        while (cur !== null && cur.parentElement !== null) {
            depth += 1;
            cur = cur.parentElement;
        }
        return depth;
    };
    const root = document.body !== null && document.body !== undefined ? document.body : document.documentElement;
    const all = Array.from(root.querySelectorAll('*')).slice(0, 8000).filter(visible);
    let pool = all.filter((el) => labelOf(el) === wanted);
    let exact = true;
    if (pool.length === 0) {
        exact = false;
        pool = all.filter((el) => ownText(el).indexOf(wanted) !== -1 || labelOf(el).indexOf(wanted) !== -1);
    }
    if (pool.length === 0)
        return { found: false, total: 0 };
    pool.sort((a, b) => depthOf(b) - depthOf(a));
    const picked = pool[0];
    if (picked === undefined)
        return { found: false, total: pool.length };
    for (const el of document.querySelectorAll('[data-dsh-label-target]'))
        el.removeAttribute('data-dsh-label-target');
    const token = 'ht' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    try {
        picked.setAttribute('data-dsh-label-target', token);
    }
    catch (_) {
        return { found: false, total: pool.length };
    }
    const cls = typeof picked.className === 'string' && picked.className.trim() !== ''
        ? '.' + picked.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
    return {
        found: true,
        token,
        desc: picked.tagName.toLowerCase() + (picked.id ? '#' + picked.id : '') + cls,
        total: pool.length,
        exact,
    };
};
/**
 * Element-side bounded stability probe (Codex-style): samples the element's
 * boundingClientRect every animation frame; resolves true once it repeats for
 * `frames` consecutive frames, false after `timeoutMs`. Never hangs: the cap
 * always resolves. Used via locator.evaluate(elementStabilityProbe, arg).
 */
const elementStabilityProbe = (el, arg) => new Promise((resolve) => {
    const frames = arg.frames;
    const timeoutMs = arg.timeoutMs;
    const deadline = performance.now() + timeoutMs;
    let prev = null;
    let stable = 0;
    const sig = () => {
        const r = el.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height].join(',');
    };
    const tick = () => {
        const cur = sig();
        if (prev !== null && cur === prev) {
            stable += 1;
            if (stable >= frames) {
                resolve(true);
                return;
            }
        }
        else {
            stable = 0;
        }
        prev = cur;
        if (performance.now() >= deadline) {
            resolve(false);
            return;
        }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
});
/**
 * Page-side bounded stability probe: samples layout size + pending images +
 * readyState. Used via page.evaluate(pageStabilityProbe, arg). The returned
 * "false on timeout" is intentional: a busy page must not stall the agent.
 */
const pageStabilityProbe = (arg) => new Promise((resolve) => {
    const frames = arg.frames;
    const timeoutMs = arg.timeoutMs;
    const deadline = performance.now() + timeoutMs;
    let prev = null;
    let stable = 0;
    const sig = () => {
        const de = document.documentElement;
        return [de.scrollWidth, de.scrollHeight, document.querySelectorAll('img:not([complete])').length].join(',');
    };
    const tick = () => {
        const cur = sig();
        if (prev !== null && cur === prev) {
            stable += 1;
            if (stable >= frames) {
                resolve(true);
                return;
            }
        }
        else {
            stable = 0;
        }
        prev = cur;
        if (performance.now() >= deadline) {
            resolve(false);
            return;
        }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
});
