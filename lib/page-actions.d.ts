/**
 * 页面动作的公共管道：可中断等待，以及 hover 结果的措辞。
 * @module dsh-browser-playwright-codex/page-actions
 */
/** Wrap a Playwright op so an aborted signal rejects while the op keeps draining in the background. */
export declare function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T>;
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
export declare function hoverNote(target: string, refsBefore: number, refsAfter: number, navigated: boolean): string;
