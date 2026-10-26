/**
 * 一次浏览器会话：持有 page/context、处理弹窗、截图、页面数据、evaluate/CDP 等交互，并把
 * 动作、快照、诊断三块转发给对应模块（page-actions / page-snapshot / page-diagnostics）。
 * @module dsh-browser-playwright-codex/session
 */
import type { BrowserContext, CDPSession, Locator, Page, Request } from 'playwright-core'
import type { PlaywrightProvider } from './provider.ts'
import type { BrowserNode, BrowserSnapshot, DiagnosticsEntry, DocumentResponse, LoadState } from './types.ts'
import type { RefSignature } from './page-snapshot.ts'
import { looksLikeToken, registrableDomain, type CookieRow } from './login-sites.ts'
import { BrowserError, cdpDisabled, evaluateDisabled } from './errors.ts'
import { isCdpMethodAllowed, cdpDenialMessage } from './cdp-policy.ts'
import { getGates } from './runtime-state.ts'
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
  attachDocResponse,
  attachNoProgress,
  buildRefSignatures,
  captureAria,
  captureLegacy,
  refLocator,
  resolveSnapshotEngine,
  settleAndSnapshot,
  snapshot,
} from './page-snapshot.ts'

import { assertAllowedUrl, isHostAllowed } from './url-policy.ts'

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
  /**
   * Main document response per page. Challenge detection reads this before it
   * reads a word of the page: a response header is the interceptor's own API.
   */
  docResponses = new WeakMap<Page, DocumentResponse>()
  /** Fingerprint of the previous capture's page state (no-progress backstop). */
  lastFingerprint: string | undefined = undefined
  /** Consecutive captures that produced an identical page-state fingerprint. */
  unchangedStreak = 0
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
  /**
   * Turn a navigation the host guard refused into a named refusal.
   *
   * A page can navigate itself (location.href, meta refresh, a form submit, a
   * 302) without passing any entry-point check. The guard stops the document
   * request; this reports it, so "I clicked and nothing happened" becomes
   * URL_NOT_ALLOWED naming the host. Consumed once: a later action must not
   * inherit an earlier refusal.
   */
  throwIfNavigationBlocked() {
    const refused = this.provider.takeBlockedNavigation()
    if (refused === undefined) return
    throw new BrowserError(
      'URL_NOT_ALLOWED',
      'the page tried to navigate to ' +
        refused.url +
        ' and was blocked: host ' +
        refused.host +
        ' is not in allowedDomains. Nothing left this site — the request was stopped before it reached the network. ' +
        'The page you were on is unchanged; tell the user the site tried to leave the allow-list.',
    )
  }
  /**
   * Refuse to go on driving a page that is outside the allow-list.
   *
   * The request-level guard (navigation-guard.ts) catches navigations started
   * from inside the page, but NOT a redirect the browser follows on its own:
   * measured 2026-10-26, `context.route()` never sees the hop after a
   * `continue()`d request, so `127.0.0.1/x` answering `302 → localhost/y` lands
   * on the disallowed host with no route event at all. So every action that
   * settles a page also checks where it actually ended up.
   *
   * The off-list page is abandoned for about:blank (hostless, always allowed)
   * instead of being left there: otherwise the session would wedge on a page it
   * may never drive, and "navigate somewhere allowed" could not fix it.
   * @param page - the page this action ran on.
   */
  async assertCurrentUrlAllowed(page: Page) {
    const raw = page.url()
    if (raw === '') return
    let target: URL
    try {
      target = new URL(raw)
    } catch {
      return
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return
    const allowedDomains = this.provider.config.allowedDomains ?? []
    if (isHostAllowed(target.hostname, allowedDomains)) return
    await page.goto('about:blank').catch(() => {})
    throw new BrowserError(
      'URL_NOT_ALLOWED',
      'the page ended up on host ' +
        target.hostname +
        ' (' +
        raw +
        '), which is not in allowedDomains — a redirect the browser followed on its own. ' +
        'The tab has been reset to about:blank, so nothing outside the allow-list stays reachable. ' +
        'Tell the user: the site tried to send this session off the allow-list.',
    )
  }
  /**
   * The session's cookies, reduced to what the login inference needs. `value` is dropped here,
   * at the only place cookies enter the summary path, so nothing downstream can leak it.
   */
  async cookieJar(): Promise<readonly CookieRow[]> {
    const raw = await this.context.cookies()
    return raw.map((cookie) => ({
      name: cookie.name,
      domain: cookie.domain,
      ...(typeof cookie.expires === 'number' ? { expires: cookie.expires } : {}),
      ...(cookie.httpOnly === true ? { httpOnly: true } : {}),
      ...(cookie.secure === true ? { secure: true } : {}),
      // The value is inspected here and reduced to one boolean; it never leaves this function.
      ...(looksLikeToken(cookie.value) ? { tokenLike: true } : {}),
    }))
  }

  /**
   * Registrable domains of the pages this browser currently has open — the "first-party" set the
   * login inference attributes cookies to. Taken from the live pages rather than the browser's
   * history database: the plugin only claims what it can see, and never reads a new data source.
   */
  /**
   * Page titles by registrable domain for the pages currently open — the site's own name for
   * itself, which is what browsers and password managers show instead of a bare hostname. Titles
   * are display-only and trimmed; a domain with no open page simply has no title.
   */
  async siteTitles(): Promise<Map<string, string>> {
    const titles = new Map<string, string>()
    for (const page of this.context.pages()) {
      try {
        const url = page.url()
        if (!url.startsWith('http://') && !url.startsWith('https://')) continue
        const domain = registrableDomain(new URL(url).host)
        if (domain === '' || titles.has(domain)) continue
        const title = (await page.title()).replace(/\s+/g, ' ').trim()
        if (title !== '') titles.set(domain, title.slice(0, 80))
      } catch {
        /* a page can be mid-navigation or already closed */
      }
    }
    return titles
  }

  visitedHosts(): string[] {
    const hosts = new Set<string>()
    for (const page of this.context.pages()) {
      try {
        const url = page.url()
        if (!url.startsWith('http://') && !url.startsWith('https://')) continue
        const domain = registrableDomain(new URL(url).host)
        if (domain !== '') hosts.add(domain)
      } catch {
        /* a page can be mid-navigation or already closed */
      }
    }
    return [...hosts]
  }
  /** Run one operation under busy tracking: idle disposal defers until it settles. */
  run<T>(operation: () => Promise<T>): Promise<T> {
    // Every action starts from a clean slate: a refusal recorded during an
    // earlier action must not be reported as this one's outcome.
    this.provider.blockedNavigation = undefined
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
  blockedSnapshot(page: Page, pending: PendingDialogRecord | undefined): BrowserSnapshot {
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
  async resolveDialog(accept: boolean, promptText: string | undefined, signal?: AbortSignal) {
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
  async capture(page: Page, opts: { interactiveOnly?: boolean } | undefined, afterAction = false) {
    this.provider.armDialogGuard(page)
    const raw =
      resolveSnapshotEngine(this.provider.config.snapshot.engine) === 'aria'
        ? await this.captureAria(page, opts)
        : await this.captureLegacy(page, opts)
    // Order matters: the response metadata is attached before the diff, so the
    // snapshot the model reads carries the same evidence the detector used, and
    // the no-progress backstop sees the final tree.
    return this.attachDiff(attachNoProgress(this, attachDocResponse(this, page, raw), afterAction))
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
  async navigate(url: string, waitUntil: LoadState, signal?: AbortSignal) {
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
  async resolveClickPoint(locator: Locator, signal?: AbortSignal) {
    return resolveClickPoint(this, locator, signal)
  }
  async click(ref: string, signal?: AbortSignal) {
    return this.run(async () => {
      const locator = await this.refLocator(ref)
      return this.clickLocator(locator, signal, 'ref ' + ref, 0)
    })
  }
  /**
   * Click an element the snapshot gave no ref, addressed by its visible label
   * (e.g. a menu item revealed by browser_click with mode "hover" that is plain text). The
   * label must equal an element's own direct text; the deepest match wins,
   * and the landing note names what was actually clicked plus how many
   * elements shared the label.
   */
  async clickText(text: string, signal?: AbortSignal) {
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
  async clickAt(x: number, y: number, signal?: AbortSignal) {
    return clickAt(this, x, y, signal)
  }
  async clickAtRef(ref: string, signal?: AbortSignal) {
    return clickAtRef(this, ref, signal)
  }
  async fill(ref: string, text: string, signal?: AbortSignal) {
    return fill(this, ref, text, signal)
  }
  /** Read the field back and decide whether the fill landed. */
  async verifyFill(locator: Locator, tag: string, text: string) {
    return verifyFill(this, locator, tag, text)
  }
  async press(ref: string, key: string, signal?: AbortSignal) {
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
  async hover(ref: string, signal?: AbortSignal) {
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
  async hoverText(text: string, signal?: AbortSignal) {
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
  async scroll(direction: 'up' | 'down', amount: number, ref: string | undefined, signal?: AbortSignal) {
    return scroll(this, direction, amount, ref, signal)
  }
  async back(signal?: AbortSignal) {
    return back(this, signal)
  }
  async forward(signal?: AbortSignal) {
    return forward(this, signal)
  }
  async wait(ms: number, signal?: AbortSignal) {
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
  async switchTab(index: number, signal?: AbortSignal) {
    return switchTab(this, index, signal)
  }
  async openTab(url: string, waitUntil: LoadState, signal?: AbortSignal) {
    return openTab(this, url, waitUntil, signal)
  }
  async closeTab(index: number, signal?: AbortSignal) {
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
  async screenshot(opts: { fullPage?: boolean; ref?: string } | undefined, signal?: AbortSignal) {
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
  async evaluate(expression: string, signal?: AbortSignal) {
    // The switch is enforced HERE, not only in the tool layer: browser_evaluate
    // used to be guarded by tool.ts alone, so anything holding the service (a
    // sibling plugin, a script) could run arbitrary page JavaScript with the
    // user's logins while the setting said off (measured 2026-10-26). An
    // unpublished gate set counts as OFF — a deployment that never said yes has
    // not said yes.
    if (!(getGates()?.allowEvaluate ?? false)) throw evaluateDisabled()
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
   * query the DOM the same way Chrome DevTools does.
   *
   * Both rules live here as well as in the tool layer, deliberately: the
   * allow-list and the switch must hold for anything that reaches this method,
   * not just for the registered tool. Before 2026-10-26 only `browser_cdp`
   * checked them, so a caller working through the service could send
   * `Runtime.evaluate` — arbitrary JavaScript — with the switch off (measured).
   */
  async cdp(method: string, params: Record<string, unknown>, signal?: AbortSignal) {
    if (!(getGates()?.allowCdp ?? false)) throw cdpDisabled()
    if (!isCdpMethodAllowed(method)) throw new BrowserError('CDP_DENIED', cdpDenialMessage(method))
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
