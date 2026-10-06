/**
 * 页面动作的公共管道：可中断等待，以及 hover 结果的措辞。
 * @module dsh-browser-playwright-codex/page-actions
 */
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
