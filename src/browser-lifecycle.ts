/**
 * 浏览器窗口生命周期：窗口最小化判定、后台页创建。
 *
 * Scope note: this module is "the window's life", not only start/stop. isWindowMinimized() and
 * createBackgroundPage() live here on purpose — both exist to keep the *window* out of the user's
 * way (never steal focus, never pop a tab in front) and are meaningless apart from the launch
 * options right above them. They are started from the same place, tested together, and a reviewer
 * looking for "why did my window come forward" should find one file.
 * @module dsh-browser-playwright-codex/browser-lifecycle
 */
import { chromium } from 'playwright-core'
import path from 'node:path'
import fs from 'node:fs'
import type { PlaywrightProvider } from './provider.ts'
import { AUTO_CHANNELS, HUMANIZED_LAUNCH } from './config.ts'
import { SNAPSHOT_SCRIPT } from './injected.ts'
import { BrowserError, launchFailed } from './errors.ts'
import type { BrowserContext, Page } from 'playwright-core'

/**
 * True when the OS window hosting this page is minimized. Tab selection lives
 * in the browser context, not in the OS window, so activation is a side effect
 * we are free to decline — and declining it is what keeps the agent from
 * yanking a minimized window into the user's face. If the window state cannot
 * be read we answer true (treat as minimized): the safe direction is to leave
 * the user's desktop alone, and a skipped bringToFront costs nothing functional.
 */
export async function isWindowMinimized(page: Page) {
  let provider
  try {
    provider = await page.context().newCDPSession(page)
    const { windowId } = await provider.send('Browser.getWindowForTarget')
    const { bounds } = await provider.send('Browser.getWindowBounds', { windowId })
    return bounds.windowState === 'minimized'
  } catch {
    return true
  } finally {
    await provider?.detach().catch(() => {})
  }
}

/**
 * Create a tab without raising the window. context.newPage() routes through CDP
 * Target.createTarget without `background`, and Chromium activates the window
 * on every tab creation -- plainly visible once the user has minimized it.
 * Sending the command ourselves with background:true creates the tab silently;
 * Playwright still auto-attaches and returns a fully driveable Page (verified
 * live: Playwright learns the page and evaluate() runs on it). The URL is left
 * at about:blank on purpose so the caller's own goto keeps owning navigation
 * policy, timeouts and abort handling. On any failure this falls back to
 * newPage(): a tab that pops the window beats no tab at all.
 */
export async function createBackgroundPage(context: BrowserContext) {
  const anchor = context.pages()[0]
  if (anchor === undefined) return await context.newPage()
  let provider
  try {
    provider = await context.newCDPSession(anchor)
    // Arm the listener before sending: Playwright attaches as soon as the
    // target exists, which can happen before createTarget resolves.
    const attached = context.waitForEvent('page', { timeout: 10000 })
    await provider.send('Target.createTarget', { url: 'about:blank', background: true })
    return await attached
  } catch {
    return await context.newPage()
  } finally {
    await provider?.detach().catch(() => {})
  }
}

/**
 * Ensure the shared persistent context is alive (persistent mode). A
 * profile-backed window is launched once and reused until closed by the
 * last owner, idle disposal, or an external close; login state lives in
 * the profile plus the exported state file, so reopening is seamless.
 */
export async function ensureContext(provider: PlaywrightProvider) {
  if (provider.context !== undefined) {
    try {
      const browser = provider.context.browser()
      if (browser !== null && browser.isConnected()) return provider.context
    } catch {
      /* context died underneath us: relaunch */
    }
    provider.context = undefined
  }
  fs.mkdirSync(provider.profileDir, { recursive: true })
  const { executablePath, channel, headless } = provider.config.launch
  const headful = !headless
  const attempts = []
  const baseOptions = {
    headless,
    // Headful windows must render like a normal Chrome the user opened
    // by hand: the page viewport equals the real window size and the
    // system DPI scaling (e.g. 150%) is honoured. Playwright's default
    // is the opposite — it pins every page to a fixed CSS viewport at
    // deviceScaleFactor 1 via Emulation.setDeviceMetricsOverride, which
    // on scaled displays overflows the window: content looks zoomed in
    // and clipped. viewport: null disables that override entirely.
    // Headless mode keeps the fixed viewport (no window to track).
    ...(headless ? { viewport: provider.config.launch.viewport } : { viewport: null }),
    ignoreHTTPSErrors: provider.config.launch.ignoreHTTPSErrors,
    ...HUMANIZED_LAUNCH,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      // Open maximised like a human would, so the first paint fills
      // the screen instead of a small default window.
      ...(headful ? ['--start-maximized'] : []),
      ...HUMANIZED_LAUNCH.args,
    ],
  }
  const start = async (extra: Record<string, unknown>) => {
    try {
      provider.context = await chromium.launchPersistentContext(provider.profileDir, { ...baseOptions, ...extra })
    } catch (error) {
      // A stale Chrome singleton lock from a dirty shutdown breaks a
      // relaunch into the same profile; clear the lock files and
      // retry once before surfacing the failure.
      if (error instanceof Error && /user data directory|SingletonLock|ProcessSingleton/i.test(error.message)) {
        await provider.clearChromeLocks()
        provider.context = await chromium.launchPersistentContext(provider.profileDir, { ...baseOptions, ...extra })
      } else {
        throw error
      }
    }
    const ctx = provider.context
    // External close (user closed the window, crash): forget every
    // session handle bound to this context; the next acquire relaunches.
    void ctx.on('close', () => {
      if (provider.context !== ctx) return
      provider.context = undefined
      for (const [key, entry] of [...provider.entries]) {
        if (entry.context !== ctx) continue
        if (entry.timer !== undefined) clearTimeout(entry.timer)
        provider.entries.delete(key)
      }
    })
    ctx.on('page', (page) => provider.armDialogGuard(page))
    try {
      await provider.restoreState(ctx)
    } catch {
      /* malformed state file must not block startup */
    }
    await ctx.addInitScript(SNAPSHOT_SCRIPT)
    // The initial blank page predates addInitScript: reload so the
    // snapshot engine and restored localStorage apply on first use.
    for (const page of ctx.pages()) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    }
    return ctx
  }
  if (executablePath !== undefined) {
    try {
      return await start({ executablePath })
    } catch (error) {
      provider.launchError = error
      attempts.push('executablePath ' + executablePath)
    }
  } else {
    const channels = channel !== undefined && channel !== '' ? [channel] : [...AUTO_CHANNELS]
    for (const candidate of channels) {
      try {
        return await start({ channel: candidate })
      } catch (error) {
        provider.launchError = error
        attempts.push('channel ' + candidate)
      }
    }
  }
  const hint =
    'Tried: ' +
    attempts.join(', ') +
    '. ' +
    'Install a Chromium-family browser, or run: npx playwright-core install chromium ' +
    '(in restricted networks set PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright), ' +
    'or configure launch.channel / launch.executablePath.'
  if (
    provider.launchError instanceof Error &&
    /executable doesn't exist|not found/i.test(provider.launchError.message)
  ) {
    throw new BrowserError('NO_BROWSER', hint)
  }
  throw launchFailed(provider.launchError)
}

/** Remove stale Chrome singleton lock files inside the profile directory. */
export async function clearChromeLocks(provider: PlaywrightProvider) {
  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try {
      fs.rmSync(path.join(provider.profileDir, lock), { force: true })
    } catch {
      /* best-effort */
    }
  }
}

/** Launch the browser once, probing the configured or auto-detected channel. */
export async function ensureBrowser(provider: PlaywrightProvider) {
  if (provider.browser !== undefined) return provider.browser
  const { executablePath, channel, headless } = provider.config.launch
  const attempts = []
  if (executablePath !== undefined) {
    try {
      provider.browser = await chromium.launch({ executablePath, headless, ...HUMANIZED_LAUNCH })
      return provider.browser
    } catch (error) {
      provider.launchError = error
      attempts.push('executablePath ' + executablePath)
    }
  } else {
    const channels = channel !== undefined && channel !== '' ? [channel] : [...AUTO_CHANNELS]
    for (const candidate of channels) {
      try {
        provider.browser = await chromium.launch({ channel: candidate, headless, ...HUMANIZED_LAUNCH })
        return provider.browser
      } catch (error) {
        provider.launchError = error
        attempts.push('channel ' + candidate)
      }
    }
  }
  const hint =
    'Tried: ' +
    attempts.join(', ') +
    '. ' +
    'Install a Chromium-family browser, or run: npx playwright-core install chromium ' +
    '(in restricted networks set PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright), ' +
    'or configure launch.channel / launch.executablePath.'
  if (
    provider.launchError instanceof Error &&
    /executable doesn't exist|not found/i.test(provider.launchError.message)
  ) {
    throw new BrowserError('NO_BROWSER', hint)
  }
  throw launchFailed(provider.launchError)
}
