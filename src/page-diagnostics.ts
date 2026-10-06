/**
 * 失败诊断：把 Playwright 抛出的错误归类成可读的原因。
 * @module dsh-browser-playwright-codex/page-diagnostics
 */
import type { Page, Request } from 'playwright-core'
import type { PlaywrightSession } from './session.ts'
import type { DiagnosticsEntry } from './types.ts'
import { BrowserError } from './errors.ts'

/** Serialize a Playwright timeout into a stable browser error. Code is
 * prefixed on the message so the model sees a stable machine-readable label. */
export function asTimeoutError(kind: string, cause: unknown) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  if (kind === 'navigation')
    return new BrowserError('NAVIGATION_TIMEOUT', '[NAVIGATION_TIMEOUT] the browser operation timed out: ' + detail)
  return new BrowserError('ACTION_TIMEOUT', '[ACTION_TIMEOUT] the browser action timed out: ' + detail)
}

/** Whether an error is a caller-initiated abort, which must propagate untouched. */
export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Whether a Playwright failure is a mid-evaluate navigation race. */
export function isContextDestroyed(error: unknown) {
  return error instanceof Error && /Execution context was destroyed/.test(error.message)
}

/** Whether a failure means the browser or its page died and must be relaunched. */
export function isCrashError(error: unknown) {
  if (!(error instanceof Error)) return false
  return /browser has disconnected|has been closed|Target closed|Target crashed|ProcessSingleton|Session closed|Cannot access object .* destroyed|The page .* was closed/i.test(
    error.message,
  )
}

/**
 * Wire bounded console/network capture onto one page, exactly once. Capture is
 * best-effort observation for the model: it must never throw into a page that is
 * otherwise healthy, and it must never grow without a bound.
 */
export function trackPage(session: PlaywrightSession, page: Page) {
  if (session.trackedPages.has(page)) return
  session.trackedPages.add(page)
  const pageId = session.pageIdFor(page)
  const record = (kind: 'console' | 'network', entry: DiagnosticsEntry) => {
    session.diagSeq += 1
    entry.n = session.diagSeq
    entry.at = Date.now()
    // Tag the owner: the rings are session-wide, the readers are per page.
    entry.page = pageId
    const ring = kind === 'console' ? session.consoleLog : session.networkLog
    ring.push(entry)
    while (ring.length > session.diagLimit) {
      ring.shift()
      session.diagDropped[kind] += 1
    }
  }
  try {
    page.on('console', (msg) => {
      record('console', { level: msg.type(), text: msg.text(), source: (msg.location() ?? {}).url ?? '' })
    })
    page.on('pageerror', (err) => {
      record('console', { level: 'pageerror', text: err?.message ?? String(err), source: page.url() })
    })
    page.on('request', (request) => {
      const entry = {
        method: request.method(),
        url: request.url(),
        status: null,
        kind: request.resourceType(),
        ms: null,
        failure: null,
      }
      session.requestEntries.set(request, { entry, startedAt: Date.now() })
      record('network', entry)
    })
    page.on('response', (response) => {
      const slot = session.requestEntries.get(response.request())
      if (slot === undefined) return
      slot.entry.status = response.status()
      slot.entry.ms = Date.now() - slot.startedAt
      session.requestEntries.delete(response.request())
    })
    page.on('requestfailed', (request) => {
      const slot = session.requestEntries.get(request)
      if (slot === undefined) return
      slot.entry.ms = Date.now() - slot.startedAt
      slot.entry.failure = request.failure()?.errorText ?? 'request failed'
      session.requestEntries.delete(request)
    })
  } catch {
    // Diagnostics are optional: a page that refuses hooks still works.
  }
}

/** Recent console messages and uncaught page errors, newest last. */
export function consoleMessages(session: PlaywrightSession, args: { level?: string; limit?: number }) {
  const wanted = typeof args.level === 'string' && args.level.length > 0 ? args.level : 'all'
  const limit =
    typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(session.diagLimit, args.limit))
      : 50
  const matches = (entry: DiagnosticsEntry) => {
    if (wanted === 'all') return true
    if (wanted === 'error') return entry.level === 'error' || entry.level === 'pageerror'
    if (wanted === 'warning') return entry.level === 'warning' || entry.level === 'warn'
    return entry.level === wanted
  }
  const { kept, otherPages } = session.scopeToCurrentPage(session.consoleLog.filter(matches))
  return {
    url: session.currentUrl(),
    level: wanted,
    total: kept.length,
    returned: Math.min(limit, kept.length),
    dropped: session.diagDropped.console,
    otherPages,
    note:
      otherPages > 0
        ? 'Only the tab session session is driving is reported; ' +
          String(otherPages) +
          ' matching entries from other tabs of the same window are not shown.'
        : 'Capture starts when session session first drives a tab. In persistent mode every session shares one window; only the tab session session is driving is reported.',
    entries: kept.slice(-limit).map((entry: DiagnosticsEntry) => ({
      n: entry.n as number,
      level: entry.level,
      text: (entry.text ?? '').slice(0, 400),
      source: String(entry.source).slice(0, 200),
    })),
  }
}

/** Recent network requests, newest last, with status and duration where known. */
export function networkRequests(
  session: PlaywrightSession,
  args: { urlContains?: string; failedOnly?: boolean; limit?: number },
) {
  const limit =
    typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(session.diagLimit, args.limit))
      : 50
  const needle = typeof args.urlContains === 'string' ? args.urlContains.toLowerCase() : ''
  const failedOnly = args.failedOnly === true
  let matching = session.networkLog
  if (needle.length > 0)
    matching = matching.filter((entry: DiagnosticsEntry) => (entry.url ?? '').toLowerCase().includes(needle))
  if (failedOnly)
    matching = matching.filter(
      (entry: DiagnosticsEntry) =>
        entry.failure !== null || ((entry.status ?? null) !== null && (entry.status ?? 0) >= 400),
    )
  const { kept, otherPages } = session.scopeToCurrentPage(matching)
  return {
    url: session.currentUrl(),
    total: kept.length,
    returned: Math.min(limit, kept.length),
    dropped: session.diagDropped.network,
    otherPages,
    note:
      otherPages > 0
        ? 'Only the tab session session is driving is reported; ' +
          String(otherPages) +
          ' matching requests from other tabs of the same window are not shown. Response bodies are not captured.'
        : 'Capture starts when session session first drives a tab. In persistent mode every session shares one window; only the tab session session is driving is reported. Response bodies are not captured.',
    entries: kept.slice(-limit).map((entry: DiagnosticsEntry) => ({
      n: entry.n as number,
      method: entry.method,
      url: (entry.url ?? '').slice(0, 300),
      status: entry.status,
      kind: entry.kind,
      ms: entry.ms,
      failure: entry.failure,
    })),
  }
}

export async function pageData(session: PlaywrightSession) {
  return session.run(async () => {
    session.assertLive()
    session.provider.touch(session.owner)
    const page = await session.ensurePage()
    const read = () => {
      const fn = (window as unknown as { __dshPageData?: (o: unknown) => unknown }).__dshPageData
      if (typeof fn !== 'function')
        return { url: location.href, title: document.title, text: '', truncated: false, links: [], inputs: [] }
      return fn({ maxTextChars: 30000, maxLinks: 300, maxInputs: 200 })
    }
    let data
    try {
      data = await page.evaluate(read)
    } catch (error) {
      if (!isContextDestroyed(error)) throw error
      await session.settleNavigation(page)
      data = await page.evaluate(read)
    }
    return data
  })
}
