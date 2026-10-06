/**
 * 浏览器提供方：profile/context 生命周期、会话注册、空闲回收、弹窗登记、标签记账。
 * @module dsh-browser-playwright-codex/provider
 */
import { persistState, restoreState } from './login-state.ts'
import { clearChromeLocks, ensureBrowser, ensureContext } from './browser-lifecycle.ts'
import { type Browser, type BrowserContext, type Dialog, type Page } from 'playwright-core'
import os from 'node:os'
import path from 'node:path'
import { PlaywrightSession } from './session.ts'
import type { PlaywrightConfig } from './config.ts'
import { getEnabled, publishConfiguredEngine } from './runtime-state.ts'
import { BrowserError } from './errors.ts'
import { SNAPSHOT_SCRIPT } from './injected.ts'
import { isWindowMinimized } from './browser-lifecycle.ts'

/**
 * Playwright-backed {@link BrowserProvider}: one shared browser, one context
 * per owner key, LRU eviction, idle disposal, ref-based snapshot interaction.
 */
/** One owner's live session handle inside the provider's map. */
export interface OwnerEntry {
  context: BrowserContext
  session: PlaywrightSession
  lastUsed: number
  /** Operations in flight; idle disposal defers while this is non-zero. */
  pending: number
  timer: NodeJS.Timeout | undefined
}

/** One action's outcome: either a native dialog blocked it, or it produced a value. */
export interface ActionResult {
  blocked: boolean
  pending?: PendingDialogRecord | undefined
  value?: unknown
}

/** A native dialog parked on one page, waiting for an explicit answer. */
export interface PendingDialogRecord {
  dialog: Dialog
  type: string
  message: string
  owner: string | undefined
}

export class PlaywrightProvider {
  config: PlaywrightConfig
  id = 'playwright'
  /** Legacy (persistent:false) shared browser instance. */
  browser: Browser | undefined
  /** Persistent-mode shared profile-backed context (the personal window). */
  context: BrowserContext | undefined
  entries = new Map<string, OwnerEntry>()
  launchError: unknown
  /** Resolved profile directory (persistent mode only). */
  profileDir = ''
  /**
   * Where cookies+localStorage are exported for the session-cookie fallback.
   * Undefined outside persistent mode, and that is load-bearing: every writer
   * and reader below guards on `undefined`, while an empty string would make
   * `'' + '.tmp'` land in the process working directory.
   */
  stateFile: string | undefined = undefined
  /** Owner that raised the dialog currently parked on a page. */
  lastActor: string | undefined
  lastStatePersist = 0
  constructor(config: PlaywrightConfig) {
    this.config = config
    // Tell the settings card which page-reading mode this deployment was
    // configured with, so it can show "当前：X（默认）" truthfully instead of
    // assuming the built-in default.
    publishConfiguredEngine(config.snapshot?.engine ?? 'legacy')
    if (config.launch.persistent) {
      const dir =
        config.launch.profileDir !== undefined && config.launch.profileDir.trim() !== ''
          ? config.launch.profileDir
          : path.join(os.homedir(), '.dsh', 'browser-profiles', 'playwright')
      this.profileDir = dir
      this.stateFile = path.join(dir, 'dsh-storage-state.json')
    }
  }
  available() {
    return true
  }
  /** Pages already carrying the dialog guard (WeakSet: pages stay collectable). */
  armedDialogs = new WeakSet()
  /** Pending native dialog per page: { dialog, type, message }. Never auto-resolved. */
  pendingDialogs = new Map<Page, PendingDialogRecord>()
  /** Resolvers waiting for the next dialog on a page (the action/dialog race). */
  dialogWaits = new Map()
  /**
   * Make a page report native dialogs instead of having them silently
   * dismissed. The dialog is parked as a per-page pending state and left
   * untouched: the page stays blocked until browser_dialog answers it, and
   * whichever action raised it returns early through the dialog race.
   * See DIALOG-POLICY.md for why this shape beats any parameter-level check.
   */
  armDialogGuard(page: Page) {
    if (this.armedDialogs.has(page)) return
    this.armedDialogs.add(page)
    page.on('dialog', (dialog) => {
      this.pendingDialogs.set(page, { dialog, type: dialog.type(), message: dialog.message(), owner: this.lastActor })
      const waiters = this.dialogWaits.get(page)
      this.dialogWaits.delete(page)
      if (waiters !== undefined) {
        for (const wake of waiters) wake()
      }
    })
  }
  /** The dialog currently blocking this page, or undefined. */
  pendingDialogFor(page: Page) {
    return this.pendingDialogs.get(page)
  }
  /**
   * Remove and return the pending dialog (atomic: one dialog, one answer).
   * Only the owner that raised it may take it: in persistent mode several
   * sessions share one page, and answering another session's dialog would
   * execute its action on their behalf.
   */
  takePendingDialog(page: Page, owner: string) {
    const pending = this.pendingDialogs.get(page)
    if (pending === undefined) return undefined
    if (pending.owner !== undefined && owner !== undefined && pending.owner !== owner) return undefined
    this.pendingDialogs.delete(page)
    return pending
  }
  /**
   * Wake when a dialog appears on this page. cancel() unregisters the waiter
   * so a finished action leaves nothing behind.
   */
  armDialogWait(page: Page) {
    const waiters = this.dialogWaits.get(page) ?? new Set()
    let wake = () => {}
    const promise = new Promise<true>((resolve) => {
      wake = () => resolve(true)
    })
    waiters.add(wake)
    this.dialogWaits.set(page, waiters)
    return {
      promise,
      cancel: () => {
        waiters.delete(wake)
      },
    }
  }
  /** One line describing a parked dialog for the tool result. */
  dialogNoteFor(pending: PendingDialogRecord) {
    return (
      '[dialog] ' +
      pending.type +
      ' "' +
      pending.message.replace(/\s+/g, ' ').trim().slice(0, 300) +
      '"' +
      ' is PENDING and the page is blocked until it is answered. Nothing has been accepted or cancelled yet.' +
      ' Answer it with browser_dialog({ accept }) — accept only if the user authorized exactly this action,' +
      ' otherwise dismiss; no other tool can act until it is answered.'
    )
  }
  async acquire(owner: string) {
    if (!getEnabled()) {
      throw new BrowserError(
        'DISABLED',
        'dsh-browser-playwright-codex is disabled; open Settings → Plugins → 浏览器 and turn it on to use the browser',
      )
    }
    const existing = this.entries.get(owner)
    if (existing) {
      existing.lastUsed = Date.now()
      this.armIdle(existing)
      return existing.session
    }
    if (this.config.launch.persistent) {
      // Personal-browser mode: all owners drive one shared profile-backed
      // window (Codex-style). Entries are lightweight session handles on
      // the shared context; the last owner to leave closes the window.
      const context = await this.ensureContext()
      const session = new PlaywrightSession(this, owner, context)
      const entry = { context, session, lastUsed: Date.now(), pending: 0, timer: undefined }
      this.entries.set(owner, entry)
      this.armIdle(entry)
      return session
    }
    const browser = await this.ensureBrowser()
    while (this.entries.size >= this.config.maxSessions) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0]
      if (oldest === undefined) break
      await this.disposeOwner(oldest[0])
    }
    const context = await browser.newContext({
      // Headful: viewport: null lets each page track its real window
      // (system DPI respected) exactly like a hand-opened Chrome, instead
      // of Playwright forcing a fixed CSS viewport that overflows the
      // window on scaled displays. Headless keeps the fixed viewport.
      ...(this.config.launch.headless ? { viewport: this.config.launch.viewport } : { viewport: null }),
      ignoreHTTPSErrors: this.config.launch.ignoreHTTPSErrors,
    })
    context.on('page', (page) => this.armDialogGuard(page))
    await context.addInitScript(SNAPSHOT_SCRIPT)
    const session = new PlaywrightSession(this, owner, context)
    const entry = { context, session, lastUsed: Date.now(), pending: 0, timer: undefined }
    this.entries.set(owner, entry)
    this.armIdle(entry)
    void context.on('close', () => {
      if (this.entries.get(owner) === entry) {
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        this.entries.delete(owner)
      }
    })
    return session
  }
  async disposeOwner(owner: string) {
    const entry = this.entries.get(owner)
    if (entry === undefined) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    this.entries.delete(owner)
    if (this.config.launch.persistent) {
      // Close the shared window only when the last owner leaves; the
      // profile and state file keep the login for the next launch.
      if (this.entries.size === 0 && this.context !== undefined) {
        const ctx = this.context
        this.context = undefined
        await this.persistState(ctx)
        await ctx.close().catch(() => {})
      }
      return
    }
    await entry.context.close().catch(() => {})
  }
  async dispose() {
    const owners = [...this.entries.keys()]
    for (const owner of owners) await this.disposeOwner(owner)
    if (this.config.launch.persistent) {
      if (this.context !== undefined) {
        const ctx = this.context
        this.context = undefined
        await this.persistState(ctx)
        await ctx.close().catch(() => {})
      }
      return
    }
    if (this.browser !== undefined) {
      await this.browser.close().catch(() => {})
      this.browser = undefined
    }
  }
  /** Touch the entry's last-used clock and re-arm its idle timer. */
  touch(owner: string) {
    const entry = this.entries.get(owner)
    if (entry === undefined) return
    entry.lastUsed = Date.now()
    this.armIdle(entry)
  }
  /** Mark one operation in flight so the idle timer cannot kill it mid-way. */
  beginOp(owner: string) {
    // Remember who is driving: a dialog raised during this call belongs to
    // that owner, and no other session may answer it.
    this.lastActor = owner
    const entry = this.entries.get(owner)
    if (entry !== undefined) entry.pending += 1
  }
  /** Settle one operation and restart the idle countdown. */
  endOp(owner: string) {
    const entry = this.entries.get(owner)
    if (entry === undefined) return
    entry.pending = Math.max(0, entry.pending - 1)
    this.touch(owner)
    // Opportunistically export login state after actions (throttled) so a
    // manual window close by the user never loses session cookies.
    this.persistStateSoon(entry.context)
  }
  /** Ensure the session entry for an owner still exists. */
  isLive(owner: string) {
    return this.entries.has(owner)
  }
  /** Drop an owner's entry after a page-level crash without closing the window. */
  invalidateOwner(owner: string) {
    const entry = this.entries.get(owner)
    if (entry === undefined) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    this.entries.delete(owner)
  }
  armIdle(entry: OwnerEntry) {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
    const idle = this.config.idleTimeoutMs
    if (idle <= 0) return
    entry.timer = setTimeout(() => {
      // A slow operation can outlive the idle window; defer disposal until
      // it settles instead of killing its browser context mid-flight.
      if (entry.pending > 0) {
        this.armIdle(entry)
        return
      }
      void this.disposeOwner(entry.session.owner)
    }, idle)
    entry.timer.unref?.()
  }
  /**
   * Ensure the shared persistent context is alive (persistent mode). A
   * profile-backed window is launched once and reused until closed by the
   * last owner, idle disposal, or an external close; login state lives in
   * the profile plus the exported state file, so reopening is seamless.
   */
  async ensureContext() {
    return ensureContext(this)
  }
  /** Remove stale Chrome singleton lock files inside the profile directory. */
  async clearChromeLocks() {
    return clearChromeLocks(this)
  }
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
  async collectLoginState(context: BrowserContext): Promise<{ cookies: unknown[]; origins: unknown[] }> {
    const anchor = context.pages()[0]
    if (anchor !== undefined && !(await isWindowMinimized(anchor))) return await context.storageState()
    return { cookies: await context.cookies(), origins: [] }
  }
  /** Export the login-state fallback to the state file (session-cookie fallback). */
  async persistState(context: BrowserContext) {
    return persistState(this, context)
  }
  /**
   * Throttled, fire-and-forget variant called after every operation.
   *
   * The "is the window minimized?" question moved inside `collectLoginState`,
   * which answers it by choosing a safe API rather than by giving up: the export
   * now runs in either window state, so the session-cookie fallback stops having
   * a hole exactly where it matters most (a user who minimized the window is the
   * one most likely to close it by hand).
   */
  persistStateSoon(context: BrowserContext) {
    if (this.stateFile === undefined || context === undefined) return
    if (Date.now() - this.lastStatePersist < 1000) return
    void this.persistState(context).catch(() => {})
  }
  /**
   * Re-inject a previously exported state. Durable cookies already live in
   * the profile; this covers session cookies the browser drops on close and
   * localStorage entries, so logins survive window close/reopen.
   */
  async restoreState(context: BrowserContext) {
    return restoreState(this, context)
  }
  /** Launch the browser once, probing the configured or auto-detected channel. */
  async ensureBrowser() {
    return ensureBrowser(this)
  }
}
