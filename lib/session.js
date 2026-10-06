import { BrowserError } from "./errors.js";
import { asTimeoutError, isAbortError, isContextDestroyed, isCrashError } from "./page-diagnostics.js";
import { consoleMessages, networkRequests, pageData, trackPage } from "./page-diagnostics.js";
import { clearLabelTargets, elementStabilityProbe, labelTargetProbe, pageStabilityProbe } from "./page-probes.js";
import { assertActionable, back, clickAt, clickAtRef, clickLocator, clickText, closeTab, fill, forward, hoverLocator, hoverNote, hoverText, navigate, openTab, press, resolveClickPoint, runAction, scroll, switchTab, verifyFill, withAbort, } from "./page-actions.js";
import { diffEntry, flagsDeltaOf, flagsOf, resolveSnapshotEngine } from "./page-snapshot.js";
import { captureAriaSnapshot } from "./snapshot-aria.js";
import { assertAllowedUrl } from "./url-policy.js";
import { createBackgroundPage, isWindowMinimized } from "./browser-lifecycle.js";
import { REF_PATTERN } from "./config.js";
/** Live session over one browser context owned by one caller. */
export class PlaywrightSession {
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
        return assertActionable(this, locator, options);
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
        return runAction(this, page, action);
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
        return navigate(this, url, waitUntil, signal);
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
        return resolveClickPoint(this, locator, signal);
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
        return clickText(this, text, signal);
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
        return clickLocator(this, locator, signal, label, shared);
    }
    async clickAt(x, y, signal) {
        return clickAt(this, x, y, signal);
    }
    async clickAtRef(ref, signal) {
        return clickAtRef(this, ref, signal);
    }
    async fill(ref, text, signal) {
        return fill(this, ref, text, signal);
    }
    /** Read the field back and decide whether the fill landed. */
    async verifyFill(locator, tag, text) {
        return verifyFill(this, locator, tag, text);
    }
    async press(ref, key, signal) {
        return press(this, ref, key, signal);
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
        return hoverText(this, text, signal);
    }
    /**
     * Shared hover core: rest the pointer on a resolved locator, then report
     * what the actionable ref count did. The label names the target in the
     * landing note; shared is how many elements matched that label (0 when the
     * target came from a ref).
     */
    async hoverLocator(locator, signal, label, shared) {
        return hoverLocator(this, locator, signal, label, shared);
    }
    async scroll(direction, amount, ref, signal) {
        return scroll(this, direction, amount, ref, signal);
    }
    async back(signal) {
        return back(this, signal);
    }
    async forward(signal) {
        return forward(this, signal);
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
        return switchTab(this, index, signal);
    }
    async openTab(url, waitUntil, signal) {
        return openTab(this, url, waitUntil, signal);
    }
    async closeTab(index, signal) {
        return closeTab(this, index, signal);
    }
    /**
     * Screenshots get their own floor instead of reusing the navigation budget: a
     * full-page capture is sized by the page and encoded by the CPU, so a loaded machine
     * legitimately needs seconds (2026-10-05: the Windows runner blew through the 2500ms
     * navigation timeout while encoding a full-page PNG — a slow runner, not a defect).
     * The floor only bounds failures; a capture that is ready returns immediately.
     */
    screenshotTimeoutMs() {
        return Math.max(this.timeoutMs(), 10_000);
    }
    async screenshot(opts, signal) {
        return this.run(async () => {
            this.assertLive();
            this.provider.touch(this.owner);
            const page = await this.ensurePage();
            if (opts?.ref !== undefined) {
                const bytes = await withAbort((await this.refLocator(opts.ref)).screenshot({ type: 'png', timeout: this.screenshotTimeoutMs() }), signal);
                return { mime: 'image/png', bytes };
            }
            const bytes = await withAbort(page.screenshot({
                type: 'png',
                fullPage: opts?.fullPage ?? false,
                animations: 'disabled',
                caret: 'hide',
                timeout: this.screenshotTimeoutMs(),
            }), signal);
            return { mime: 'image/png', bytes };
        });
    }
    async pageData() {
        return pageData(this);
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
        return trackPage(this, page);
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
        return consoleMessages(this, args);
    }
    /** Recent network requests, newest last, with status and duration where known. */
    networkRequests(args) {
        return networkRequests(this, args);
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
