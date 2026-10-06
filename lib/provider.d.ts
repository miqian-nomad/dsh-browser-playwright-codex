/**
 * 浏览器提供方：profile/context 生命周期、会话注册、空闲回收、弹窗登记、标签记账。
 * @module dsh-browser-playwright-codex/provider
 */
import { type Browser, type BrowserContext, type Dialog, type Page } from 'playwright-core';
import { PlaywrightSession } from './session.ts';
import type { PlaywrightConfig } from './config.ts';
/**
 * Playwright-backed {@link BrowserProvider}: one shared browser, one context
 * per owner key, LRU eviction, idle disposal, ref-based snapshot interaction.
 */
/** One owner's live session handle inside the provider's map. */
export interface OwnerEntry {
    context: BrowserContext;
    session: PlaywrightSession;
    lastUsed: number;
    /** Operations in flight; idle disposal defers while this is non-zero. */
    pending: number;
    timer: NodeJS.Timeout | undefined;
}
/** One action's outcome: either a native dialog blocked it, or it produced a value. */
export interface ActionResult {
    blocked: boolean;
    pending?: PendingDialogRecord | undefined;
    value?: unknown;
}
/** A native dialog parked on one page, waiting for an explicit answer. */
export interface PendingDialogRecord {
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
