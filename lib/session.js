import { BrowserError } from "./errors.js";
import { asTimeoutError, isAbortError, isContextDestroyed, isCrashError } from "./page-diagnostics.js";
import { clearLabelTargets, elementStabilityProbe, labelTargetProbe, pageStabilityProbe } from "./page-probes.js";
import { hoverNote, withAbort } from "./page-actions.js";
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
            const w = r.width;
            const h = r.height;
            const geometry = 'rect ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(w) + 'x' + Math.round(h);
            if (w <= 0 || h <= 0)
                return { ok: false, reason: 'zero-size', x: r.left, y: r.top, geometry };
            // The probe must sit inside the element AND inside the viewport:
            // elementFromPoint() answers null for coordinates outside the viewport, so
            // sampling the element's own centre missed any target taller than the viewport
            // (or one whose centre was below the fold) even when most of it was plainly
            // clickable. Aim at the centre of the visible intersection instead.
            const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
            const left = Math.max(r.left, 0);
            const top = Math.max(r.top, 0);
            const right = Math.min(r.right, view.innerWidth);
            const bottom = Math.min(r.bottom, view.innerHeight);
            if (right - left <= 0 || bottom - top <= 0) {
                return {
                    ok: false,
                    reason: 'off-screen',
                    x: r.left,
                    y: r.top,
                    geometry: geometry + ' viewport ' + view.innerWidth + 'x' + view.innerHeight,
                };
            }
            const x = (left + right) / 2;
            const y = (top + bottom) / 2;
            let hit = null;
            try {
                hit = document.elementFromPoint(x, y);
            }
            catch {
                hit = null;
            }
            if (!hit)
                return { ok: false, reason: 'nothing-at-point', x, y, geometry };
            // Describe the hit inline, as a string: this function is serialized into the
            // page, so it must be self-contained. A transpiler that keeps function names
            // (esbuild/tsx, through its `__name` helper) rewrites a named inner binding
            // like `const describe = (…) => …` into a call to a helper that exists only in
            // module scope — and the page has no such helper, so the probe would throw
            // ReferenceError and every click would silently fall back to Playwright's
            // actionability click (3s cap). That is what made the Windows runner flaky
            // until 2026-10-05; the test runner now strips types natively, and keeping the
            // probe free of inner function bindings protects anyone who transpiles src/.
            const hitDesc = (hit.tagName ? hit.tagName.toLowerCase() : hit.nodeName) +
                (hit.id ? '#' + hit.id : '') +
                (typeof hit.className === 'string' && hit.className.trim()
                    ? '.' + hit.className.trim().split(/\s+/).filter(Boolean).join('.')
                    : '') +
                (hit.getAttribute && hit.getAttribute('role') ? '[role=' + hit.getAttribute('role') + ']' : '') +
                (hit.childElementCount === 0 && hit.textContent ? ' "' + hit.textContent.trim().slice(0, 24) + '"' : '');
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
                ? { ok: true, x, y, hitDesc, hitSelf: hit === el }
                : { ok: false, reason: 'intercepted', x, y, by: hitDesc, geometry };
        };
        let lastBlockedBy;
        let lastReason;
        let lastGeometry;
        /** Message from the most recent probe that threw, so the failure names its cause. */
        let probeError;
        // 2026-10-05: the first version of this loop dropped the probe's reason on the
        // floor — the guard below read `lastReason === null` while the variable started
        // as `undefined`, so it never ran and every transient miss came out as "could not
        // find an unobstructed click point" with nothing to act on. That message is what
        // the slower Windows runner produced while ubuntu and local runs passed, and it
        // cost a debugging session to learn what it actually meant. Record the reason and
        // keep the most informative one.
        const rank = {
            intercepted: 5,
            'zero-size': 4,
            'off-screen': 3,
            'nothing-at-point': 2,
            unreachable: 1,
        };
        const record = (reason, geometry) => {
            if (lastReason === undefined || (rank[reason] ?? 0) > (rank[lastReason] ?? 0)) {
                lastReason = reason;
                lastGeometry = geometry;
            }
        };
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
            // Sample a few times per alignment: a page that is still laying out can move the
            // element between the scroll and the probe, and the first sample then misses even
            // though a later one is fine. Retries are bounded and cheap — the stability wait
            // only runs before the first sample, and the extra samples are 60ms apart.
            for (let attempt = 0; attempt < 3; attempt += 1) {
                if (attempt === 0)
                    await this.waitForElementStable(locator);
                else
                    await new Promise((resolve) => setTimeout(resolve, 60));
                const probe = await withAbort(locator.evaluate(hitTest), signal).catch((error) => {
                    // Keep the message. "unreachable" on its own told nobody anything, and
                    // swallowing the error here is exactly what let a broken probe look like an
                    // obstructed element for a whole debugging session.
                    probeError = error instanceof Error ? error.message : String(error);
                    return null;
                });
                if (probe !== null && probe.ok)
                    return { x: probe.x, y: probe.y, hitDesc: probe.hitDesc, hitSelf: probe.hitSelf };
                if (probe === null)
                    record('unreachable', probeError);
                else {
                    record(probe.reason, probe.geometry);
                    if (probe.reason === 'intercepted')
                        lastBlockedBy = probe.by;
                }
                // Interception is a property of the page, not of the moment: re-sampling cannot
                // clear it, so spend the remaining budget on the next alignment instead.
                if (probe !== null && probe.reason === 'intercepted')
                    break;
            }
        }
        if (lastReason === 'intercepted') {
            throw new BrowserError('ELEMENT_NOT_ACTIONABLE', 'the element does not receive pointer events at its centre: ' +
                (lastBlockedBy || 'another element') +
                ' intercepts the click (tried centre / end / start alignment)');
        }
        if (lastReason === 'off-screen') {
            throw new BrowserError('ELEMENT_NOT_ACTIONABLE', 'the element is outside the viewport even after scrolling it into view; nothing of it is on screen' +
                (lastGeometry === undefined ? '' : ' (' + lastGeometry + ')') +
                '; take a fresh browser_snapshot');
        }
        if (lastReason === 'zero-size') {
            throw new BrowserError('ELEMENT_NOT_ACTIONABLE', 'ref has no clickable geometry (zero size); take a fresh browser_snapshot');
        }
        throw new BrowserError('ELEMENT_NOT_ACTIONABLE', 'could not find an unobstructed click point for the ref (last probe: ' +
            (lastReason ?? 'no probe completed') +
            (lastGeometry === undefined ? '' : ' — ' + lastGeometry) +
            '); take a fresh browser_snapshot');
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
