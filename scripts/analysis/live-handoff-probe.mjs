/**
 * Does a minimize -> (agent works) -> restore cycle preserve the live page?
 *
 * If yes, a headful browser can sit minimized while the agent works, and a
 * "show the window" action can hand the SAME page (same captcha, same form,
 * same scroll position) to the human without a relaunch, a reload, or any
 * loss of tabs / session cookies.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PW_CORE_PATH ?? 'playwright-core')

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-live-handoff-'))
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  channel: process.env.CHANNEL || undefined,
  viewport: null,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--no-first-run', '--no-default-browser-check', '--start-maximized', '--disable-blink-features=AutomationControlled'],
})
const page = context.pages()[0] ?? (await context.newPage())
const out = {}

// A "challenge-like" page: a form + a live counter + scroll depth, all of which
// would be destroyed by a reload.
await page.setContent(`<html><body style="height:5000px">
  <input id=t value="">
  <div id=status>fresh</div>
  <script>
    window.__loads = (window.__loads || 0) + 1;
    window.__counter = 0;
    setInterval(() => { window.__counter++; document.querySelector('#status').textContent = 'ticks:' + window.__counter; }, 200);
    window.scrollTo(0, 1500);
  </script>
</body></html>`)
await page.fill('#t', 'captcha-answer-in-progress')
await page.evaluate(() => window.scrollTo(0, 1500))
await new Promise((r) => setTimeout(r, 700))

const cdp = await context.newCDPSession(page)
const windowId = async () => (await cdp.send('Browser.getWindowForTarget')).windowId
const state = async () => (await cdp.send('Browser.getWindowBounds', { windowId: await windowId() })).bounds.windowState
const setState = async (s) => {
  const id = await windowId()
  return cdp.send('Browser.setWindowBounds', { windowId: id, bounds: { windowState: s } })
}

out.beforeMinimize = { windowState: await state() }

// Human walks away / the harness wants the desktop: minimize.
await setState('minimized')
await new Promise((r) => setTimeout(r, 900))
out.minimized = { windowState: await state() }

// Agent keeps working on the SAME minimized page.
const snapshotWhileMinimized = await page.evaluate(() => ({
  value: document.querySelector('#t').value,
  status: document.querySelector('#status').textContent,
  scrollY: Math.round(window.scrollY),
  loads: window.__loads,
  counter: window.__counter,
}))
await page.screenshot({ path: path.join(path.dirname(profile), 'while-minimized.png') })
out.agentWorkWhileMinimized = snapshotWhileMinimized

// Human needed: show the window. No relaunch, no reload.
const foregroundBefore = await page.evaluate(() => document.hasFocus())
await setState('normal')
await page.bringToFront()
await new Promise((r) => setTimeout(r, 900))
out.afterShow = {
  windowState: await state(),
  documentFocused: await page.evaluate(() => document.hasFocus()),
  documentFocusedBefore: foregroundBefore,
  // The point of the whole exercise: is it still the same page instance?
  statePreserved: await page.evaluate(() => ({
    value: document.querySelector('#t').value,
    status: document.querySelector('#status').textContent,
    scrollY: Math.round(window.scrollY),
    loads: window.__loads,
    counter: window.__counter,
  })),
}

console.log(JSON.stringify(out, null, 2))
await setState('normal').catch(() => {})
await context.close()
fs.rmSync(profile, { recursive: true, force: true })
