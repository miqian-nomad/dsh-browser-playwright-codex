/**
 * URL 策略：只允许访问白名单域名（含点击后导航的校验）。
 * @module dsh-browser-playwright-codex/url-policy
 */
import { BrowserError } from "./errors.js";
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
        const allowed = allowedDomains.some((suffix) => host === suffix || host.endsWith('.' + suffix));
        if (!allowed) {
            throw new BrowserError('URL_NOT_ALLOWED', 'host ' + parsed.hostname + ' is not in allowedDomains');
        }
    }
    return parsed;
}
