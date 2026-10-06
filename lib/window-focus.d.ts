/**
 * 窗口与焦点行为：判断承载页面的系统窗口是否最小化、以及在后台创建标签页。两项都是为了让窗口/标签不打扰用户（背景与实测见 FOCUS-STEALING.md）。
 * @module dsh-browser-playwright-codex/window-focus
 */
import type { BrowserContext, Page } from 'playwright-core';
/**
 * True when the OS window hosting this page is minimized. Tab selection lives
 * in the browser context, not in the OS window, so activation is a side effect
 * we are free to decline — and declining it is what keeps the agent from
 * yanking a minimized window into the user's face. If the window state cannot
 * be read we answer true (treat as minimized): the safe direction is to leave
 * the user's desktop alone, and a skipped bringToFront costs nothing functional.
 */
export declare function isWindowMinimized(page: Page): Promise<boolean>;
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
export declare function createBackgroundPage(context: BrowserContext): Promise<Page>;
