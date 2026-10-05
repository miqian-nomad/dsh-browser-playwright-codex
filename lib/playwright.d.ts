/**
 * Playwright provider for the browser capability: owns the browser binary,
 * one context per owner key, idle disposal, and the snapshot engine.
 * @module dsh-browser-playwright-codex/playwright
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Browser, type BrowserContext, type CDPSession, type Dialog, type Locator, type Page, type Request } from 'playwright-core';
import z from '@deepseek-ai/schemastery';
import type { BrowserNode, BrowserSnapshot, DiagnosticsEntry, LoadState } from './types.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "browser-playwright";
/** The browser runtime this provider registers into. */
export declare const inject: string[];
/** Schemastery validation for {@link PlaywrightConfig}. */
/** Launch configuration for the Playwright provider. */
export interface PlaywrightConfig {
    launch: {
        /** Absolute path to a Chromium-family binary; takes precedence over channel. */
        executablePath?: string;
        /** Browser channel: chromium, chrome, msedge. Omitted = auto-detect in that order. */
        channel?: string;
        /** Run headful so the user can watch and rescue the browser by hand. */
        headless: boolean;
        /** Persistent mode: one shared profile-backed window whose login survives. */
        persistent: boolean;
        /** Profile directory for persistent mode; empty means ~/.dsh/browser-profiles/playwright. */
        profileDir: string;
        viewport: {
            width: number;
            height: number;
        };
        /** Per-action navigation/click timeout in milliseconds. */
        navigationTimeoutMs: number;
        /** Ignore HTTPS certificate errors. */
        ignoreHTTPSErrors: boolean;
    };
    /** Host suffixes the browser may visit. Empty = any http(s) host. */
    allowedDomains?: string[];
    /** Close an idle session's browser context after this many milliseconds. 0 disables. */
    idleTimeoutMs: number;
    /** Maximum concurrent browser contexts; acquiring beyond it evicts the least recently used. */
    maxSessions: number;
    snapshot: {
        /** 'legacy' keeps the injected DOM walker; 'aria' uses the official ariaSnapshot(mode:'ai') engine. */
        engine: 'legacy' | 'aria';
        maxNodes: number;
        maxNameLength: number;
        maxTextLength: number;
        /** Incremental ref-diff mode; false = always full snapshots (zero behavioral change). */
        diff: boolean;
    };
}
/** Bounded page data the extraction consumer feeds to a model. */
export interface PageData {
    readonly url: string;
    readonly title: string;
    readonly text: string;
    readonly truncated: boolean;
    readonly links: readonly {
        readonly text: string;
        readonly href: string;
    }[];
    readonly inputs: readonly {
        readonly tag: string;
        readonly type: string;
        readonly name: string;
        readonly value: string;
        readonly label: string;
        readonly checked: boolean | null;
    }[];
}
/** Schemastery validation for {@link PlaywrightConfig}. */
export declare const Config: z<PlaywrightConfig>;
/**
 * Register this provider on the browser runtime for the plugin's lifetime.
 * @param ctx - plugin context carrying the browser runtime.
 * @param config - launch and fleet configuration.
 */
export declare function apply(ctx: Context, config: PlaywrightConfig): void;
/** Validate one absolute URL against the navigation policy. */
export declare function assertAllowedUrl(raw: string, allowedDomains: readonly string[]): URL;
/**
 * Which page-reading mode a capture uses. The user's choice on the settings page
 * (Settings → 浏览器 → 页面识别方式) wins over the deployment default, so flipping
 * that switch changes the very next operation — no restart, no config edit.
 * @param configured - the mode from this provider's config.
 * @returns the effective mode.
 */
export declare function resolveSnapshotEngine(configured: 'legacy' | 'aria'): 'legacy' | 'aria';
/**
 * Playwright-backed {@link BrowserProvider}: one shared browser, one context
 * per owner key, LRU eviction, idle disposal, ref-based snapshot interaction.
 */
/** One owner's live session handle inside the provider's map. */
interface OwnerEntry {
    context: BrowserContext;
    session: PlaywrightSession;
    lastUsed: number;
    /** Operations in flight; idle disposal defers while this is non-zero. */
    pending: number;
    timer: NodeJS.Timeout | undefined;
}
/** One action's outcome: either a native dialog blocked it, or it produced a value. */
interface ActionResult {
    blocked: boolean;
    pending?: PendingDialogRecord | undefined;
    value?: unknown;
}
/** A native dialog parked on one page, waiting for an explicit answer. */
interface PendingDialogRecord {
    dialog: Dialog;
    type: string;
    message: string;
    owner: string | undefined;
}
export declare class PlaywrightProvider {
    config: PlaywrightConfig;
    id: string;
    /** Legacy (persistent:false) shared browser instance. */
    browser: Browser | undefined;
    /** Persistent-mode shared profile-backed context (the personal window). */
    context: BrowserContext | undefined;
    entries: Map<string, OwnerEntry>;
    launchError: unknown;
    /** Resolved profile directory (persistent mode only). */
    profileDir: string;
    /**
     * Where cookies+localStorage are exported for the session-cookie fallback.
     * Undefined outside persistent mode, and that is load-bearing: every writer
     * and reader below guards on `undefined`, while an empty string would make
     * `'' + '.tmp'` land in the process working directory.
     */
    stateFile: string | undefined;
    /** Owner that raised the dialog currently parked on a page. */
    lastActor: string | undefined;
    lastStatePersist: number;
    constructor(config: PlaywrightConfig);
    available(): boolean;
    /** Pages already carrying the dialog guard (WeakSet: pages stay collectable). */
    armedDialogs: WeakSet<WeakKey>;
    /** Pending native dialog per page: { dialog, type, message }. Never auto-resolved. */
    pendingDialogs: Map<Page, PendingDialogRecord>;
    /** Resolvers waiting for the next dialog on a page (the action/dialog race). */
    dialogWaits: Map<any, any>;
    /**
     * Make a page report native dialogs instead of having them silently
     * dismissed. The dialog is parked as a per-page pending state and left
     * untouched: the page stays blocked until browser_dialog answers it, and
     * whichever action raised it returns early through the dialog race.
     * See DIALOG-POLICY.md for why this shape beats any parameter-level check.
     */
    armDialogGuard(page: Page): void;
    /** The dialog currently blocking this page, or undefined. */
    pendingDialogFor(page: Page): PendingDialogRecord | undefined;
    /**
     * Remove and return the pending dialog (atomic: one dialog, one answer).
     * Only the owner that raised it may take it: in persistent mode several
     * sessions share one page, and answering another session's dialog would
     * execute its action on their behalf.
     */
    takePendingDialog(page: Page, owner: string): PendingDialogRecord | undefined;
    /**
     * Wake when a dialog appears on this page. cancel() unregisters the waiter
     * so a finished action leaves nothing behind.
     */
    armDialogWait(page: Page): {
        promise: Promise<true>;
        cancel: () => void;
    };
    /** One line describing a parked dialog for the tool result. */
    dialogNoteFor(pending: PendingDialogRecord): string;
    acquire(owner: string): Promise<PlaywrightSession>;
    disposeOwner(owner: string): Promise<void>;
    dispose(): Promise<void>;
    /** Touch the entry's last-used clock and re-arm its idle timer. */
    touch(owner: string): void;
    /** Mark one operation in flight so the idle timer cannot kill it mid-way. */
    beginOp(owner: string): void;
    /** Settle one operation and restart the idle countdown. */
    endOp(owner: string): void;
    /** Ensure the session entry for an owner still exists. */
    isLive(owner: string): boolean;
    /** Drop an owner's entry after a page-level crash without closing the window. */
    invalidateOwner(owner: string): void;
    armIdle(entry: OwnerEntry): void;
    /**
     * Ensure the shared persistent context is alive (persistent mode). A
     * profile-backed window is launched once and reused until closed by the
     * last owner, idle disposal, or an external close; login state lives in
     * the profile plus the exported state file, so reopening is seamless.
     */
    ensureContext(): Promise<BrowserContext>;
    /** Remove stale Chrome singleton lock files inside the profile directory. */
    clearChromeLocks(): Promise<void>;
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
    collectLoginState(context: BrowserContext): Promise<{
        cookies: unknown[];
        origins: unknown[];
    }>;
    /** Export the login-state fallback to the state file (session-cookie fallback). */
    persistState(context: BrowserContext): Promise<void>;
    /**
     * Throttled, fire-and-forget variant called after every operation.
     *
     * The "is the window minimized?" question moved inside `collectLoginState`,
     * which answers it by choosing a safe API rather than by giving up: the export
     * now runs in either window state, so the session-cookie fallback stops having
     * a hole exactly where it matters most (a user who minimized the window is the
     * one most likely to close it by hand).
     */
    persistStateSoon(context: BrowserContext): void;
    /**
     * Re-inject a previously exported state. Durable cookies already live in
     * the profile; this covers session cookies the browser drops on close and
     * localStorage entries, so logins survive window close/reopen.
     */
    restoreState(context: BrowserContext): Promise<void>;
    /** Launch the browser once, probing the configured or auto-detected channel. */
    ensureBrowser(): Promise<Browser>;
}
/** Feature fingerprint of one ref-bearing node, for cross-snapshot diffing. */
interface RefSignature {
    role?: string;
    name?: string;
    level?: number;
    checked?: boolean;
    selected?: boolean;
    disabled?: boolean;
    href?: string;
    parentRef?: string;
}
/** Live session over one browser context owned by one caller. */
declare class PlaywrightSession {
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
     * legitimately needs seconds (2026-10-05: the Windows runner blew through the 2500ms
     * navigation timeout while encoding a full-page PNG — a slow runner, not a defect).
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
export {};
