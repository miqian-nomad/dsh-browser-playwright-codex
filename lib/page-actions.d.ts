import type { Locator, Page } from 'playwright-core';
import type { PlaywrightSession } from './session.ts';
import type { ActionResult } from './provider.ts';
import type { LoadState } from './types.ts';
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
/** Fast actionability pre-check (visible/enabled/editable) before an action. */
export declare function assertActionable(_session: PlaywrightSession, locator: Locator, options?: {
    editable?: boolean;
}): Promise<void>;
/**
 * Run one page action that may raise a native dialog. Such an action never
 * resolves while the dialog is up, so race it against the dialog appearing
 * and hand the caller the pending state instead (Playwright-MCP pattern).
 */
export declare function runAction(session: PlaywrightSession, page: Page, action: () => Promise<unknown>): Promise<ActionResult>;
export declare function navigate(session: PlaywrightSession, url: string, waitUntil: LoadState, signal: AbortSignal | undefined): Promise<import("./types.ts").BrowserSnapshot | {
    url: string;
    title: string;
    nodes: never[];
    totalRefs: number;
    truncated: boolean;
    dialogNote: string;
}>;
/**
 * Codex-style click-point resolution. Tries a scroll-alignment ladder
 * (centre, then end, then start). For each alignment: scroll the element
 * into view with a native scrollIntoView, wait for its bounding rect to
 * stop moving, sample the rect centre in-page (sub-pixel, no screenshot
 * measurement), then hit-test that exact point with elementFromPoint — so
 * an overlaying element can never swallow the click silently. Returns the
 * first unobstructed {x, y}, or throws describing what intercepted it.
 */
export declare function resolveClickPoint(session: PlaywrightSession, locator: Locator, signal: AbortSignal | undefined): Promise<{
    x: number;
    y: number;
    hitDesc: string;
    hitSelf: boolean;
}>;
/**
 * Click an element the snapshot gave no ref, addressed by its visible label
 * (e.g. a menu item revealed by browser_hover that is plain text). The
 * label must equal an element's own direct text; the deepest match wins,
 * and the landing note names what was actually clicked plus how many
 * elements shared the label.
 */
export declare function clickText(session: PlaywrightSession, text: string, signal: AbortSignal | undefined): Promise<import("./types.ts").BrowserSnapshot | {
    url: string;
    title: string;
    nodes: never[];
    totalRefs: number;
    truncated: boolean;
    dialogNote: string;
}>;
/**
 * Shared click core: enforce the URL policy for link targets, run the
 * Codex-style geometry ladder with the Playwright actionability fallback,
 * then report what actually received the click. The label names the target
 * in the landing note; shared is how many elements matched it (0 for refs).
 */
export declare function clickLocator(session: PlaywrightSession, locator: Locator, signal: AbortSignal | undefined, label: string, shared: number): Promise<import("./types.ts").BrowserSnapshot | {
    url: string;
    title: string;
    nodes: never[];
    totalRefs: number;
    truncated: boolean;
    dialogNote: string;
}>;
export declare function clickAt(session: PlaywrightSession, x: number, y: number, signal: AbortSignal | undefined): Promise<import("./types.ts").BrowserSnapshot | {
    url: string;
    title: string;
    nodes: never[];
    totalRefs: number;
    truncated: boolean;
    dialogNote: string;
}>;
export declare function clickAtRef(session: PlaywrightSession, ref: string, signal: AbortSignal | undefined): Promise<import("./types.ts").BrowserSnapshot | {
    url: string;
    title: string;
    nodes: never[];
    totalRefs: number;
    truncated: boolean;
    dialogNote: string;
}>;
export declare function fill(session: PlaywrightSession, ref: string, text: string, signal: AbortSignal | undefined): Promise<import("./types.ts").BrowserSnapshot>;
/** Read the field back and decide whether the fill landed. */
export declare function verifyFill(_session: PlaywrightSession, locator: Locator, tag: string, text: string): Promise<boolean>;
export declare function press(session: PlaywrightSession, ref: string, key: string, signal: AbortSignal | undefined): Promise<import("./types.ts").BrowserSnapshot | {
    url: string;
    title: string;
    nodes: never[];
    totalRefs: number;
    truncated: boolean;
    dialogNote: string;
}>;
/**
 * Hover a trigger the snapshot gave no ref, addressed by its visible label
 * (e.g. a plain span that reveals a menu on mouseenter). The label must
 * equal an element's own direct text; the deepest match wins, and the
 * landing note names what was hovered plus how many elements shared it.
 */
export declare function hoverText(session: PlaywrightSession, text: string, signal: AbortSignal | undefined): Promise<import("./types.ts").BrowserSnapshot>;
/**
 * Shared hover core: rest the pointer on a resolved locator, then report
 * what the actionable ref count did. The label names the target in the
 * landing note; shared is how many elements matched that label (0 when the
 * target came from a ref).
 */
export declare function hoverLocator(session: PlaywrightSession, locator: Locator, signal: AbortSignal | undefined, label: string, shared: number): Promise<import("./types.ts").BrowserSnapshot>;
export declare function scroll(session: PlaywrightSession, direction: 'up' | 'down', amount: number, ref: string, signal: AbortSignal | undefined): Promise<import("./types.ts").BrowserSnapshot>;
export declare function back(session: PlaywrightSession, signal: AbortSignal | undefined): Promise<import("./types.ts").BrowserSnapshot>;
export declare function forward(session: PlaywrightSession, signal: AbortSignal | undefined): Promise<import("./types.ts").BrowserSnapshot>;
export declare function switchTab(session: PlaywrightSession, index: number, signal: AbortSignal | undefined): Promise<import("./types.ts").BrowserSnapshot | {
    url: string;
    title: string;
    nodes: never[];
    totalRefs: number;
    truncated: boolean;
    dialogNote: string;
}>;
export declare function openTab(session: PlaywrightSession, url: string, waitUntil: LoadState, signal: AbortSignal | undefined): Promise<import("./types.ts").BrowserSnapshot>;
export declare function closeTab(session: PlaywrightSession, index: number, signal: AbortSignal | undefined): Promise<void>;
