/**
 * The login-state fallback must never open a page while the window is put away.
 *
 * Root cause this guards (FOCUS-STEALING.md, Cause 3): for every origin the
 * context has visited whose page is since gone, playwright-core's
 * `context.storageState()` opens a TEMPORARY PAGE and navigates it to that origin
 * (`coreBundle.js` 1.62.1:51663-51683). That page is created through
 * `Target.createTarget` without `background` (:38340-38342), and Chromium
 * activates the window on every tab creation — so a bookkeeping step running
 * after every tool call yanked a minimized window back onto the screen.
 *
 * These tests drive the decision with a fake BrowserContext (no browser, no
 * network): they pin WHICH playwright API is used per window state, which is
 * exactly the property that used to break. Cookies alone never open a page
 * (:51639), so a minimized window must still get its cookie fallback written.
 * @module dsh-browser-playwright-codex/tests/login-state
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PlaywrightProvider } from '../src/playwright.ts'
import type { PlaywrightConfig } from '../src/config.ts'

// 隔离设置页的真实用户状态：这些用例的期望值与引擎选择无关，但读真实状态会让结果随用户设置漂移。
process.env.DSH_BROWSER_STATE_FILE = path.join(os.tmpdir(), 'dsh-browser-tests-state-isolated.json')

type PersistArg = Parameters<PlaywrightProvider['persistState']>[0]

/** A provider in a throwaway persistent profile, so `stateFile` is a real temp path. */
function providerInTempProfile(): { provider: PlaywrightProvider; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-login-state-'))
  const config: PlaywrightConfig = {
    launch: {
      channel: 'chrome',
      headless: true,
      persistent: true,
      profileDir: dir,
      viewport: { width: 1280, height: 800 },
      navigationTimeoutMs: 2500,
      ignoreHTTPSErrors: false,
    },
    idleTimeoutMs: 0,
    maxSessions: 1,
    snapshot: { engine: 'legacy', maxNodes: 500, maxNameLength: 120, maxTextLength: 300 },
  }
  return { provider: new PlaywrightProvider(config), dir }
}

type Calls = { cookies: number; storageState: number }

/**
 * A BrowserContext stand-in that answers the two CDP calls `isWindowMinimized`
 * makes, and counts which storage APIs the provider reaches for.
 * `unreadable` makes the CDP session itself throw, which is what a headless or
 * otherwise unreadable window looks like to the provider.
 */
function fakeContext(windowState: 'minimized' | 'normal' | 'unreadable', calls: Calls): PersistArg {
  const cookie = { name: 'sid', value: 's3cret', domain: 'a.test', path: '/' }
  const session = {
    send: async (method: string) => {
      if (method === 'Browser.getWindowForTarget') return { windowId: 1 }
      if (method === 'Browser.getWindowBounds') return { bounds: { windowState } }
      throw new Error('unexpected CDP method ' + method)
    },
    detach: async () => {},
  }
  const page = {
    context: () => {
      if (windowState === 'unreadable') throw new Error('no CDP session available')
      return { newCDPSession: async () => session }
    },
  }
  return {
    pages: () => [page],
    cookies: async () => {
      calls.cookies += 1
      return [cookie]
    },
    storageState: async () => {
      calls.storageState += 1
      return { cookies: [cookie], origins: [{ origin: 'http://a.test', localStorage: [{ name: 'k', value: 'v' }] }] }
    },
  } as unknown as PersistArg
}

function readState(provider: PlaywrightProvider) {
  return JSON.parse(fs.readFileSync(String(provider.stateFile), 'utf8')) as {
    cookies: Array<{ name: string }>
    origins: unknown[]
  }
}

test('minimized window: cookies only — a storage page must never be opened', async () => {
  const { provider, dir } = providerInTempProfile()
  const calls: Calls = { cookies: 0, storageState: 0 }
  try {
    await provider.persistState(fakeContext('minimized', calls))

    assert.equal(
      calls.storageState,
      0,
      'storageState() opens a temporary page for leftover origins and activates the window — it must not run while minimized',
    )
    assert.equal(calls.cookies, 1, 'cookies are read instead, and they never open a page')

    const state = readState(provider)
    assert.deepEqual(
      state.cookies.map((c) => c.name),
      ['sid'],
      'the session-cookie fallback must still be written while the window is minimized',
    )
    assert.deepEqual(state.origins, [], 'no origins are claimed when we did not read them')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('unreadable window state is treated as minimized (the safe direction)', async () => {
  const { provider, dir } = providerInTempProfile()
  const calls: Calls = { cookies: 0, storageState: 0 }
  try {
    await provider.persistState(fakeContext('unreadable', calls))
    assert.equal(calls.storageState, 0, 'an unreadable window must never gamble with the user desktop')
    assert.equal(calls.cookies, 1)
    assert.deepEqual(
      readState(provider).cookies.map((c) => c.name),
      ['sid'],
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('visible window: full storageState() is still used, origins included', async () => {
  const { provider, dir } = providerInTempProfile()
  const calls: Calls = { cookies: 0, storageState: 0 }
  try {
    await provider.persistState(fakeContext('normal', calls))

    assert.equal(calls.storageState, 1, 'a temporary page cannot disturb a window that is already on screen')
    assert.equal(calls.cookies, 0, 'storageState() already carries the cookies; no second read')

    const state = readState(provider)
    assert.equal(state.cookies.length, 1)
    assert.equal(state.origins.length, 1, 'localStorage origins are still captured when they are safe to capture')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('persistStateSoon exports while minimized instead of skipping the call', async () => {
  const { provider, dir } = providerInTempProfile()
  const calls: Calls = { cookies: 0, storageState: 0 }
  try {
    provider.persistStateSoon(fakeContext('minimized', calls))
    // fire-and-forget: wait for the file to land rather than sleeping a fixed time
    for (let i = 0; i < 50 && !fs.existsSync(String(provider.stateFile)); i += 1) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.ok(fs.existsSync(String(provider.stateFile)), 'the throttled export must not be skipped while minimized')
    assert.equal(calls.cookies, 1)
    assert.equal(calls.storageState, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
