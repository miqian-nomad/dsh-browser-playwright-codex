/**
 * 一次浏览器会话：持有 page/context、处理弹窗、截图、页面数据、evaluate/CDP 等交互，并把
 * 动作、快照、诊断三块转发给对应模块（page-actions / page-snapshot / page-diagnostics）。
 * @module dsh-browser-playwright-codex/session
 */
import type { BrowserContext, CDPSession, Locator, Page, Request } from 'playwright-core';
import type { PlaywrightProvider } from './provider.ts';
import type { BrowserNode, BrowserSnapshot, DiagnosticsEntry, LoadState } from './types.ts';
import type { RefSignature } from './page-snapshot.ts';
import type { ActionResult, PendingDialogRecord } from './provider.ts';
/** Live session over one browser context owned by one caller. */
export declare class PlaywrightSession {
    provider: PlaywrightProvider;
    owner: string;
    context: BrowserContext;
    currentIndex: number;
    closed: boolean;
    /** Set while answering a dialog or reporting it: page access must not be refused then. */
    bypassDialogGuard: boolean;
    /** Reused CDP session for the current page (DOM nodeIds are session-bound). */
    cdpSession: CDPSession | undefined;
    /** The page the cached CDP session is attached to. */
    cdpPage: Page | undefined;
    /** Pages already wired for console/network capture (WeakSet: pages stay collectable). */
    trackedPages: WeakSet<Page>;
    /** Stable id per page, so diagnostics can be reported for one page only. */
    pageIds: WeakMap<Page, number>;
    /** Ids handed out so far (monotonic within the session). */
    pageIdSeq: number;
    /** Bounded console + pageerror ring, shared by every tracked page of this session. */
    consoleLog: DiagnosticsEntry[];
    /** Bounded network ring, shared by every tracked page of this session. */
    networkLog: DiagnosticsEntry[];
    /** Monotonic sequence handed to each captured entry. */
    diagSeq: number;
    /** Evicted entries, so truncation is visible instead of silent. */
    diagDropped: {
        console: number;
        network: number;
    };
    /** In-flight requests keyed by request object, for status and duration attribution. */
    requestEntries: WeakMap<Request, {
        entry: DiagnosticsEntry;
        startedAt: number;
    }>;
    /** Ring capacity per stream. */
    diagLimit: number;
    /** ref -> feature signature of the previous capture (diff baseline). */
    lastRefSignatures: Map<string, RefSignature> | undefined;
    /** Nonce of the baseline ref space; a change means navigation reset. */
    lastRefNonce: string | undefined;
    constructor(provider: PlaywrightProvider, owner: string, context: BrowserContext);
    /** Run one operation under busy tracking: idle disposal defers until it settles. */
    run<T>(operation: () => Promise<T>): Promise<T>;
    /** Fast actionability pre-check (visible/enabled/editable) before an action. */
    assertActionable(locator: Locator, options?: {
        editable?: boolean;
    }): Promise<void>;
    /** Wait for an in-flight navigation (started by a click) to settle. */
    settleNavigation(page: Page): Promise<void>;
    /** Page-level render stability, bounded — a busy page never stalls the agent. */
    waitForPageStable(page: Page, timeoutMs?: number): Promise<void>;
    /** Element-level stability before a pointer/keyboard action, bounded. Returns true when stable. */
    waitForElementStable(locator: Locator): Promise<boolean>;
    /** Post-action settle: wait out a real navigation, then render-stabilize before snapshotting. */
    settleAndSnapshot(page: Page, navChanged: boolean): Promise<BrowserSnapshot>;
    /**
     * Snapshot substitute while a native dialog blocks the page: only locally
     * cached data (page.url() needs no round trip) — page.evaluate() and
     * page.title() would both stall behind the dialog.
     */
    blockedSnapshot(page: Page, pending: PendingDialogRecord | undefined): {
        url: string;
        title: string;
        nodes: never[];
        totalRefs: number;
        truncated: boolean;
        dialogNote: string;
    };
    /**
     * Run one page action that may raise a native dialog. Such an action never
     * resolves while the dialog is up, so race it against the dialog appearing
     * and hand the caller the pending state instead (Playwright-MCP pattern).
     */
    runAction(page: Page, action: () => Promise<unknown>): Promise<ActionResult>;
    /**
     * Answer the pending native dialog and let the action blocked behind it
     * finish. This is the only place a dialog is ever accepted or dismissed.
     */
    resolveDialog(accept: boolean, promptText: string | undefined, signal: AbortSignal | undefined): Promise<BrowserSnapshot>;
    /** Read the snapshot tree from one page (must run inside a run()). */
    capture(page: Page, opts: {
        interactiveOnly?: boolean;
    } | undefined): Promise<BrowserSnapshot>;
    /**
     * Semantic-tree capture via Playwright's official ariaSnapshot(mode:'ai').
     * An unavailable or unreadable aria tree (`missing`) degrades to the legacy
     * DOM walker instead of returning an empty snapshot: the model must never
     * receive "the page has no elements" because the engine failed to parse.
     */
    captureAria(page: Page, opts: {
        interactiveOnly?: boolean;
    } | undefined): Promise<{
        engineNote: string;
        url: string;
        title: string;
        nodes: BrowserNode[];
        totalRefs: number;
        truncated: boolean;
    } | {
        url: string;
        title: string;
        nodes: BrowserNode[];
        totalRefs: number;
        truncated: boolean;
    }>;
    /** Legacy capture: injected DOM walker (default engine, byte-identical output). */
    captureLegacy(page: Page, opts: {
        interactiveOnly?: boolean;
    } | undefined): Promise<{
        url: string;
        title: string;
        nodes: BrowserNode[];
        totalRefs: number;
        truncated: boolean;
    }>;
    /**
     * Attach an incremental diff when snapshot.diff is enabled. Absence of the
     * diff field means "full snapshot follows": first capture of the session,
     * navigation reset, or a truncated tree. The diff is keyed by the stable
     * data-dsh-ref, so legacy and aria engines share the same contract.
     */
    attachDiff(snap: BrowserSnapshot): BrowserSnapshot;
    /** Build ref -> feature signature map from a captured tree, with parent refs. */
    buildRefSignatures(nodes: readonly BrowserNode[]): Map<string, RefSignature>;
    /** The document nonce shared by this snapshot's refs, or undefined. */
    refNonce(nodes: readonly BrowserNode[]): string | undefined;
    navigate(url: string, waitUntil: LoadState, signal: AbortSignal | undefined): Promise<BrowserSnapshot | {
        url: string;
        title: string;
        nodes: never[];
        totalRefs: number;
        truncated: boolean;
        dialogNote: string;
    }>;
    snapshot(opts?: {
        interactiveOnly?: boolean;
    }): Promise<BrowserSnapshot | {
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
    resolveClickPoint(locator: Locator, signal: AbortSignal | undefined): Promise<{
        x: number;
        y: number;
        hitDesc: string;
        hitSelf: boolean;
    }>;
    click(ref: string, signal: AbortSignal | undefined): Promise<BrowserSnapshot | {
        url: string;
        title: string;
        nodes: never[];
        totalRefs: number;
        truncated: boolean;
        dialogNote: string;
    }>;
    /**
     * Click an element the snapshot gave no ref, addressed by its visible label
     * (e.g. a menu item revealed by browser_hover that is plain text). The
     * label must equal an element's own direct text; the deepest match wins,
     * and the landing note names what was actually clicked plus how many
     * elements shared the label.
     */
    clickText(text: string, signal: AbortSignal | undefined): Promise<BrowserSnapshot | {
        url: string;
        title: string;
        nodes: never[];
        totalRefs: number;
        truncated: boolean;
        dialogNote: string;
    }>;
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
    assertClickTargetAllowed(href: string | null): void;
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
    assertTabAllowed(page: Page): void;
    /**
     * Shared click core: enforce the URL policy for link targets, run the
     * Codex-style geometry ladder with the Playwright actionability fallback,
     * then report what actually received the click. The label names the target
     * in the landing note; shared is how many elements matched it (0 for refs).
     */
    clickLocator(locator: Locator, signal: AbortSignal | undefined, label: string, shared: number): Promise<BrowserSnapshot | {
        url: string;
        title: string;
        nodes: never[];
        totalRefs: number;
        truncated: boolean;
        dialogNote: string;
    }>;
    clickAt(x: number, y: number, signal: AbortSignal | undefined): Promise<BrowserSnapshot | {
        url: string;
        title: string;
        nodes: never[];
        totalRefs: number;
        truncated: boolean;
        dialogNote: string;
    }>;
    clickAtRef(ref: string, signal: AbortSignal | undefined): Promise<BrowserSnapshot | {
        url: string;
        title: string;
        nodes: never[];
        totalRefs: number;
        truncated: boolean;
        dialogNote: string;
    }>;
    fill(ref: string, text: string, signal: AbortSignal | undefined): Promise<BrowserSnapshot>;
    /** Read the field back and decide whether the fill landed. */
    verifyFill(locator: Locator, tag: string, text: string): Promise<boolean>;
    press(ref: string, key: string, signal: AbortSignal | undefined): Promise<BrowserSnapshot | {
        url: string;
        title: string;
        nodes: never[];
        totalRefs: number;
        truncated: boolean;
        dialogNote: string;
    }>;
    /**
     * Hover the referenced element: rest the pointer on it so hover-revealed
     * content appears (CSS :hover rules, JS mouseenter handlers, submenus,
     * tooltips, chart values, player controls). Hover never activates
     * anything: it only reveals. The ref count before and after the pointer
     * moves is the only cheap proof that something appeared, so the returned
     * snapshot carries a note comparing them.
     */
    hover(ref: string, signal: AbortSignal | undefined): Promise<BrowserSnapshot>;
    /**
     * Hover a trigger the snapshot gave no ref, addressed by its visible label
     * (e.g. a plain span that reveals a menu on mouseenter). The label must
     * equal an element's own direct text; the deepest match wins, and the
     * landing note names what was hovered plus how many elements shared it.
     */
    hoverText(text: string, signal: AbortSignal | undefined): Promise<BrowserSnapshot>;
    /**
     * Shared hover core: rest the pointer on a resolved locator, then report
     * what the actionable ref count did. The label names the target in the
     * landing note; shared is how many elements matched that label (0 when the
     * target came from a ref).
     */
    hoverLocator(locator: Locator, signal: AbortSignal | undefined, label: string, shared: number): Promise<BrowserSnapshot>;
    scroll(direction: 'up' | 'down', amount: number, ref: string, signal: AbortSignal | undefined): Promise<BrowserSnapshot>;
    back(signal: AbortSignal | undefined): Promise<BrowserSnapshot>;
    forward(signal: AbortSignal | undefined): Promise<BrowserSnapshot>;
    wait(ms: number, signal: AbortSignal | undefined): Promise<void>;
    tabs(): Promise<{
        index: number;
        url: string;
        title: string;
        active: boolean;
    }[]>;
    switchTab(index: number, signal: AbortSignal | undefined): Promise<BrowserSnapshot | {
        url: string;
        title: string;
        nodes: never[];
        totalRefs: number;
        truncated: boolean;
        dialogNote: string;
    }>;
    openTab(url: string, waitUntil: LoadState, signal: AbortSignal | undefined): Promise<BrowserSnapshot>;
    closeTab(index: number, signal: AbortSignal | undefined): Promise<void>;
    /**
     * Screenshots get their own floor instead of reusing the navigation budget: a
     * full-page capture is sized by the page and encoded by the CPU, so a loaded machine
     * legitimately needs seconds (2026-10-05: the Windows runner blew through the then-2500ms
     * navigation-timeout budget while encoding a full-page PNG — a slow runner, not a defect).
     * The floor only bounds failures; a capture that is ready returns immediately.
     */
    screenshotTimeoutMs(): number;
    screenshot(opts: {
        fullPage?: boolean;
        ref?: string;
    } | undefined, signal: AbortSignal | undefined): Promise<{
        mime: "image/png";
        bytes: Buffer<ArrayBufferLike>;
    }>;
    pageData(): Promise<unknown>;
    evaluate(expression: string, signal: AbortSignal | undefined): Promise<unknown>;
    /**
     * Send one raw CDP command on the current page's session and return its
     * result. This is the "direct protocol" escape hatch behind every other
     * tool — the model can inspect geometry, dispatch trusted input events or
     * query the DOM the same way Chrome DevTools does. Policy (which methods
     * are allowed) lives in the tool layer via lib/cdp-policy.js; this method
     * itself performs no filtering so internal callers keep full control.
     */
    cdp(method: string, params: Record<string, unknown>, signal: AbortSignal | undefined): Promise<unknown>;
    close(): Promise<void>;
    timeoutMs(): number;
    ensurePage(): Promise<Page>;
    /**
     * Wire bounded console/network capture onto one page, exactly once. Capture is
     * best-effort observation for the model: it must never throw into a page that is
     * otherwise healthy, and it must never grow without a bound.
     */
    trackPage(page: Page): void;
    /** Stable id for one page of this session (used to scope diagnostics). */
    pageIdFor(page: Page): number;
    /** Id of the page this session is driving, or undefined when there is none. */
    currentPageId(): number | undefined;
    /**
     * Split diagnostics into "the page this session is driving" and "everything
     * else". The rings keep every page's entries so chronology and eviction stay
     * honest, but a reader that promises one tab must not serve another tab's
     * lines: that is how a model diagnoses an error that belongs to a page it is
     * not even looking at.
     */
    scopeToCurrentPage(entries: readonly DiagnosticsEntry[]): {
        kept: DiagnosticsEntry[];
        otherPages: number;
    };
    /** URL of the tab this session is driving right now, or null. */
    currentUrl(): string | null;
    /** Recent console messages and uncaught page errors, newest last. */
    consoleMessages(args: {
        level?: string;
        limit?: number;
    }): {
        url: string | null;
        level: string;
        total: number;
        returned: number;
        dropped: number;
        otherPages: number;
        note: string;
        entries: {
            n: number;
            level: string | undefined;
            text: string;
            source: string;
        }[];
    };
    /** Recent network requests, newest last, with status and duration where known. */
    networkRequests(args: {
        urlContains?: string;
        failedOnly?: boolean;
        limit?: number;
    }): {
        url: string | null;
        total: number;
        returned: number;
        dropped: number;
        otherPages: number;
        note: string;
        entries: {
            n: number;
            method: string | undefined;
            url: string;
            status: number | null | undefined;
            kind: string | undefined;
            ms: number | null | undefined;
            failure: string | null | undefined;
        }[];
    };
    /**
     * Refuse page access while a native dialog blocks the page: every call
     * would otherwise stall until the action timeout. Only browser_dialog and
     * the blocked-snapshot report are allowed through (DIALOG-POLICY.md).
     */
    guardBlockedDialog(page: Page): void;
    /** Refuse context-wide tab work while any page in it has a parked dialog. */
    guardBlockedContext(): void;
    /** Run one internal step with the dialog guard lifted. */
    withDialogGuardLifted<T>(fn: () => Promise<T>): Promise<T>;
    pageAt(index: number): Page | undefined;
    refLocator(ref: string): Promise<Locator>;
    currentPageSync(): Page;
    assertLive(): void;
}
