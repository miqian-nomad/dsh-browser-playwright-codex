import { captureAriaSnapshot } from "./snapshot-aria.js";
import { isContextDestroyed } from "./page-diagnostics.js";
import { REF_PATTERN } from "./config.js";
import { BrowserError } from "./errors.js";
import { getSnapshotEngine } from "./runtime-state.js";
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
/** Feature flags carried by an added diff entry. */
export function flagsOf(sig) {
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
export function flagsDeltaOf(before, after) {
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
export function diffEntry(input) {
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
/** Post-action settle: wait out a real navigation, then render-stabilize before snapshotting. */
export async function settleAndSnapshot(session, page, navChanged) {
    // Race the settle+capture against a fresh dialog: a chained dialog
    // (one raised the moment the previous was answered) would block
    // page.evaluate forever and hang session call.
    const raced = await session.runAction(page, async () => {
        if (navChanged) {
            await page.waitForLoadState('load', { timeout: session.timeoutMs() }).catch(() => { });
        }
        await session.waitForPageStable(page, navChanged ? 1500 : 800);
        return await session.capture(page, undefined);
    });
    if (raced.blocked)
        return session.blockedSnapshot(page, raced.pending);
    return raced.value;
}
/**
 * Semantic-tree capture via Playwright's official ariaSnapshot(mode:'ai').
 * An unavailable or unreadable aria tree (`missing`) degrades to the legacy
 * DOM walker instead of returning an empty snapshot: the model must never
 * receive "the page has no elements" because the engine failed to parse.
 */
export async function captureAria(session, page, opts) {
    const o = {
        interactiveOnly: opts?.interactiveOnly === true,
        maxNodes: session.provider.config.snapshot.maxNodes,
        maxNameLength: session.provider.config.snapshot.maxNameLength,
        maxTextLength: session.provider.config.snapshot.maxTextLength,
    };
    let raw;
    try {
        raw = await captureAriaSnapshot(page, o);
    }
    catch (error) {
        // Same mid-evaluate navigation race as the legacy path: settle once and retry.
        if (!isContextDestroyed(error))
            throw error;
        await session.settleNavigation(page);
        raw = await captureAriaSnapshot(page, o);
    }
    if (raw.missing === true) {
        // Degrade honestly: the tree below is the compatible engine's, and the
        // snapshot says so. Silence here is how a user who explicitly picked smart
        // mode keeps believing smart mode is what they are reading.
        const legacy = await session.captureLegacy(page, opts);
        return {
            ...legacy,
            engineNote: 'smart mode could not read session page, so it was rendered with the compatible engine. ' +
                'The refs below belong to the compatible engine. Nothing is wrong with the page; ' +
                'switch the page-reading mode in Settings if you want to stop seeing session.',
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
export async function captureLegacy(session, page, opts) {
    const o = {
        ...(opts?.interactiveOnly !== undefined ? { interactiveOnly: opts.interactiveOnly } : {}),
        maxNodes: session.provider.config.snapshot.maxNodes,
        maxNameLength: session.provider.config.snapshot.maxNameLength,
        maxTextLength: session.provider.config.snapshot.maxTextLength,
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
        await session.settleNavigation(page);
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
export function attachDiff(session, snap) {
    if (session.provider.config.snapshot.diff !== true) {
        session.lastRefSignatures = undefined;
        session.lastRefNonce = undefined;
        return snap;
    }
    const sigs = session.buildRefSignatures(snap.nodes);
    const nonce = session.refNonce(snap.nodes);
    const base = session.lastRefSignatures;
    const baseNonce = session.lastRefNonce;
    session.lastRefSignatures = sigs;
    session.lastRefNonce = nonce;
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
export function buildRefSignatures(session, nodes) {
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
export async function snapshot(session, opts) {
    return session.run(async () => {
        session.assertLive();
        const page = await session.withDialogGuardLifted(() => session.ensurePage());
        session.provider.touch(session.owner);
        // A parked dialog blocks the page: never round-trip into it.
        const pending = session.provider.pendingDialogFor(page);
        if (pending !== undefined)
            return session.blockedSnapshot(page, pending);
        const racedSnap = await session.runAction(page, async () => {
            await session.waitForPageStable(page, 400);
            return await session.capture(page, opts);
        });
        if (racedSnap.blocked)
            return session.blockedSnapshot(page, racedSnap.pending);
        return racedSnap.value;
    });
}
export async function refLocator(session, ref) {
    session.assertLive();
    if (!REF_PATTERN.test(ref)) {
        throw new BrowserError('REF_NOT_FOUND', 'invalid ref ' + JSON.stringify(ref) + ': use a ref from the latest browser_snapshot');
    }
    const locator = session
        .currentPageSync()
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
export function assertLive(session) {
    if (session.closed) {
        throw new BrowserError('SESSION_CLOSED', 'the browser session was closed via browser_close; the next browser call opens a fresh one');
    }
    if (!session.provider.isLive(session.owner)) {
        // The window went away without session session asking for it: idle
        // disposal, an external manual close, or a crash. Surface it as a
        // crash so the model retries — the next call relaunches with the
        // saved login state instead of reporting a misleading close.
        session.closed = true;
        throw new BrowserError('BROWSER_CRASHED', 'the browser window is no longer available (idle timeout, manual close, or a crash); the next browser call reopens it with the saved login state');
    }
}
