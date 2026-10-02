/**
 * Domain types for the browser capability: snapshots, sessions, providers.
 * @module dsh-browser-playwright-codex/types
 */
/** Page load condition a navigation waits for. */
export type LoadState = 'load' | 'domcontentloaded' | 'networkidle';
/** One snapshot element. Refs identify actionable elements for later calls. */
export interface BrowserNode {
    /** Accessible role, e.g. link, button, textbox, heading. */
    readonly role: string;
    /** Accessible-ish name; empty when the element has none. */
    readonly name: string;
    /** Stable per-snapshot reference; present only on actionable elements. */
    readonly ref?: string;
    /** Heading level (1-6); present only for headings. */
    readonly level?: number;
    /** Whether a checkbox/radio is checked. */
    readonly checked?: boolean;
    /** Whether an option is selected. */
    readonly selected?: boolean;
    /** Whether the element is disabled. */
    readonly disabled?: boolean;
    /** Href for links; present when the page is same-origin. */
    readonly href?: string;
    readonly children: readonly BrowserNode[];
}
/** Bounded accessibility snapshot of the current page. */
export interface BrowserSnapshot {
    readonly url: string;
    readonly title: string;
    readonly nodes: readonly BrowserNode[];
    /** Total refs assigned before any truncation. */
    readonly totalRefs: number;
    /** True when node or text caps cut the tree short. */
    readonly truncated: boolean;
    /**
     * Incremental diff against the previous snapshot of this document, present
     * only when the provider's snapshot.diff is enabled and a baseline exists.
     * Absence means "full snapshot follows": first capture, navigation reset,
     * or a truncated tree (diff is then unreliable, so the provider degrades
     * to the full tree). Diff entries are keyed by the stable data-dsh-ref.
     */
    readonly diff?: SnapshotDiff;
    /**
     * Note parked on the snapshot when a native dialog blocks the page: the
     * snapshot then describes the blocker instead of the page (DIALOG-POLICY).
     */
    dialogNote?: string;
    /**
     * Where the last click actually landed, when the provider can prove it. Its
     * absence means "not reported", never "landed on the target".
     */
    landingNote?: string;
    /**
     * Set when the configured page reader could not read this page and the
     * provider degraded to the other engine. Without it the fallback was silent,
     * and a user who picked smart mode kept believing it was running.
     */
    engineNote?: string;
}
/** One element that entered the tree since the previous snapshot. */
export interface SnapshotDiffEntry {
    readonly ref: string;
    readonly role?: string;
    readonly name?: string;
    /** State flags for an added element (checked / selected / disabled / level=N). */
    readonly flags?: string[];
    /** State flags that changed on an existing element. */
    readonly flagsDelta?: string[];
    /** Nearest ancestor ref, so a diff line keeps its tree context. */
    readonly parentRef?: string;
}
/**
 * Incremental delta between two snapshots of the same document, keyed by the
 * stable data-dsh-ref (e<docNonce><seq>). `navigationReset: true` means the
 * ref space changed (navigation) or the tree was truncated, so the delta is
 * void and the consumer must rely on the full snapshot that follows.
 */
export interface SnapshotDiff {
    readonly added: readonly SnapshotDiffEntry[];
    readonly removed: readonly string[];
    readonly changed: readonly SnapshotDiffEntry[];
    /** Number of elements whose ref and features are unchanged. */
    readonly same: number;
    /** True when the previous ref space is void (navigation or truncation). */
    readonly navigationReset: boolean;
}
/** One open tab in the browser session. */
export interface TabInfo {
    readonly index: number;
    readonly url: string;
    readonly title: string;
    /** True for the tab the session currently drives. */
    readonly active: boolean;
}
/** PNG capture of a page or element. */
export interface ScreenshotCapture {
    readonly mime: 'image/png';
    readonly bytes: Uint8Array;
}
/** One captured diagnostics entry: a console line or a network request. */
export type DiagnosticsEntry = {
    /** Monotonic sequence number within the session's ring buffer. */
    n?: number | undefined;
    /** Capture time (epoch milliseconds), set by the provider. */
    at?: number | undefined;
    /** Console level (log / warning / error / pageerror), diagnostics only. */
    level?: string | undefined;
    /** Console text, truncated by the provider. */
    text?: string | undefined;
    /** Source URL the console entry came from. */
    source?: string | undefined;
    /** HTTP method, network entries only. */
    method?: string | undefined;
    /** Request URL, network entries only. */
    url?: string | undefined;
    /** Response status, null while pending or after a failure. */
    status?: number | null | undefined;
    /** Resource type, network entries only. */
    kind?: string | undefined;
    /** Round-trip duration in milliseconds, when the request settled. */
    ms?: number | null | undefined;
    /** Transport failure text, when the request never completed. */
    failure?: string | null | undefined;
    /**
     * Which page of this session produced the entry. The rings stay session-wide so
     * chronology survives a tab switch, but the diagnostics tools report only the
     * page the session is driving and say how many entries they left out.
     */
    page?: number | undefined;
};
/** Canonical value of browser_console_messages and browser_network_requests. */
export type DiagnosticsValue = {
    /** URL of the tab the entries were captured from, when known. */
    url?: string | null;
    /** Requested console level filter, diagnostics only. */
    level?: string | undefined;
    /** Entries matching the filter. */
    readonly total: number;
    /** Entries actually returned after the limit was applied. */
    readonly returned: number;
    /** Entries evicted from the ring buffer, so truncation stays visible. */
    readonly dropped?: number;
    /**
     * Matching entries that were left out because they belong to another tab of
     * the shared window. Non-zero means "this tab is quiet, the noise is elsewhere"
     * — the reader must say so instead of letting a model diagnose a foreign page.
     */
    readonly otherPages?: number;
    readonly entries: readonly DiagnosticsEntry[];
};
/**
 * Live browser session owned by one caller (a harness session id).
 * Providers manage the underlying browser contexts; callers only drive.
 */
export interface BrowserSession {
    /** Opaque owner key supplied at acquisition. */
    readonly owner: string;
    /** Navigate the active page and return the post-navigation snapshot. */
    navigate(url: string, waitUntil: LoadState, signal?: AbortSignal): Promise<BrowserSnapshot>;
    /** Snapshot the active page without changing it. */
    snapshot(opts?: {
        readonly interactiveOnly?: boolean;
    }): Promise<BrowserSnapshot>;
    /** Click the element referenced by the latest snapshot. */
    click(ref: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
    /** Replace the referenced input's value and return the new snapshot. */
    fill(ref: string, text: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
    /** Press a keyboard key on the referenced element. */
    press(ref: string, key: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
    /** Scroll the page, or the referenced scrollable, by the given amount. */
    scroll(direction: 'up' | 'down', amount: number, ref: string | undefined, signal?: AbortSignal): Promise<BrowserSnapshot>;
    /** History back. */
    back(signal?: AbortSignal): Promise<BrowserSnapshot>;
    /** History forward. */
    forward(signal?: AbortSignal): Promise<BrowserSnapshot>;
    /** Wait a bounded duration, letting lazy content arrive. */
    wait(ms: number, signal?: AbortSignal): Promise<void>;
    /** List open tabs. */
    tabs(): Promise<readonly TabInfo[]>;
    /** Activate the tab at the given index. */
    switchTab(index: number, signal?: AbortSignal): Promise<BrowserSnapshot>;
    /** Open a new tab and navigate it. */
    openTab(url: string, waitUntil: LoadState, signal?: AbortSignal): Promise<BrowserSnapshot>;
    /** Close the tab at the given index; the last tab resets to a blank page. */
    closeTab(index: number, signal?: AbortSignal): Promise<void>;
    /** Capture a PNG of the page or referenced element. */
    screenshot(opts: {
        readonly fullPage?: boolean;
        readonly ref?: string;
    } | undefined, signal?: AbortSignal): Promise<ScreenshotCapture>;
    /** Extract the page's bounded data: text, links, forms, frames. */
    pageData(): Promise<unknown>;
    /** Evaluate one JavaScript expression and return its JSON result. */
    evaluate(expression: string, signal?: AbortSignal): Promise<unknown>;
    /** Click the element whose visible text matches, by semantic locator. */
    clickText(text: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
    /** Click the element referenced by the latest snapshot at its geometry. */
    clickAtRef(ref: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
    /** Click raw viewport coordinates, when no ref resolves the target. */
    clickAt(x: number, y: number, signal?: AbortSignal): Promise<BrowserSnapshot>;
    /** Hover the referenced element. */
    hover(ref: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
    /** Hover the element whose visible text matches. */
    hoverText(text: string, signal?: AbortSignal): Promise<BrowserSnapshot>;
    /** Answer the parked native dialog and return the post-answer snapshot. */
    resolveDialog(accept: boolean, promptText: string | undefined, signal?: AbortSignal): Promise<BrowserSnapshot>;
    /**
     * Send one raw CDP command on the current page. The provider performs no
     * policy filtering: callers are the tool layer, which holds the allow-list.
     */
    cdp(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
    /** Recent console messages and uncaught page errors for this session. */
    consoleMessages(args: {
        readonly level?: string;
        readonly limit?: number;
    }): DiagnosticsValue;
    /** Recent network requests for this session, newest last. */
    networkRequests(args: {
        readonly urlContains?: string;
        readonly failedOnly?: boolean;
        readonly limit?: number;
    }): DiagnosticsValue;
    /** Close the session; the provider forgets its browser context. */
    close(): Promise<void>;
}
/**
 * One browser-capability implementation. Providers own browser binaries,
 * context fleets, and lifecycle; the runtime selects exactly one.
 */
export interface BrowserProvider {
    /** Stable unique provider id. */
    readonly id: string;
    /** Whether this provider can currently serve sessions. */
    available(): boolean;
    /** Acquire or reuse the session owned by the owner key. */
    acquire(owner: string, signal?: AbortSignal): Promise<BrowserSession>;
    /** Release the session owned by the owner key and its browser resources. */
    disposeOwner(owner: string): Promise<void>;
    /** Release every session and the browser itself. */
    dispose(): Promise<void>;
}
