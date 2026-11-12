/**
 * Proxy support for the browser launch (2026-11-12).
 *
 * The plugin starts its own Chromium-family browser, so a proxy has to go into the
 * **launch** options (`launchOptions.proxy`) — request headers cannot route a whole
 * browser. Measured here: Wikipedia through a proxy answered in 4.4 s; direct it timed
 * out at 15 s, which is what every proxied site looked like before this.
 *
 * Three rules, each with a reason:
 *
 * 1. **Empty means direct.** No configured proxy keeps today's behaviour exactly.
 * 2. **`bypass` always includes the local addresses.** Without it the plugin's own
 *    `127.0.0.1` pages (verify, the MiniWoB sweep, any local server) would be pushed
 *    through the proxy and fail. Playwright passes `bypass` straight to Chromium's
 *    proxy bypass list.
 * 3. **A bad address is an error, never a silent fallback to direct.** Quietly going
 *    direct would look like "the site is down" and send the user debugging the wrong thing.
 *
 * Authentication is deliberately **not** supported in this version: a password in the
 * config would be stored in plain text in the user's `cordis.patch.yml`, and Playwright
 * refuses SOCKS5 authentication outright (`Browser does not support socks5 proxy
 * authentication`). Rather than ship a plaintext password path, credentials are rejected
 * here with a message that says why.
 *
 * @module dsh-browser-playwright-codex/proxy
 */
/** The shape Playwright accepts in `launchOptions.proxy`. */
export interface LaunchProxy {
    /** `http://host:port`, `https://host:port` or `socks5://host:port`. */
    server: string;
    /** Local addresses bypass the proxy, so the plugin's own local pages keep working. */
    bypass: string;
}
/** Hosts that must never be proxied (the plugin's own local pages live there). */
export declare const PROXY_BYPASS = "localhost,127.0.0.1";
/**
 * Turn a configured proxy address into Playwright's proxy object.
 *
 * Accepted shapes: `host:port` (treated as HTTP, like Playwright does), `http://host:port`,
 * `https://host:port`, `socks5://host:port`. The port is required and must be 1–65535.
 *
 * @param raw - the configured value; empty/undefined means "connect directly"
 * @returns the proxy settings (server + local bypass), or undefined for a direct connection
 * @throws Error with an actionable message when the address cannot be used
 */
export declare function normalizeProxy(raw: string | undefined | null): LaunchProxy | undefined;
/**
 * The spread-in fragment for Playwright's launch options: `{}` when direct,
 * `{ proxy: … }` when configured. Every launch path uses this so they cannot drift.
 *
 * @param raw - the configured proxy value
 * @returns an object to spread into the launch options
 */
export declare function proxyLaunchOption(raw: string | undefined | null): {
    proxy?: LaunchProxy;
};
