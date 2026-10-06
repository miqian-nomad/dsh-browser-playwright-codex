/**
 * 浏览器窗口生命周期：窗口最小化判定、后台页创建。
 * @module dsh-browser-playwright-codex/browser-lifecycle
 */
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
  let session
  try {
    session = await page.context().newCDPSession(page)
    const { windowId } = await session.send('Browser.getWindowForTarget')
    const { bounds } = await session.send('Browser.getWindowBounds', { windowId })
    return bounds.windowState === 'minimized'
  } catch {
    return true
  } finally {
    await session?.detach().catch(() => {})
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
  let session
  try {
    session = await context.newCDPSession(anchor)
    // Arm the listener before sending: Playwright attaches as soon as the
    // target exists, which can happen before createTarget resolves.
    const attached = context.waitForEvent('page', { timeout: 10000 })
    await session.send('Target.createTarget', { url: 'about:blank', background: true })
    return await attached
  } catch {
    return await context.newPage()
  } finally {
    await session?.detach().catch(() => {})
  }
}
