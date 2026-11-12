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
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'socks5:']);
/** Hosts that must never be proxied (the plugin's own local pages live there). */
export const PROXY_BYPASS = 'localhost,127.0.0.1';
/** One clear sentence for every rejection; the value is echoed so a typo is visible. */
function reject(value, why) {
    throw new Error('launch.proxy is not a usable proxy address (' +
        why +
        '): "' +
        value +
        '". ' +
        'Write it as scheme://host:port (or just host:port) — e.g. http://proxy.example:8080, ' +
        'https://proxy.example:8443 or socks5://proxy.example:1080. ' +
        'Leave it empty to connect directly. Authenticated proxies are not supported in this version.');
}
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
export function normalizeProxy(raw) {
    const value = (raw ?? '').trim();
    if (value === '')
        return undefined;
    // Credentials would have to live in plain text in the user's patch file, and SOCKS5
    // authentication is not supported by the browser anyway — refuse before launch.
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(value) || /^[^/?#]*@/.test(value)) {
        throw new Error('launch.proxy must not carry a username or password (found a credential in "' +
            value +
            '"). ' +
            'This version supports proxies WITHOUT authentication only: a password in the config ' +
            'would be stored in plain text in your patch file, and SOCKS5 authentication is not ' +
            'supported by Chromium/Playwright at all. Configure an unauthenticated proxy, or leave ' +
            'this empty to connect directly.');
    }
    // Short form: Playwright itself reads `host:port` as HTTP, so accept it the same way.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'http://' + value;
    // Check the port by hand first: `new URL('http://host:abc')` throws a generic message,
    // and "the port is not a number" is what the user needs to read.
    const hostPart = withScheme.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0] ?? '';
    const hostOnly = hostPart.split('?')[0] ?? '';
    const portText = (() => {
        if (hostOnly.startsWith('[')) {
            const close = hostOnly.indexOf(']');
            if (close === -1)
                return '';
            const rest = hostOnly.slice(close + 1);
            return rest.startsWith(':') ? rest.slice(1) : '';
        }
        const colon = hostOnly.lastIndexOf(':');
        return colon === -1 ? '' : hostOnly.slice(colon + 1);
    })();
    if (portText === '')
        reject(value, 'the port is missing');
    if (!/^\d+$/.test(portText ?? ''))
        reject(value, 'the port is not a number');
    // Check the range before `new URL` does: an out-of-range port makes the constructor
    // throw a generic error, and the useful sentence is "the port must be 1–65535".
    const portNumber = Number(portText);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        reject(value, 'the port must be 1–65535');
    }
    let url;
    try {
        url = new URL(withScheme);
    }
    catch {
        return reject(value, 'it does not parse as a URL');
    }
    if (!ALLOWED_SCHEMES.has(url.protocol.toLowerCase())) {
        reject(value, 'only http, https and socks5 are supported');
    }
    if (url.hostname === '')
        reject(value, 'the host is empty');
    if (url.port === '' || !/^\d+$/.test(url.port))
        reject(value, 'the port is not a number');
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        reject(value, 'the port must be 1–65535');
    // A non-special scheme (socks5) parses with an EMPTY pathname while http/https give '/',
    // so both are "no path". Anything else means the user appended something.
    if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
        reject(value, 'a proxy address has no path, query or fragment');
    }
    return {
        server: url.protocol + '//' + url.hostname + ':' + url.port,
        // Never proxy the plugin's own local pages.
        bypass: PROXY_BYPASS,
    };
}
/**
 * The spread-in fragment for Playwright's launch options: `{}` when direct,
 * `{ proxy: … }` when configured. Every launch path uses this so they cannot drift.
 *
 * @param raw - the configured proxy value
 * @returns an object to spread into the launch options
 */
export function proxyLaunchOption(raw) {
    const proxy = normalizeProxy(raw);
    return proxy === undefined ? {} : { proxy };
}
