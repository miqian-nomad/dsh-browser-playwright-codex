/**
 * URL 策略：只允许访问白名单域名（含点击后导航的校验）。
 * @module dsh-browser-playwright-codex/url-policy
 */
import { BrowserError } from "./errors.js";
/**
 * Is this host inside the allow-list? Empty list means "any host".
 *
 * Suffix matching is deliberately anchored one level down: `example.com`
 * admits `example.com` and `a.example.com`, never `notexample.com` and never
 * `example.com.evil.net`. A configured entry is compared after
 * normalisation (lower case, leading dot dropped), because a user writing
 * `.example.com` means the domain, not a subdomain literally named "example".
 * @param host - hostname to test, e.g. "a.example.com".
 * @param allowedDomains - configured suffixes; empty means everything passes.
 * @returns true when the host is allowed.
 */
export function isHostAllowed(host, allowedDomains) {
    if (allowedDomains.length === 0)
        return true;
    const target = host.toLowerCase();
    return allowedDomains.some((raw) => {
        const suffix = raw.trim().toLowerCase().replace(/^\.+/, '');
        if (suffix === '')
            return false;
        return target === suffix || target.endsWith('.' + suffix);
    });
}
/** Validate one absolute URL against the navigation policy. */
export function assertAllowedUrl(raw, allowedDomains) {
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        throw new BrowserError('URL_NOT_ALLOWED', 'invalid URL: ' + raw);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new BrowserError('URL_NOT_ALLOWED', 'only http(s) URLs can be navigated, got: ' + parsed.protocol);
    }
    if (allowedDomains.length > 0) {
        const host = parsed.hostname.toLowerCase();
        if (!isHostAllowed(host, allowedDomains)) {
            throw new BrowserError('URL_NOT_ALLOWED', 'host ' + parsed.hostname + ' is not in allowedDomains');
        }
    }
    return parsed;
}
