/**
 * Minimal, plugin-free reproduction of "automation raises a minimized window".
 *
 * Two modes, matching the two ways dsh-browser-playwright can own a window:
 *   PW_MODE=launch      -> chromium.launch() + browser.newContext()   (upstream 0.1.x default shape)
 *   PW_MODE=persistent  -> chromium.launchPersistentContext()         (persistent-profile forks)
 *
 * The OS window state is read back through CDP (Browser.getWindowBounds) and the
 * window is minimized through CDP too, so the verdict does not depend on anyone
 * watching the screen.
 *
 * Usage (Windows, using an installed Chrome):
 *   set PW_MODE=launch
 *   set PW_CHANNEL=chrome
 *   set PW_CORE_PATH=D:\path\to\node_modules\playwright-core
 *   node repro-minimize.mjs
 */
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const corePath = process.env.PW_CORE_PATH ?? 'playwright-core'
const { chromium } = require(corePath)
let coreVersion = 'unknown'
try {
  coreVersion = require(path.join(corePath, 'package.json')).version
} catch {}

const MODE = process.env.PW_MODE ?? 'launch'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const launchOptions = {
  headless: false,
  channel: process.env.PW_CHANNEL || undefined, // e.g. 'chrome' to use the local Chrome
  args: ['--no-first-run', '--no-default-browser-check'],
}

let browser
let context
let profile
if (MODE === 'persistent') {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-focus-repro-'))
  context = await chromium.launchPersistentContext(profile, { ...launchOptions, viewport: null })
} else {
  browser = await chromium.launch(launchOptions)
  context = await browser.newContext({ viewport: null })
}

const anchor = context.pages()[0] ?? (await context.newPage())
// Real content matters: an empty about:blank window can behave differently.
await anchor.goto('https://example.com', { waitUntil: 'domcontentloaded' }).catch(() => {})
await sleep(500)

const cdp = await context.newCDPSession(anchor)
const windowId = async () => (await cdp.send('Browser.getWindowForTarget')).windowId
const state = async () => (await cdp.send('Browser.getWindowBounds', { windowId: await windowId() })).bounds.windowState
const setState = async (windowState) => {
  const id = await windowId()
  return cdp.send('Browser.setWindowBounds', { windowId: id, bounds: { windowState } })
}

const results = []
async function probe(name, fn) {
  await setState('normal')
  await sleep(400)
  await setState('minimized')
  await sleep(900)
  const before = await state()
  let err = ''
  try {
    await fn()
  } catch (e) {
    err = ' [' + (e?.message ?? e) + ']'
  }
  await sleep(1400)
  const after = await state()
  const raised = before === 'minimized' && after !== 'minimized'
  results.push({ name, before, after, raised })
  console.log(`${raised ? 'RAISES  ' : 'safe    '} ${name.padEnd(46)} before=${before} after=${after}${err}`)
}

console.log(`mode=${MODE}  playwright-core ${coreVersion}  node ${process.version}`)
console.log(`channel=${process.env.PW_CHANNEL || '(bundled chromium)'}\n`)

await probe('baseline: sleep only (3s)', () => sleep(3000))
await probe('context.newPage()', async () => {
  const p = await context.newPage()
  await p.goto('about:blank')
  await p.close()
})
await probe('CDP Target.createTarget({background:true})', async () => {
  await cdp.send('Target.createTarget', { url: 'about:blank', background: true })
})
await probe('page.bringToFront()', () => anchor.bringToFront())
await probe('context.newCDPSession(anchor)', async () => {
  const s = await context.newCDPSession(anchor)
  await s.detach()
})
await probe('context.storageState()', () => context.storageState())
await probe('anchor.goto() (same tab)', () =>
  anchor.goto('https://example.com/?x=1', { waitUntil: 'domcontentloaded' }),
)
await probe('anchor.screenshot()', () => anchor.screenshot({ path: path.join(os.tmpdir(), 'pw-repro.png') }))

console.log('\n--- summary ---')
for (const r of results) console.log(`${r.raised ? 'RAISES' : 'safe  '}  ${r.name}`)

await setState('normal').catch(() => {})
await context.close().catch(() => {})
await browser?.close().catch(() => {})
if (profile) fs.rmSync(profile, { recursive: true, force: true })
