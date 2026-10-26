/**
 * 浏览器的生命：启动/复用持久化 context、清理 Chrome 锁、以及启动与 profile 相关参数。
 * 窗口**焦点**行为（承载窗口是否最小化、要不要在后台建标签）在 window-focus.ts。
 * @module dsh-browser-playwright-codex/browser-lifecycle
 */
import { chromium } from 'playwright-core'
import path from 'node:path'
import fs from 'node:fs'
import type { PlaywrightProvider } from './provider.ts'
import { AUTO_CHANNELS, HUMANIZED_LAUNCH } from './config.ts'
import { SNAPSHOT_SCRIPT } from './injected.ts'
import { BrowserError, launchFailed } from './errors.ts'

/**
 * Ensure the shared persistent context is alive (persistent mode). A
 * profile-backed window is launched once and reused until closed by the
 * last owner, idle disposal, or an external close; login state lives in
 * the profile plus the exported state file, so reopening is seamless.
 *
 * Concurrent callers share ONE launch. Without this, two sessions waking up at
 * the same moment both saw "no context" and both called launchPersistentContext
 * on the same profile directory: the loser died on Chrome's profile singleton,
 * the recovery path deleted the running browser's lock files, and the caller was
 * told "install a Chromium-family browser" (measured 2026-10-26).
 */
export async function ensureContext(provider: PlaywrightProvider) {
  const inFlight = provider.contextLaunch
  if (inFlight !== undefined) return await inFlight
  const launch = launchContext(provider).finally(() => {
    if (provider.contextLaunch === launch) provider.contextLaunch = undefined
  })
  provider.contextLaunch = launch
  return await launch
}

/** The actual launch, shared by every concurrent {@link ensureContext} caller. */
async function launchContext(provider: PlaywrightProvider) {
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
  const { executablePath, channel } = provider.config.launch
  const headless = provider.desiredHeadless()
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
      provider.launchedHeadless = headless
    } catch (error) {
      // Another launch may have won while this one was starting (an explicit
      // `dispose()` racing a fresh acquire, a second provider on the same
      // profile). Hand back that window: clearing the lock files it is running
      // on would let a later launch start a SECOND browser on this profile.
      if (provider.context !== undefined) return provider.context
      // A stale Chrome singleton lock from a dirty shutdown breaks a relaunch
      // into the same profile; clear the lock files and retry once before
      // surfacing the failure.
      if (error instanceof Error && /user data directory|SingletonLock|ProcessSingleton/i.test(error.message)) {
        await provider.clearChromeLocks()
        provider.context = await chromium.launchPersistentContext(provider.profileDir, { ...baseOptions, ...extra })
        provider.launchedHeadless = headless
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
    // Allow-list on the wire: registered before the first navigation, so a
    // page cannot leave the list by itself (navigation-guard.ts).
    await provider.installHostGuard(ctx)
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

/**
 * Launch the browser once, probing the configured or auto-detected channel.
 *
 * Concurrent callers share one launch, for the same reason ensureContext does:
 * otherwise two sessions wake up, both see `browser === undefined`, and two
 * browsers are launched (the reported "两个任务同时唤醒会多开浏览器").
 */
export async function ensureBrowser(provider: PlaywrightProvider) {
  const inFlight = provider.browserLaunch
  if (inFlight !== undefined) return await inFlight
  const launch = launchBrowser(provider).finally(() => {
    if (provider.browserLaunch === launch) provider.browserLaunch = undefined
  })
  provider.browserLaunch = launch
  return await launch
}

/** The actual launch, shared by every concurrent {@link ensureBrowser} caller. */
async function launchBrowser(provider: PlaywrightProvider) {
  if (provider.browser !== undefined) return provider.browser
  const { executablePath, channel } = provider.config.launch
  const headless = provider.desiredHeadless()
  const attempts = []
  if (executablePath !== undefined) {
    try {
      provider.browser = await chromium.launch({ executablePath, headless, ...HUMANIZED_LAUNCH })
      provider.launchedHeadless = headless
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
        provider.launchedHeadless = headless
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
