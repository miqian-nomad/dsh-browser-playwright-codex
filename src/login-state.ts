/**
 * 登录态持久化：把 profile 的 cookies+localStorage 导出到状态文件、并在重开时恢复；
 * 窗口最小化或读不到窗口状态时只取 cookies。
 * @module dsh-browser-playwright-codex/login-state
 */
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserContext } from 'playwright-core'
import type { PlaywrightProvider } from './provider.ts'

/** Export the login-state fallback to the state file (session-cookie fallback). */
export async function persistState(provider: PlaywrightProvider, context: BrowserContext) {
  if (provider.stateFile === undefined || context === undefined) return
  try {
    const state = await provider.collectLoginState(context)
    const tmp = provider.stateFile + '.tmp'
    fs.mkdirSync(path.dirname(provider.stateFile), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(state))
    fs.renameSync(tmp, provider.stateFile)
    provider.lastStatePersist = Date.now()
  } catch {
    /* best-effort: the profile itself already holds durable cookies */
  }
}

/**
 * Re-inject a previously exported state. Durable cookies already live in
 * the profile; this covers session cookies the browser drops on close and
 * localStorage entries, so logins survive window close/reopen.
 */
export async function restoreState(provider: PlaywrightProvider, context: BrowserContext) {
  if (provider.stateFile === undefined) return
  let state
  try {
    state = JSON.parse(fs.readFileSync(provider.stateFile, 'utf8'))
  } catch {
    return
  }
  if (state === null || typeof state !== 'object') return
  const cookies = Array.isArray(state.cookies)
    ? state.cookies.filter(
        (c: Record<string, unknown>) =>
          c !== null &&
          typeof c === 'object' &&
          typeof c.name === 'string' &&
          c.value !== undefined &&
          typeof c.domain === 'string',
      )
    : []
  if (cookies.length > 0) {
    await context.addCookies(
      cookies.map((c: Record<string, unknown>) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: typeof c.path === 'string' && c.path !== '' ? c.path : '/',
        ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
        ...(typeof c.httpOnly === 'boolean' ? { httpOnly: c.httpOnly } : {}),
        ...(typeof c.secure === 'boolean' ? { secure: c.secure } : {}),
        ...(typeof c.sameSite === 'string' ? { sameSite: c.sameSite } : {}),
      })) as Parameters<BrowserContext['addCookies']>[0],
    )
  }
  const origins = Array.isArray(state.origins)
    ? state.origins.filter(
        (o: Record<string, unknown>) =>
          o !== null &&
          typeof o === 'object' &&
          typeof o.origin === 'string' &&
          Array.isArray(o.localStorage) &&
          o.localStorage.length > 0,
      )
    : []
  if (origins.length > 0) {
    await context.addInitScript(
      ({ rows }: { rows: Array<Record<string, unknown>> }) => {
        for (const o of rows) {
          if (location.origin !== o.origin) continue
          for (const kv of o.localStorage as Array<{ name?: unknown; value?: unknown }>) {
            try {
              localStorage.setItem(kv.name as string, kv.value as string)
            } catch {
              /* quota / privacy mode */
            }
          }
        }
      },
      { rows: origins },
    )
  }
}
