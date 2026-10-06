import { BrowserError } from "./errors.js";
import { assertAllowedUrl } from "./url-policy.js";
import { asTimeoutError, isAbortError } from "./page-diagnostics.js";
import { clearLabelTargets, labelTargetProbe } from "./page-probes.js";
import { createBackgroundPage, isWindowMinimized } from "./browser-lifecycle.js";
/** Wrap a Playwright op so an aborted signal rejects while the op keeps draining in the background. */
export async function withAbort(promise, signal) {
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
export function hoverNote(target, refsBefore, refsAfter, navigated) {
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
/** Fast actionability pre-check (visible/enabled/editable) before an action. */
export async function assertActionable(session, locator, options = {}) {
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
/**
 * Run one page action that may raise a native dialog. Such an action never
 * resolves while the dialog is up, so race it against the dialog appearing
 * and hand the caller the pending state instead (Playwright-MCP pattern).
 */
export async function runAction(session, page, action) {
    const already = session.provider.pendingDialogFor(page);
    if (already !== undefined)
        return { blocked: true, pending: already };
    const wait = session.provider.armDialogWait(page);
    const outcome = action().then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
    const winner = await Promise.race([outcome, wait.promise]);
    wait.cancel();
    if (winner === true)
        return { blocked: true, pending: session.provider.pendingDialogFor(page) };
    if (winner.ok !== true)
        throw winner.error;
    return { blocked: false, value: winner.value };
}
export async function navigate(session, url, waitUntil, signal) {
    return session.run(async () => {
        const target = assertAllowedUrl(url, session.provider.config.allowedDomains ?? []);
        const page = await session.ensurePage();
        try {
            const racedNav = await session.runAction(page, () => withAbort(page.goto(target.toString(), { waitUntil, timeout: session.timeoutMs() }), signal));
            if (racedNav.blocked)
                return session.blockedSnapshot(page, racedNav.pending);
        }
        catch (error) {
            if (isAbortError(error) || signal?.aborted === true)
                throw error;
            throw asTimeoutError('navigation', error);
        }
        return session.settleAndSnapshot(page, true);
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
export async function resolveClickPoint(session, locator, signal) {
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
        // Describe the hit inline, as a string: session function is serialized into the
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
    // 2026-10-05: the first version of session loop dropped the probe's reason on the
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
                await session.waitForElementStable(locator);
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
/**
 * Click an element the snapshot gave no ref, addressed by its visible label
 * (e.g. a menu item revealed by browser_hover that is plain text). The
 * label must equal an element's own direct text; the deepest match wins,
 * and the landing note names what was actually clicked plus how many
 * elements shared the label.
 */
export async function clickText(session, text, signal) {
    return session.run(async () => {
        const page = session.currentPageSync();
        const found = await page.evaluate(labelTargetProbe, { text: String(text) }).catch(() => null);
        if (found === null || found.found !== true) {
            throw new BrowserError('CLICK_TARGET_NOT_FOUND', 'no visible element on session page has the label ' +
                JSON.stringify(text) +
                '; take a browser_snapshot and copy the label exactly as it is shown there, or click by ref');
        }
        const locator = page.locator('[data-dsh-label-target="' + found.token + '"]').first();
        try {
            return await session.clickLocator(locator, signal, JSON.stringify(text) + ' (' + found.desc + ')', found.total);
        }
        finally {
            // The stamp is only a locator handle: clear it once the click
            // has been delivered so no residue is left in the page. While a
            // dialog blocks the page session evaluate would hang, so skip it.
            if (session.provider.pendingDialogFor(page) === undefined)
                await page.evaluate(clearLabelTargets).catch(() => { });
        }
    });
}
/**
 * Shared click core: enforce the URL policy for link targets, run the
 * Codex-style geometry ladder with the Playwright actionability fallback,
 * then report what actually received the click. The label names the target
 * in the landing note; shared is how many elements matched it (0 for refs).
 */
export async function clickLocator(session, locator, signal, label, shared) {
    session.assertClickTargetAllowed(await locator.getAttribute('href'));
    const page = session.currentPageSync();
    const urlBefore = page.url();
    let point;
    try {
        // Codex-style geometry pipeline first: alignment ladder →
        // stable rect → centre point → elementFromPoint hit-test.
        point = await session.resolveClickPoint(locator, signal);
    }
    catch (error) {
        if (isAbortError(error))
            throw error;
        if (error instanceof BrowserError) {
            // Ladder exhausted: let Playwright's own actionability
            // machinery retry (it waits for transient overlays to
            // disappear) and surface its verdict before ours.
            try {
                const racedFallback = await session.runAction(page, () => withAbort(locator.click({ timeout: Math.min(session.timeoutMs(), 3000) }), signal));
                if (racedFallback.blocked)
                    return session.blockedSnapshot(page, racedFallback.pending);
                const snap = await session.settleAndSnapshot(page, page.url() !== urlBefore);
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
        raced = await session.runAction(page, () => withAbort(page.mouse.click(point.x, point.y), signal));
    }
    catch (error) {
        if (isAbortError(error))
            throw error;
        throw asTimeoutError('action', error);
    }
    if (raced.blocked)
        return session.blockedSnapshot(page, raced.pending);
    const snap = await session.settleAndSnapshot(page, page.url() !== urlBefore);
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
export async function clickAt(session, x, y, signal) {
    return session.run(async () => {
        const page = session.currentPageSync();
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
        session.assertClickTargetAllowed(probe === null ? null : probe.linkHref);
        let racedAt = { blocked: false };
        try {
            // Raw native click by viewport coordinates (CDP Input
            // dispatch, isTrusted=true — indistinguishable from a human
            // click). No ref lookup, no visibility/actionability gate:
            // the escape hatch for elements the snapshot tree cannot
            // represent or stubborn rows that refuse ref-based clicks.
            racedAt = await session.runAction(page, () => withAbort(page.mouse.click(x, y), signal));
        }
        catch (error) {
            if (isAbortError(error))
                throw error;
            throw asTimeoutError('action', error);
        }
        if (racedAt.blocked)
            return session.blockedSnapshot(page, racedAt.pending);
        const snap = await session.settleAndSnapshot(page, page.url() !== urlBefore);
        snap.landingNote = 'raw click delivered at (' + x + ',' + y + ') — that point held: ' + hitDesc;
        return snap;
    });
}
export async function clickAtRef(session, ref, signal) {
    return session.run(async () => {
        const locator = await session.refLocator(ref);
        const page = session.currentPageSync();
        const urlBefore = page.url();
        // Ref mode resolves the element before clicking, so the link policy can
        // be enforced up front — the same rule browser_click applies.
        session.assertClickTargetAllowed(await locator.getAttribute('href'));
        try {
            // Codex-style geometry click with obstruction awareness:
            // scroll (centre → end → start), wait for the bounding rect to
            // stop moving, then click the RECT CENTRE computed in-page —
            // no screenshot measurement, no devicePixelRatio guesswork,
            // sub-pixel exact. Before committing, hit-test the point so an
            // overlay can never swallow the click silently; if something
            // intercepts, realign and retry up to the alignment ladder.
            const point = await session.resolveClickPoint(locator, signal);
            const racedRef = await session.runAction(page, () => withAbort(page.mouse.click(point.x, point.y), signal));
            if (racedRef.blocked)
                return session.blockedSnapshot(page, racedRef.pending);
            const snap = await session.settleAndSnapshot(page, page.url() !== urlBefore);
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
                        const snap = await session.settleAndSnapshot(page, page.url() !== urlBefore);
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
export async function fill(session, ref, text, signal) {
    return session.run(async () => {
        const locator = await session.refLocator(ref);
        const page = session.currentPageSync();
        await session.waitForElementStable(locator);
        await session.assertActionable(locator, { editable: true });
        const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => 'input');
        let lastError;
        let written = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                if (tag === 'select') {
                    await withAbort(locator.selectOption({ label: text }, { timeout: session.timeoutMs() }), signal);
                }
                else {
                    await withAbort(locator.fill(text, { timeout: session.timeoutMs() }), signal);
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
            written = await session.verifyFill(locator, tag, text);
            if (written)
                break;
        }
        if (!written) {
            const detail = lastError instanceof Error ? lastError.message : '';
            throw new BrowserError('VALUE_NOT_SET', 'the fill did not stick after 2 attempts — the value was not written to the field' +
                (detail ? ': ' + detail : ''));
        }
        return session.settleAndSnapshot(page, false);
    });
}
/** Read the field back and decide whether the fill landed. */
export async function verifyFill(session, locator, tag, text) {
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
export async function press(session, ref, key, signal) {
    return session.run(async () => {
        const locator = await session.refLocator(ref);
        const page = session.currentPageSync();
        await session.waitForElementStable(locator);
        const urlBefore = page.url();
        try {
            const racedPress = await session.runAction(page, () => withAbort(locator.press(key, { timeout: session.timeoutMs() }), signal));
            if (racedPress.blocked)
                return session.blockedSnapshot(page, racedPress.pending);
        }
        catch (error) {
            if (isAbortError(error))
                throw error;
            throw asTimeoutError('action', error);
        }
        return session.settleAndSnapshot(page, page.url() !== urlBefore);
    });
}
/**
 * Hover a trigger the snapshot gave no ref, addressed by its visible label
 * (e.g. a plain span that reveals a menu on mouseenter). The label must
 * equal an element's own direct text; the deepest match wins, and the
 * landing note names what was hovered plus how many elements shared it.
 */
export async function hoverText(session, text, signal) {
    return session.run(async () => {
        const page = session.currentPageSync();
        const found = await page.evaluate(labelTargetProbe, { text: String(text) }).catch(() => null);
        if (found === null || found.found !== true) {
            throw new BrowserError('HOVER_TARGET_NOT_FOUND', 'no visible element on session page has the label ' +
                JSON.stringify(text) +
                '; take a browser_snapshot and copy the label exactly as it is shown there, or hover by ref');
        }
        const locator = page.locator('[data-dsh-label-target="' + found.token + '"]').first();
        try {
            return await session.hoverLocator(locator, signal, JSON.stringify(text) + ' (' + found.desc + ')', found.total);
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
export async function hoverLocator(session, locator, signal, label, shared) {
    await session.assertActionable(locator);
    const page = session.currentPageSync();
    await session.waitForElementStable(locator);
    const urlBefore = page.url();
    const before = await session.capture(page, undefined);
    try {
        await withAbort(locator.hover({ timeout: session.timeoutMs() }), signal);
    }
    catch (error) {
        if (isAbortError(error))
            throw error;
        throw asTimeoutError('action', error);
    }
    const navigated = page.url() !== urlBefore;
    const snap = await session.settleAndSnapshot(page, navigated);
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
export async function scroll(session, direction, amount, ref, signal) {
    return session.run(async () => {
        const page = await session.ensurePage();
        try {
            if (ref !== undefined) {
                await withAbort((await session.refLocator(ref)).scrollIntoViewIfNeeded({ timeout: session.timeoutMs() }), signal);
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
        await session.waitForPageStable(page, 1200);
        return session.capture(page, undefined);
    });
}
export async function back(session, signal) {
    return session.run(async () => {
        const page = await session.ensurePage();
        try {
            await withAbort(page.goBack({ timeout: session.timeoutMs() }), signal);
        }
        catch (error) {
            if (isAbortError(error))
                throw error;
            throw asTimeoutError('navigation', error);
        }
        return session.settleAndSnapshot(page, true);
    });
}
export async function forward(session, signal) {
    return session.run(async () => {
        const page = await session.ensurePage();
        try {
            await withAbort(page.goForward({ timeout: session.timeoutMs() }), signal);
        }
        catch (error) {
            if (isAbortError(error))
                throw error;
            throw asTimeoutError('navigation', error);
        }
        return session.settleAndSnapshot(page, true);
    });
}
export async function switchTab(session, index, signal) {
    return session.run(async () => {
        session.assertLive();
        session.guardBlockedContext();
        const page = session.pageAt(index);
        if (page === undefined)
            throw new BrowserError('REF_NOT_FOUND', 'no tab at index ' + String(index));
        // Switching is the only way session session starts driving a tab it did not
        // open itself, so the host policy is applied here: a page-opened tab
        // outside the allow-list cannot be reached. The refusal happens before
        // currentIndex moves, so the session stays on the tab it was driving.
        session.assertTabAllowed(page);
        session.currentIndex = index;
        // A minimized window stays minimized: switching tabs is a
        // context-level operation that needs no OS window activation.
        if (!(await isWindowMinimized(page)))
            await withAbort(page.bringToFront(), signal);
        return session.snapshot();
    });
}
export async function openTab(session, url, waitUntil, signal) {
    return session.run(async () => {
        session.assertLive();
        session.guardBlockedContext();
        const target = assertAllowedUrl(url, session.provider.config.allowedDomains ?? []);
        // Background creation: a new tab must not yank a minimized window
        // into the user's face (see createBackgroundPage).
        const page = await createBackgroundPage(session.context);
        const index = session.context.pages().indexOf(page);
        session.currentIndex = index >= 0 ? index : session.context.pages().length - 1;
        session.provider.armDialogGuard(page);
        // Track before the first navigation. Attaching the console/network
        // listeners any later loses the requests that brought the tab into
        // existence, so an opened tab looked silent from its very first load.
        session.trackPage(page);
        try {
            await withAbort(page.goto(target.toString(), { waitUntil, timeout: session.timeoutMs() }), signal);
        }
        catch (error) {
            if (isAbortError(error))
                throw error;
            throw asTimeoutError('navigation', error);
        }
        return session.settleAndSnapshot(page, true);
    });
}
export async function closeTab(session, index, signal) {
    return session.run(async () => {
        session.assertLive();
        session.guardBlockedContext();
        const pages = session.context.pages();
        const page = pages[index];
        if (page === undefined)
            throw new BrowserError('REF_NOT_FOUND', 'no tab at index ' + String(index));
        if (pages.length <= 1) {
            await withAbort(page.goto('about:blank'), signal);
            return;
        }
        await withAbort(page.close(), signal);
        session.currentIndex = Math.min(session.currentIndex, session.context.pages().length - 1);
    });
}
