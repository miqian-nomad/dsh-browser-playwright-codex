/**
 * Headless-mode capability probe, aimed at the three "needs a human" cases:
 *
 *  1. Does the window-state CDP call used by the minimize gate even work headless?
 *     (If it throws, our gate returns "minimized" and silently disables the
 *      login-state export in headless — i.e. session cookies would never be saved.)
 *  2. Do page-level native dialogs (alert/confirm/prompt) park and answer headless?
 *  3. Does a file input accept setInputFiles headless, i.e. no OS picker needed?
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PW_CORE_PATH ?? 'playwright-core')

const headless = (process.env.MODE ?? 'headless') === 'headless'
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-needsprobe-'))
const context = await chromium.launchPersistentContext(profile, {
  headless,
  channel: process.env.CHANNEL || undefined,
  ...(headless ? { viewport: { width: 1280, height: 800 } } : { viewport: null }),
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
})
const page = context.pages()[0] ?? (await context.newPage())
const out = { mode: headless ? 'headless' : 'headful' }

// --- 1. the window-state probe the plugin's gate relies on -------------------
try {
  const s = await context.newCDPSession(page)
  const { windowId } = await s.send('Browser.getWindowForTarget')
  const { bounds } = await s.send('Browser.getWindowBounds', { windowId })
  out.windowStateProbe = { ok: true, windowId, windowState: bounds.windowState, bounds }
  out.gateWouldReturn = bounds.windowState === 'minimized'
  await s.detach()
} catch (e) {
  out.windowStateProbe = { ok: false, error: String(e?.message ?? e).split('\n')[0] }
  // The plugin's catch returns true == "treat as minimized".
  out.gateWouldReturn = true
}

// --- 2. native dialog without a window --------------------------------------
const dialogLog = []
page.on('dialog', async (d) => {
  dialogLog.push({ type: d.type(), message: d.message() })
  await d.accept('typed-by-test').catch(async () => {
    await d.dismiss().catch(() => {})
  })
})

async function dialogRoundTrip() {
  await page.setContent('<html><body><button id=b>go</button></body></html>')
  const result = await page.evaluate(() => {
    const answer = prompt('probe-prompt', 'default')
    return 'prompt-returned:' + String(answer)
  })
  return result
}
try {
  out.dialog = { evaluateResult: await dialogRoundTrip(), events: dialogLog }
} catch (e) {
  out.dialog = { error: String(e?.message ?? e).split('\n')[0], events: dialogLog }
}

// --- 3. file input without an OS picker ------------------------------------
try {
  const tmpFile = path.join(os.tmpdir(), 'pw-upload-probe.txt')
  fs.writeFileSync(tmpFile, 'upload-probe')
  await page.setContent('<html><body><input id=f type=file></body></html>')
  await page.setInputFiles('#f', tmpFile)
  out.fileInput = {
    ok: true,
    files: await page.evaluate(() => Array.from(document.querySelector('#f').files).map((f) => f.name)),
  }
} catch (e) {
  out.fileInput = { ok: false, error: String(e?.message ?? e).split('\n')[0] }
}

console.log(JSON.stringify(out, null, 2))
await context.close()
fs.rmSync(profile, { recursive: true, force: true })
