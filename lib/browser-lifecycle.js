/**
 * 浏览器的生命：启动/复用持久化 context、清理 Chrome 锁、以及启动与 profile 相关参数。
 * 窗口**焦点**行为（承载窗口是否最小化、要不要在后台建标签）在 window-focus.ts。
 * @module dsh-browser-playwright-codex/browser-lifecycle
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { AUTO_CHANNELS, HUMANIZED_LAUNCH } from "./config.js";
import { proxyLaunchOption } from "./proxy.js";
import { SNAPSHOT_SCRIPT } from "./injected.js";
import { BrowserError, launchFailed } from "./errors.js";
import { forgetOnBrowserClose, showWelcome } from "./swarm-intro.js";
import { swarmBootScript } from "./swarm-curtain.js";
/**
 * Does this launch failure point at the sandbox rather than at the browser?
 *
 * Chromium reports a refused renderer sandbox in a handful of shapes and none
 * of them contains the word "sandbox": the broker fails, the child exits before
 * DevTools answers, and Playwright surfaces it as a closed target or a generic
 * launch failure. The match stays narrow on purpose — a wrong `executablePath`
 * ("executable doesn't exist") must fail fast instead of costing a second
 * 30-second attempt to reach the same answer.
 */
function sandboxMayBeTheCause(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /sandbox|Target page, context or browser has been closed|Target closed|browser has crashed|Failed to launch/i.test(message);
}
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
export async function ensureContext(provider) {
    const inFlight = provider.contextLaunch;
    if (inFlight !== undefined)
        return await inFlight;
    const launch = launchContext(provider).finally(() => {
        if (provider.contextLaunch === launch)
            provider.contextLaunch = undefined;
    });
    provider.contextLaunch = launch;
    return await launch;
}
/** The actual launch, shared by every concurrent {@link ensureContext} caller. */
async function launchContext(provider) {
    if (provider.context !== undefined) {
        try {
            const browser = provider.context.browser();
            if (browser !== null && browser.isConnected())
                return provider.context;
        }
        catch {
            /* context died underneath us: relaunch */
        }
        provider.context = undefined;
    }
    fs.mkdirSync(provider.profileDir, { recursive: true });
    const { executablePath, channel } = provider.config.launch;
    const headless = provider.desiredHeadless();
    const headful = !headless;
    const attempts = [];
    // launchPersistentContext waits forever by default (issue #5): a profile another
    // process is holding, a stalled singleton handshake or a wedged GPU init hangs
    // acquire() with no deadline at all. navigationTimeoutMs is the only time scale
    // the user can tune, but it may legitimately be as low as 1s (navigation), which
    // is far too short for a cold Chrome start — so the launch deadline never drops
    // below 30s.
    const launchTimeoutMs = Math.max(provider.config.launch.navigationTimeoutMs, 30_000);
    const baseOptions = {
        headless,
        timeout: launchTimeoutMs,
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
        // Playwright adds --no-sandbox unless this is exactly `true`, and Chrome
        // answers --no-sandbox with an infobar across the top of every window
        // ("您使用的是不受支持的命令行标记：--no-sandbox"). Passing it also keeps the
        // renderer sandbox on, which is the safer state anyway: the bar is the
        // symptom, not the reason.
        chromiumSandbox: true,
        // Proxy at the browser level (launchOptions.proxy): request headers cannot route a whole
        // browser. Empty proxy yields {} so the default stays a direct connection.
        ...proxyLaunchOption(provider.config.launch.proxy),
        ...HUMANIZED_LAUNCH,
        args: [
            '--no-first-run',
            '--no-default-browser-check',
            // Open maximised like a human would, so the first paint fills
            // the screen instead of a small default window.
            ...(headful ? ['--start-maximized'] : []),
            ...HUMANIZED_LAUNCH.args,
        ],
    };
    const start = async (extra) => {
        const attempt = (sandbox) => chromium.launchPersistentContext(provider.profileDir, {
            ...baseOptions,
            ...extra,
            ...(sandbox ? {} : { chromiumSandbox: false }),
        });
        try {
            provider.context = await attempt(true);
            provider.launchedHeadless = headless;
        }
        catch (error) {
            // Another launch may have won while this one was starting (an explicit
            // `dispose()` racing a fresh acquire, a second provider on the same
            // profile). Hand back that window: clearing the lock files it is running
            // on would let a later launch start a SECOND browser on this profile.
            if (provider.context !== undefined)
                return provider.context;
            // A stale Chrome singleton lock from a dirty shutdown breaks a relaunch
            // into the same profile; clear the lock files and retry once before
            // surfacing the failure.
            // Playwright reports the same situation as a timeout ("browserType.launchPersistentContext:
            // Timeout 30000ms exceeded") rather than as a lock message, so match both shapes
            // or the retry never fires against the profile lock it was written for.
            if (error instanceof Error &&
                /user data directory|SingletonLock|ProcessSingleton|Timeout \d+ms exceeded/i.test(error.message)) {
                await provider.clearChromeLocks();
                provider.context = await attempt(true);
                provider.launchedHeadless = headless;
            }
            else if (sandboxMayBeTheCause(error)) {
                // The sandbox is a capability of the host, not of this plugin: a
                // Windows session without the desktop token it needs (some service
                // contexts), a locked-down container, or an AV product that blocks the
                // broker can all refuse it. Losing the sandbox costs a security layer;
                // losing the launch costs the whole browser — so step down, and only
                // once, rather than turning a warning into a hard failure.
                provider.sandboxFallback = true;
                provider.context = await attempt(false);
                provider.launchedHeadless = headless;
            }
            else {
                throw error;
            }
        }
        const ctx = provider.context;
        // External close (user closed the window, crash): forget every
        // session handle bound to this context; the next acquire relaunches.
        void ctx.on('close', () => {
            // 整个插件浏览器窗口关掉：默认忘掉这趟播过哪些站，下次重开全部重播。
            forgetOnBrowserClose(ctx);
            if (provider.context !== ctx)
                return;
            provider.context = undefined;
            for (const [key, entry] of [...provider.entries]) {
                if (entry.context !== ctx)
                    continue;
                if (entry.timer !== undefined)
                    clearTimeout(entry.timer);
                provider.entries.delete(key);
            }
        });
        ctx.on('page', (page) => provider.armDialogGuard(page));
        try {
            await provider.restoreState(ctx);
        }
        catch {
            /* malformed state file must not block startup */
        }
        // Allow-list on the wire: registered before the first navigation, so a
        // page cannot leave the list by itself (navigation-guard.ts).
        await provider.installHostGuard(ctx);
        await ctx.addInitScript(SNAPSHOT_SCRIPT);
        // 共享窗口（persistent）这条路也要注册「同一个引擎」的提前启动脚本。
        // 之前只加在 provider.ts 的 newContext 分支，用户实际用的是这里，
        // 第一帧脚本根本没注册 —— 标记留在 window.name 里没被消费（2026-11-09 实测）。
        await ctx.addInitScript({ content: swarmBootScript() });
        // The initial blank page predates addInitScript: reload so the
        // snapshot engine and restored localStorage apply on first use.
        for (const page of ctx.pages()) {
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
        }
        // 刚开的窗口停在 about:blank —— 一张纯白占位页。换成启动卡片，并让光标把
        // 它画一遍。只处理还没去任何网址的初始页，不动已恢复的标签。
        const firstPage = ctx.pages()[0];
        if (firstPage !== undefined && firstPage.url() === 'about:blank') {
            await showWelcome(firstPage, provider.config);
        }
        return ctx;
    };
    if (executablePath !== undefined) {
        try {
            return await start({ executablePath });
        }
        catch (error) {
            provider.launchError = error;
            attempts.push('executablePath ' + executablePath);
        }
    }
    else {
        const channels = channel !== undefined && channel !== '' ? [channel] : [...AUTO_CHANNELS];
        for (const candidate of channels) {
            try {
                return await start({ channel: candidate });
            }
            catch (error) {
                provider.launchError = error;
                attempts.push('channel ' + candidate);
            }
        }
    }
    const hint = 'Tried: ' +
        attempts.join(', ') +
        '. ' +
        'Install a Chromium-family browser, or run: npx playwright-core install chromium ' +
        '(in restricted networks set PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright), ' +
        'or configure launch.channel / launch.executablePath.';
    if (provider.launchError instanceof Error &&
        /executable doesn't exist|not found/i.test(provider.launchError.message)) {
        throw new BrowserError('NO_BROWSER', hint);
    }
    throw launchFailed(provider.launchError);
}
/** Remove stale Chrome singleton lock files inside the profile directory. */
export async function clearChromeLocks(provider) {
    for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try {
            fs.rmSync(path.join(provider.profileDir, lock), { force: true });
        }
        catch {
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
export async function ensureBrowser(provider) {
    const inFlight = provider.browserLaunch;
    if (inFlight !== undefined)
        return await inFlight;
    const launch = launchBrowser(provider).finally(() => {
        if (provider.browserLaunch === launch)
            provider.browserLaunch = undefined;
    });
    provider.browserLaunch = launch;
    return await launch;
}
/** The actual launch, shared by every concurrent {@link ensureBrowser} caller. */
async function launchBrowser(provider) {
    if (provider.browser !== undefined)
        return provider.browser;
    const { executablePath, channel } = provider.config.launch;
    const headless = provider.desiredHeadless();
    const attempts = [];
    /**
     * Launch with the renderer sandbox on, and step down to no-sandbox once when
     * the host refuses it. See {@link sandboxMayBeTheCause}: the sandbox is the
     * host's capability, so refusing to launch without it would turn one blocked
     * syscall into "the plugin does not work".
     */
    const launchWithSandboxFallback = async (options) => {
        try {
            return await chromium.launch({ ...options, chromiumSandbox: true });
        }
        catch (error) {
            if (!sandboxMayBeTheCause(error))
                throw error;
            provider.sandboxFallback = true;
            return await chromium.launch({ ...options, chromiumSandbox: false });
        }
    };
    if (executablePath !== undefined) {
        try {
            provider.browser = await launchWithSandboxFallback({
                executablePath,
                headless,
                ...HUMANIZED_LAUNCH,
                ...proxyLaunchOption(provider.config.launch.proxy),
            });
            provider.launchedHeadless = headless;
            return provider.browser;
        }
        catch (error) {
            provider.launchError = error;
            attempts.push('executablePath ' + executablePath);
        }
    }
    else {
        const channels = channel !== undefined && channel !== '' ? [channel] : [...AUTO_CHANNELS];
        for (const candidate of channels) {
            try {
                provider.browser = await launchWithSandboxFallback({
                    channel: candidate,
                    headless,
                    ...HUMANIZED_LAUNCH,
                    ...proxyLaunchOption(provider.config.launch.proxy),
                });
                provider.launchedHeadless = headless;
                return provider.browser;
            }
            catch (error) {
                provider.launchError = error;
                attempts.push('channel ' + candidate);
            }
        }
    }
    const hint = 'Tried: ' +
        attempts.join(', ') +
        '. ' +
        'Install a Chromium-family browser, or run: npx playwright-core install chromium ' +
        '(in restricted networks set PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright), ' +
        'or configure launch.channel / launch.executablePath.';
    if (provider.launchError instanceof Error &&
        /executable doesn't exist|not found/i.test(provider.launchError.message)) {
        throw new BrowserError('NO_BROWSER', hint);
    }
    throw launchFailed(provider.launchError);
}
