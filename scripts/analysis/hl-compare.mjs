/**
 * Measures what actually differs between the plugin's headless and headful
 * launch shapes, on the SAME persistent profile, using the plugin's real
 * launch options (channel chrome, HUMANIZED_LAUNCH args, viewport rules).
 *
 *   MODE=headless|headful  PROFILE=<dir>  node hl-compare.mjs
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PW_CORE_PATH ?? 'playwright-core')

const MODE = process.env.MODE ?? 'headless'
const headless = MODE === 'headless'
const profile = process.env.PROFILE
const probeHtml = process.env.PROBE_HTML

// Mirror of the plugin's baseOptions (lib/playwright.js:437-457).
const HUMANIZED_LAUNCH = { args: ['--disable-blink-features=AutomationControlled'] }
const options = {
  headless,
  channel: process.env.CHANNEL || undefined,
  ...(headless ? { viewport: { width: 1280, height: 800 } } : { viewport: null }),
  ignoreHTTPSErrors: false,
  ...HUMANIZED_LAUNCH,
  args: [
    '--no-first-run',
    '--no-default-browser-check',
    ...(headless ? [] : ['--start-maximized']),
    ...HUMANIZED_LAUNCH.args,
    ...(process.env.EXTRA_ARG ? [process.env.EXTRA_ARG] : []),
  ],
}

const context = await chromium.launchPersistentContext(profile, options)
const page = context.pages()[0] ?? (await context.newPage())

// Persistent state continuity across a headless <-> headful switch.
if (process.env.PHASE === 'write') {
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' }).catch(() => {})
  await context.addCookies([
    { name: 'switch-session', value: 'session-42', domain: 'example.com', path: '/' },
    {
      name: 'switch-durable',
      value: 'durable-42',
      domain: 'example.com',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
    },
  ])
  await page.evaluate(() => localStorage.setItem('switch-probe', 'kept-42')).catch(() => {})
  console.log(JSON.stringify({ mode: MODE, phase: 'write', cookieSet: true }))
  await context.close()
  process.exit(0)
}

if (process.env.PHASE === 'check') {
  await page.goto('https://example.com', { waitUntil: 'domcontentloaded' }).catch(() => {})
  const cookies = await context.cookies('https://example.com')
  const ls = await page.evaluate(() => localStorage.getItem('switch-probe')).catch(() => null)
  console.log(
    JSON.stringify(
      {
        mode: MODE,
        phase: 'check',
        sessionCookie: cookies.find((c) => c.name === 'switch-session')?.value ?? null,
        durableCookie: cookies.find((c) => c.name === 'switch-durable')?.value ?? null,
        localStorage: ls,
      },
      null,
      2,
    ),
  )
  await context.close()
  process.exit(0)
}

await page.goto('file:///' + probeHtml.replace(/\\/g, '/'), { waitUntil: 'load' })

const measured = await page.evaluate(async () => {
  const box = document.querySelector('#box').getBoundingClientRect()
  const cjk = document.querySelector('#cjk').getBoundingClientRect()
  const tail = document.querySelector('#tail').getBoundingClientRect()
  const rafStart = performance.now()
  let rafCount = 0
  await new Promise((resolve) => {
    const tick = () => {
      rafCount += 1
      if (performance.now() - rafStart > 1000) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  return {
    ua: navigator.userAgent,
    webdriver: navigator.webdriver,
    inner: [window.innerWidth, window.innerHeight],
    outer: [window.outerWidth, window.outerHeight],
    screen: [screen.width, screen.height],
    avail: [screen.availWidth, screen.availHeight],
    dpr: window.devicePixelRatio,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
    rafPerSecond: rafCount,
    box: [Math.round(box.width), Math.round(box.height)],
    cjkWidth: Math.round(cjk.width * 100) / 100,
    tailY: Math.round(tail.top),
    fonts: document.fonts.size,
    // Media-feature fingerprint: Playwright's headless default args include
    // --blink-settings=primaryPointerType=4,availableHoverTypes=2.
    coarse: matchMedia('(pointer: coarse)').matches,
    fine: matchMedia('(pointer: fine)').matches,
    hoverHover: matchMedia('(hover: hover)').matches,
    anyHover: matchMedia('(any-hover: hover)').matches,
    maxTouchPoints: navigator.maxTouchPoints,
    languages: navigator.languages.join(','),
    breakpoints: {
      'min-width:1000px': matchMedia('(min-width: 1000px)').matches,
      'min-width:1152px': matchMedia('(min-width: 1152px)').matches,
      'min-width:1200px': matchMedia('(min-width: 1200px)').matches,
      'min-width:1280px': matchMedia('(min-width: 1280px)').matches,
      'min-width:1440px': matchMedia('(min-width: 1440px)').matches,
    },
  }
})

const shot = await page.screenshot({ path: path.join(path.dirname(profile), `shot-${MODE}.png`) })
const png = fs.readFileSync(path.join(path.dirname(profile), `shot-${MODE}.png`))
// PNG IHDR: width/height are bytes 16-23.
const shotW = png.readUInt32BE(16)
const shotH = png.readUInt32BE(20)

console.log(
  JSON.stringify(
    {
      mode: MODE,
      headless,
      ...measured,
      screenshotBytes: shot.length,
      screenshotSize: [shotW, shotH],
    },
    null,
    2,
  ),
)

await context.close()
