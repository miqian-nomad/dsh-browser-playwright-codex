/**
 * 一次浏览器会话：持有 page/context、处理弹窗、截图、页面数据、evaluate/CDP 等交互，并把
 * 动作、快照、诊断三块转发给对应模块（page-actions / page-snapshot / page-diagnostics）。
 * @module dsh-browser-playwright-codex/session
 */
import type { BrowserContext, CDPSession, Locator, Page, Request } from 'playwright-core'
import type { PlaywrightProvider } from './provider.ts'
import type { BrowserNode, BrowserSnapshot, DiagnosticsEntry, LoadState } from './types.ts'
import type { RefSignature } from './page-snapshot.ts'
import { BrowserError } from './errors.ts'
import { asTimeoutError, isAbortError, isContextDestroyed, isCrashError } from './page-diagnostics.ts'
import { consoleMessages, networkRequests, pageData, trackPage } from './page-diagnostics.ts'
import { elementStabilityProbe, pageStabilityProbe } from './page-probes.ts'
import type { ActionResult, PendingDialogRecord } from './provider.ts'
import {
  assertActionable,
  back,
  clickAt,
  clickAtRef,
  clickLocator,
  clickText,
  closeTab,
  fill,
  forward,
  hoverLocator,
  hoverText,
  navigate,
  openTab,
  press,
  resolveClickPoint,
  runAction,
  scroll,
  switchTab,
  verifyFill,
  withAbort,
} from './page-actions.ts'
import {
  assertLive,
  attachDiff,
  buildRefSignatures,
  captureAria,
  captureLegacy,
  refLocator,
  resolveSnapshotEngine,
  settleAndSnapshot,
  snapshot,
} from './page-snapshot.ts'

import { assertAllowedUrl } from './url-policy.ts'

/** Live session over one browser context owned by one caller. */
export class PlaywrightSession {
  provider: PlaywrightProvider
  owner: string
  context: BrowserContext
  currentIndex = 0
  closed = false
  /** Set while answering a dialog or reporting it: page access must not be refused then. */
  bypassDialogGuard = false
  /** Reused CDP session for the current page (DOM nodeIds are session-bound). */
  cdpSession: CDPSession | undefined
  /** The page the cached CDP session is attached to. */
  cdpPage: Page | undefined
  /** Pages already wired for console/network capture (WeakSet: pages stay collectable). */
  trackedPages = new WeakSet<Page>()
  /** Stable id per page, so diagnostics can be reported for one page only. */
  pageIds = new WeakMap<Page, number>()
  /** Ids handed out so far (monotonic within the session). */
  pageIdSeq = 0
  /** Bounded console + pageerror ring, shared by every tracked page of this session. */
  consoleLog: DiagnosticsEntry[] = []
  /** Bounded network ring, shared by every tracked page of this session. */
  networkLog: DiagnosticsEntry[] = []
  /** Monotonic sequence handed to each captured entry. */
  diagSeq = 0
  /** Evicted entries, so truncation is visible instead of silent. */
  diagDropped = { console: 0, network: 0 }
  /** In-flight requests keyed by request object, for status and duration attribution. */
  requestEntries = new WeakMap<Request, { entry: DiagnosticsEntry; startedAt: number }>()
  /** Ring capacity per stream. */
  diagLimit = 200
  /** ref -> feature signature of the previous capture (diff baseline). */
  lastRefSignatures: Map<string, RefSignature> | undefined = undefined
  /** Nonce of the baseline ref space; a change means navigation reset. */
  lastRefNonce: string | undefined = undefined
  constructor(provider: PlaywrightProvider, owner: string, context: BrowserContext) {
    this.provider = provider
    this.owner = owner
    this.context = context
  }
  /** Run one operation under busy tracking: idle disposal defers until it settles. */
  run<T>(operation: () => Promise<T>): Promise<T> {
    this.provider.beginOp(this.owner)
    return Promise.resolve()
      .then(operation)
      .catch((error) => {
        if (error instanceof BrowserError || isAbortError(error)) throw error
        // The browser or its page died mid-operation: forget this owner's
        // session handle so the next acquire relaunches the window (the
        // profile and state file restore the login). Surface a clear code
        // instead of a raw protocol error.
        if (isCrashError(error)) {
          this.closed = true
          this.provider.invalidateOwner(this.owner)
          throw new BrowserError(
            'BROWSER_CRASHED',
            'the browser crashed or disconnected during the operation; the next browser call reopens it with the saved login state. Original error: ' +
              (error.message ?? String(error)),
          )
        }
        throw error
      })
      .finally(() => this.provider.endOp(this.owner))
  }
  /** Fast actionability pre-check (visible/enabled/editable) before an action. */
  async assertActionable(locator: Locator, options: { editable?: boolean } = {}) {
    return assertActionable(this, locator, options)
  }
  /** Wait for an in-flight navigation (started by a click) to settle. */
  async settleNavigation(page: Page) {
    await page.waitForLoadState('domcontentloaded', { timeout: this.timeoutMs() }).catch(() => {})
  }
  /** Page-level render stability, bounded — a busy page never stalls the agent. */
  async waitForPageStable(page: Page, timeoutMs = 1200) {
    await page.evaluate(pageStabilityProbe, { frames: 2, timeoutMs }).catch(() => false)
  }
  /** Element-level stability before a pointer/keyboard action, bounded. Returns true when stable. */
  async waitForElementStable(locator: Locator) {
    const ok = await locator.evaluate(elementStabilityProbe, { frames: 2, timeoutMs: 1500 }).catch(() => false)
    return ok === true
  }
  /** Post-action settle: wait out a real navigation, then render-stabilize before snapshotting. */
  async settleAndSnapshot(page: Page, navChanged: boolean): Promise<BrowserSnapshot> {
    return settleAndSnapshot(this, page, navChanged)
  }
  /**
   * Snapshot substitute while a native dialog blocks the page: only locally
   * cached data (page.url() needs no round trip) — page.evaluate() and
   * page.title() would both stall behind the dialog.
   */
  blockedSnapshot(page: Page, pending: PendingDialogRecord | undefined) {
    return {
      url: page.url(),
      title: '',
      nodes: [],
      totalRefs: 0,
      truncated: false,
      dialogNote: this.provider.dialogNoteFor(pending as PendingDialogRecord),
    }
  }
  /**
   * Run one page action that may raise a native dialog. Such an action never
   * resolves while the dialog is up, so race it against the dialog appearing
   * and hand the caller the pending state instead (Playwright-MCP pattern).
   */
  async runAction(page: Page, action: () => Promise<unknown>): Promise<ActionResult> {
    return runAction(this, page, action)
  }
  /**
   * Answer the pending native dialog and let the action blocked behind it
   * finish. This is the only place a dialog is ever accepted or dismissed.
   */
  async resolveDialog(accept: boolean, promptText: string | undefined, signal: AbortSignal | undefined) {
    return this.run(async () => {
      this.assertLive()
      if (typeof accept !== 'boolean') {
        throw new BrowserError('PARAM_MISSING', 'browser_dialog needs accept: true (confirm) or false (cancel)')
      }
      const page = await this.withDialogGuardLifted(() => this.ensurePage())
      // Atomic take: two concurrent answers cannot both resolve one dialog.
      const pending = this.provider.takePendingDialog(page, this.owner)
      if (pending === undefined) {
        throw new BrowserError(
          'NO_DIALOG',
          'no native dialog is pending on this page: there is nothing to accept or dismiss',
        )
      }
      const urlBefore = page.url()
      try {
        await withAbort(
          accept === true
            ? promptText !== undefined
              ? pending.dialog.accept(promptText)
              : pending.dialog.accept()
            : pending.dialog.dismiss(),
          signal,
        )
      } catch (error) {
        if (isAbortError(error)) throw error
        throw asTimeoutError('action', error)
      }
      const snap = await this.settleAndSnapshot(page, page.url() !== urlBefore)
      snap.landingNote =
        '[dialog] ' +
        pending.type +
        ' "' +
        pending.message.replace(/\s+/g, ' ').trim().slice(0, 300) +
        '" was ' +
        (accept === true ? 'ACCEPTED' : 'DISMISSED') +
        ' on request; the action blocked behind it has now resumed.'
      return snap
    })
  }
  /** Read the snapshot tree from one page (must run inside a run()). */
  async capture(page: Page, opts: { interactiveOnly?: boolean } | undefined) {
    this.provider.armDialogGuard(page)
    const raw =
      resolveSnapshotEngine(this.provider.config.snapshot.engine) === 'aria'
        ? await this.captureAria(page, opts)
        : await this.captureLegacy(page, opts)
    return this.attachDiff(raw)
  }
  /**
   * Semantic-tree capture via Playwright's official ariaSnapshot(mode:'ai').
   * An unavailable or unreadable aria tree (`missing`) degrades to the legacy
   * DOM walker instead of returning an empty snapshot: the model must never
   * receive "the page has no elements" because the engine failed to parse.
   */
  async captureAria(page: Page, opts: { interactiveOnly?: boolean } | undefined) {
    return captureAria(this, page, opts)
  }
  /** Legacy capture: injected DOM walker (default engine, byte-identical output). */
  async captureLegacy(page: Page, opts: { interactiveOnly?: boolean } | undefined) {
    return captureLegacy(this, page, opts)
  }
  /**
   * Attach an incremental diff when snapshot.diff is enabled. Absence of the
   * diff field means "full snapshot follows": first capture of the session,
   * navigation reset, or a truncated tree. The diff is keyed by the stable
   * data-dsh-ref, so legacy and aria engines share the same contract.
   */
  attachDiff(snap: BrowserSnapshot): BrowserSnapshot {
    return attachDiff(this, snap)
  }
  /** Build ref -> feature signature map from a captured tree, with parent refs. */
  buildRefSignatures(nodes: readonly BrowserNode[]): Map<string, RefSignature> {
    return buildRefSignatures(this, nodes)
  }
  /** The document nonce shared by this snapshot's refs, or undefined. */
  refNonce(nodes: readonly BrowserNode[]): string | undefined {
    for (const node of nodes) {
      if (node.ref !== undefined && node.ref.length >= 10) return node.ref.slice(1, 10)
      const nested = this.refNonce(node.children ?? [])
      if (nested !== undefined) return nested
    }
    return undefined
  }
  async navigate(url: string, waitUntil: LoadState, signal: AbortSignal | undefined) {
    return navigate(this, url, waitUntil, signal)
  }
  async snapshot(opts?: { interactiveOnly?: boolean }) {
    return snapshot(this, opts)
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
  async resolveClickPoint(locator: Locator, signal: AbortSignal | undefined) {
    return resolveClickPoint(this, locator, signal)
  }
  async click(ref: string, signal: AbortSignal | undefined) {
    return this.run(async () => {
      const locator = await this.refLocator(ref)
      return this.clickLocator(locator, signal, 'ref ' + ref, 0)
    })
  }
  /**
   * Click an element the snapshot gave no ref, addressed by its visible label
   * (e.g. a menu item revealed by browser_hover that is plain text). The
   * label must equal an element's own direct text; the deepest match wins,
   * and the landing note names what was actually clicked plus how many
   * elements shared the label.
   */
  async clickText(text: string, signal: AbortSignal | undefined) {
    return clickText(this, text, signal)
  }
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
  assertClickTargetAllowed(href: string | null) {
    if (href === null || href === '') return
    let target: URL
    try {
      target = new URL(href, this.currentPageSync().url())
    } catch {
      throw new BrowserError('URL_NOT_ALLOWED', 'invalid link target: ' + href)
    }
    if (target.protocol === 'javascript:') return
    assertAllowedUrl(target.toString(), this.provider.config.allowedDomains ?? [])
  }
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
  assertTabAllowed(page: Page) {
    const raw = page.url()
    if (raw === '') return
    let target: URL
    try {
      target = new URL(raw)
    } catch {
      return
    }
    if (target.protocol === 'about:') return
    assertAllowedUrl(target.toString(), this.provider.config.allowedDomains ?? [])
  }
  /**
   * Shared click core: enforce the URL policy for link targets, run the
   * Codex-style geometry ladder with the Playwright actionability fallback,
   * then report what actually received the click. The label names the target
   * in the landing note; shared is how many elements matched it (0 for refs).
   */
  async clickLocator(locator: Locator, signal: AbortSignal | undefined, label: string, shared: number) {
    return clickLocator(this, locator, signal, label, shared)
  }
  async clickAt(x: number, y: number, signal: AbortSignal | undefined) {
    return clickAt(this, x, y, signal)
  }
  async clickAtRef(ref: string, signal: AbortSignal | undefined) {
    return clickAtRef(this, ref, signal)
  }
  async fill(ref: string, text: string, signal: AbortSignal | undefined) {
    return fill(this, ref, text, signal)
  }
  /** Read the field back and decide whether the fill landed. */
  async verifyFill(locator: Locator, tag: string, text: string) {
    return verifyFill(this, locator, tag, text)
  }
  async press(ref: string, key: string, signal: AbortSignal | undefined) {
    return press(this, ref, key, signal)
  }
  /**
   * Hover the referenced element: rest the pointer on it so hover-revealed
   * content appears (CSS :hover rules, JS mouseenter handlers, submenus,
   * tooltips, chart values, player controls). Hover never activates
   * anything: it only reveals. The ref count before and after the pointer
   * moves is the only cheap proof that something appeared, so the returned
   * snapshot carries a note comparing them.
   */
  async hover(ref: string, signal: AbortSignal | undefined) {
    return this.run(async () => {
      const locator = await this.refLocator(ref)
      return this.hoverLocator(locator, signal, 'ref ' + ref, 0)
    })
  }
  /**
   * Hover a trigger the snapshot gave no ref, addressed by its visible label
   * (e.g. a plain span that reveals a menu on mouseenter). The label must
   * equal an element's own direct text; the deepest match wins, and the
   * landing note names what was hovered plus how many elements shared it.
   */
  async hoverText(text: string, signal: AbortSignal | undefined) {
    return hoverText(this, text, signal)
  }
  /**
   * Shared hover core: rest the pointer on a resolved locator, then report
   * what the actionable ref count did. The label names the target in the
   * landing note; shared is how many elements matched that label (0 when the
   * target came from a ref).
   */
  async hoverLocator(locator: Locator, signal: AbortSignal | undefined, label: string, shared: number) {
    return hoverLocator(this, locator, signal, label, shared)
  }
  async scroll(direction: 'up' | 'down', amount: number, ref: string, signal: AbortSignal | undefined) {
    return scroll(this, direction, amount, ref, signal)
  }
  async back(signal: AbortSignal | undefined) {
    return back(this, signal)
  }
  async forward(signal: AbortSignal | undefined) {
    return forward(this, signal)
  }
  async wait(ms: number, signal: AbortSignal | undefined) {
    return this.run(async () => {
      this.provider.touch(this.owner)
      await withAbort(new Promise((resolve) => setTimeout(resolve, ms)), signal)
    })
  }
  async tabs() {
    return this.run(async () => {
      this.assertLive()
      this.provider.touch(this.owner)
      const pages = this.context.pages()
      // The tab the other tools act on, so the model never has to guess.
      const activeIndex = Math.min(this.currentIndex, Math.max(0, pages.length - 1))
      const out = []
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index]
        if (page === undefined) continue
        this.guardBlockedDialog(page)
        out.push({ index, url: page.url(), title: await page.title(), active: index === activeIndex })
      }
      return out
    })
  }
  async switchTab(index: number, signal: AbortSignal | undefined) {
    return switchTab(this, index, signal)
  }
  async openTab(url: string, waitUntil: LoadState, signal: AbortSignal | undefined) {
    return openTab(this, url, waitUntil, signal)
  }
  async closeTab(index: number, signal: AbortSignal | undefined) {
    return closeTab(this, index, signal)
  }
  /**
   * Screenshots get their own floor instead of reusing the navigation budget: a
   * full-page capture is sized by the page and encoded by the CPU, so a loaded machine
   * legitimately needs seconds (2026-10-05: the Windows runner blew through the then-2500ms
   * navigation-timeout budget while encoding a full-page PNG — a slow runner, not a defect).
   * The floor only bounds failures; a capture that is ready returns immediately.
   */
  screenshotTimeoutMs() {
    return Math.max(this.timeoutMs(), 10_000)
  }
  async screenshot(opts: { fullPage?: boolean; ref?: string } | undefined, signal: AbortSignal | undefined) {
    return this.run(async () => {
      this.assertLive()
      this.provider.touch(this.owner)
      const page = await this.ensurePage()
      if (opts?.ref !== undefined) {
        const bytes = await withAbort(
          (await this.refLocator(opts.ref)).screenshot({ type: 'png', timeout: this.screenshotTimeoutMs() }),
          signal,
        )
        return { mime: 'image/png' as const, bytes }
      }
      const bytes = await withAbort(
        page.screenshot({
          type: 'png',
          fullPage: opts?.fullPage ?? false,
          animations: 'disabled',
          caret: 'hide',
          timeout: this.screenshotTimeoutMs(),
        }),
        signal,
      )
      return { mime: 'image/png' as const, bytes }
    })
  }
  async pageData() {
    return pageData(this)
  }
  async evaluate(expression: string, signal: AbortSignal | undefined) {
    return this.run(async () => {
      this.assertLive()
      this.provider.touch(this.owner)
      const page = await this.ensurePage()
      const fn = new Function('return (' + expression + ')')
      try {
        return await withAbort(page.evaluate(fn as () => unknown), signal)
      } catch (error) {
        if (!isContextDestroyed(error) || signal?.aborted === true) throw error
        await this.settleNavigation(page)
        return withAbort(page.evaluate(fn as () => unknown), signal)
      }
    })
  }
  /**
   * Send one raw CDP command on the current page's session and return its
   * result. This is the "direct protocol" escape hatch behind every other
   * tool — the model can inspect geometry, dispatch trusted input events or
   * query the DOM the same way Chrome DevTools does. Policy (which methods
   * are allowed) lives in the tool layer via lib/cdp-policy.js; this method
   * itself performs no filtering so internal callers keep full control.
   */
  async cdp(method: string, params: Record<string, unknown>, signal: AbortSignal | undefined) {
    return this.run(async () => {
      this.assertLive()
      this.provider.touch(this.owner)
      const page = await this.ensurePage()
      // Reuse the cached CDP session when still on the same page: DOM
      // nodeIds and execution contexts are session-bound, so creating a
      // fresh session per call would invalidate ids from earlier calls.
      if (this.cdpSession === undefined || this.cdpSession === null || this.cdpPage !== page) {
        await this.cdpSession?.detach().catch(() => {})
        this.cdpSession = await this.context.newCDPSession(page)
        this.cdpPage = page
      }
      try {
        // CDPSession.send is a prototype method: it needs its receiver, so bind it
        // before handing it to withAbort. An unbound reference dies on `this._channel`
        // inside the driver, and the failure gets reported as a protocol error.
        // CDPSession.send is a prototype method: it needs its receiver, so bind it
        // before handing it to withAbort. An unbound reference dies on `this._channel`
        // inside the driver, and the failure gets reported as a protocol error.
        const session = this.cdpSession
        const send = session.send.bind(session) as (m: string, p: Record<string, unknown>) => Promise<unknown>
        return await withAbort(send(method, params ?? {}), signal)
      } catch (error) {
        if (isAbortError(error)) throw error
        // CDP protocol errors are already structured ("Protocol error
        // (DOM.foo): ..."); wrap non-abort failures in a stable code.
        const detail = error instanceof Error ? error.message : String(error)
        if (/Protocol error/.test(detail)) {
          const m = /\(([^)]+)\): ([\s\S]+)/.exec(detail)
          throw new BrowserError(
            'CDP_ERROR',
            m
              ? 'CDP command ' + (m[1] ?? '') + ' failed: ' + (m[2] ?? '').trim().slice(0, 400)
              : 'CDP command failed: ' + detail.slice(0, 400),
          )
        }
        throw new BrowserError('CDP_ERROR', 'CDP command ' + method + ' failed: ' + detail.slice(0, 400))
      }
    })
  }
  async close() {
    if (this.closed) return
    this.closed = true
    await this.cdpSession?.detach().catch(() => {})
    this.cdpSession = undefined
    await this.provider.disposeOwner(this.owner)
  }
  timeoutMs() {
    return this.provider.config.launch.navigationTimeoutMs
  }
  async ensurePage() {
    this.assertLive()
    const pages = this.context.pages()
    if (pages.length === 0) {
      const created = await this.context.newPage()
      this.currentIndex = 0
      this.provider.armDialogGuard(created)
      this.guardBlockedDialog(created)
      this.trackPage(created)
      return created
    }
    this.currentIndex = Math.min(this.currentIndex, pages.length - 1)
    const page = pages[this.currentIndex] ?? pages[0]
    if (page === undefined) {
      const created = await this.context.newPage()
      this.currentIndex = 0
      this.provider.armDialogGuard(created)
      this.guardBlockedDialog(created)
      this.trackPage(created)
      return created
    }
    this.provider.armDialogGuard(page)
    this.guardBlockedDialog(page)
    this.trackPage(page)
    return page
  }
  /**
   * Wire bounded console/network capture onto one page, exactly once. Capture is
   * best-effort observation for the model: it must never throw into a page that is
   * otherwise healthy, and it must never grow without a bound.
   */
  trackPage(page: Page) {
    return trackPage(this, page)
  }
  /** Stable id for one page of this session (used to scope diagnostics). */
  pageIdFor(page: Page) {
    const existing = this.pageIds.get(page)
    if (existing !== undefined) return existing
    this.pageIdSeq += 1
    this.pageIds.set(page, this.pageIdSeq)
    return this.pageIdSeq
  }
  /** Id of the page this session is driving, or undefined when there is none. */
  currentPageId(): number | undefined {
    try {
      const page = this.pageAt(this.currentIndex)
      return page === undefined ? undefined : this.pageIdFor(page)
    } catch {
      return undefined
    }
  }
  /**
   * Split diagnostics into "the page this session is driving" and "everything
   * else". The rings keep every page's entries so chronology and eviction stay
   * honest, but a reader that promises one tab must not serve another tab's
   * lines: that is how a model diagnoses an error that belongs to a page it is
   * not even looking at.
   */
  scopeToCurrentPage(entries: readonly DiagnosticsEntry[]): {
    kept: DiagnosticsEntry[]
    otherPages: number
  } {
    const currentId = this.currentPageId()
    if (currentId === undefined) return { kept: entries.slice(), otherPages: 0 }
    const kept: DiagnosticsEntry[] = []
    let otherPages = 0
    for (const entry of entries) {
      if (entry.page === currentId) kept.push(entry)
      else otherPages += 1
    }
    return { kept, otherPages }
  }
  /** URL of the tab this session is driving right now, or null. */
  currentUrl() {
    try {
      return this.pageAt(this.currentIndex)?.url() ?? null
    } catch {
      return null
    }
  }
  /** Recent console messages and uncaught page errors, newest last. */
  consoleMessages(args: { level?: string; limit?: number }) {
    return consoleMessages(this, args)
  }
  /** Recent network requests, newest last, with status and duration where known. */
  networkRequests(args: { urlContains?: string; failedOnly?: boolean; limit?: number }) {
    return networkRequests(this, args)
  }
  /**
   * Refuse page access while a native dialog blocks the page: every call
   * would otherwise stall until the action timeout. Only browser_dialog and
   * the blocked-snapshot report are allowed through (DIALOG-POLICY.md).
   */
  guardBlockedDialog(page: Page) {
    if (this.bypassDialogGuard === true) return
    const pending = this.provider.pendingDialogFor(page)
    if (pending !== undefined) throw new BrowserError('DIALOG_PENDING', this.provider.dialogNoteFor(pending))
  }
  /** Refuse context-wide tab work while any page in it has a parked dialog. */
  guardBlockedContext() {
    if (this.bypassDialogGuard === true) return
    for (const page of this.context.pages()) {
      const pending = this.provider.pendingDialogFor(page)
      if (pending !== undefined) throw new BrowserError('DIALOG_PENDING', this.provider.dialogNoteFor(pending))
    }
  }
  /** Run one internal step with the dialog guard lifted. */
  async withDialogGuardLifted<T>(fn: () => Promise<T>): Promise<T> {
    this.bypassDialogGuard = true
    try {
      return await fn()
    } finally {
      this.bypassDialogGuard = false
    }
  }
  pageAt(index: number) {
    return this.context.pages()[index]
  }
  async refLocator(ref: string) {
    return refLocator(this, ref)
  }
  currentPageSync() {
    const pages = this.context.pages()
    const page = pages[Math.min(this.currentIndex, Math.max(0, pages.length - 1))]
    if (page === undefined) throw new BrowserError('SESSION_CLOSED', 'the browser session has no open page')
    this.guardBlockedDialog(page)
    return page
  }
  assertLive() {
    return assertLive(this)
  }
}
