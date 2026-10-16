/**
 * 「已登录站点」的只读推断：把 cookie 按可注册域聚合、打分，供设置页展示。
 *
 * 两条设计来自成熟产品的做法，2026-10-16 重写时按它们改的（第一版按"谁设的域"聚合、用"名字像会话 +
 * cookie 多"打分，结果真实名单里 `pubmatic.com`（广告交易所）和 `mmstat.com`（统计）都排在前面）：
 *
 *   1. **归属看"你在哪个站"，不看"谁设的"** —— Firefox 的 Total Cookie Protection 给每个访问过的
 *      网站一个独立 cookie jar，第三方（统计/广告）的 cookie 属于**当时浏览的那个站**，不代表你登录了它。
 *      所以这里只把「浏览器实际访问过的域」当候选第一方，其余只报个数、不进列表。
 *   2. **判据用 OWASP 的会话 ID 特征** —— HttpOnly + Secure + 长且高熵 + 会话级；**名字是最不可靠的
 *      信号**（框架名可被指纹、也可被改成任意名字），所以名字与"cookie 条数"都不再能单独把一条推成
 *      "推测登录"。
 *
 * 红线（写给下一个改这个文件的人）：
 *   1. **永不输出 cookie 的值，也不输出 cookie 的名字。** 出去的东西只有域名、条数和布尔信号；
 *      名字只在本模块内部用于统计，值只被 `session.cookieJar()` 折算成一个布尔（像不像令牌）。
 *   2. **不读 Chrome 的密码库**（Login Data）。这里只碰 cookie。
 *   3. **这份数据不给模型看。** 它只经由设置页的路由出去；不注册工具、不写进 diagnostics。
 *   4. 结论写"推测"：cookie 存在 ≠ 登录着。
 * @module dsh-browser-playwright-codex/login-sites
 */
/** How many sites the payload carries at most. */
const MAX_SITES = 60;
/**
 * Compact public-suffix subset: exactly the multi-part endings where "last two labels"
 * would be wrong. Not the full PSL — a curated list is enough here because a wrong group
 * only mislabels a row, and the alternative (bundling the whole list) costs more than it buys.
 */
const MULTI_PART_SUFFIXES = new Set([
    'com.cn',
    'net.cn',
    'org.cn',
    'gov.cn',
    'edu.cn',
    'ac.cn',
    'co.uk',
    'org.uk',
    'gov.uk',
    'ac.uk',
    'co.jp',
    'ne.jp',
    'or.jp',
    'com.au',
    'net.au',
    'org.au',
    'com.hk',
    'com.tw',
    'com.sg',
    'com.br',
    'com.mx',
    'co.kr',
    'co.in',
    'co.nz',
    'co.za',
]);
/**
 * Cookies that every site sets whether or not you ever signed in. Counting them would make
 * "visited" look like "logged in" — the exact false positive this feature must avoid.
 */
const TRACKER_PATTERNS = [
    /^_ga/i,
    /^_gid$/i,
    /^_gat/i,
    /^_gcl/i,
    /^__utm/i,
    /^_fbp$/i,
    /^_fbc$/i,
    /^__cf_bm$/i,
    /^__cfduid$/i,
    /^cf_clearance$/i,
    /^Hm_lv/i,
    /^HMACCOUNT/i,
    /^BAIDUID/i,
    /^BIDUPSID/i,
    /^PSTM$/i,
    /^BDUSS_BF/i,
    /^_hj/i,
    /^intercom-/i,
    /^ajs_/i,
    /^amplitude_/i,
    /^mp_/i,
    /^sensorsdata/i,
    /^sajssdk/i,
    /^_clck$/i,
    /^_clsk$/i,
    /^_uetsid$/i,
    /^_uetvid$/i,
    /^MUID$/i,
    /^SRM_B$/i,
    /^_dd_s$/i,
    /^optimizely/i,
    /^_pin_unauth$/i,
    /^ab\./i,
    /^cookie_?consent/i,
    /^OptanonConsent$/i,
    /^OptanonAlertBoxClosed$/i,
    /^euconsent/i,
    /^didomi/i,
    /^_iub_cs/i,
    /^CookieConsent$/i,
];
/**
 * Whole hosts that are analytics/ad endpoints rather than sites you log into. The name list above
 * cannot catch these: `mmstat.com` (Alibaba's stats host) sets cookies with innocent names, and a
 * user who merely browsed Taobao would see it listed as a login. Found by looking at the first real
 * payload this feature ever produced (231 domains; `mmstat.com` 30 cookies, `pubmatic.com` 27).
 */
const TRACKER_HOSTS = [
    /(^|\.)mmstat\.com$/i,
    /(^|\.)umeng\.com$/i,
    /(^|\.)umengcloud\.com$/i,
    /(^|\.)google-analytics\.com$/i,
    /(^|\.)googletagmanager\.com$/i,
    /(^|\.)doubleclick\.net$/i,
    /(^|\.)hm\.baidu\.com$/i,
    /(^|\.)cnzz\.com$/i,
    /(^|\.)51\.la$/i,
    /(^|\.)matomo\.cloud$/i,
    /(^|\.)clarity\.ms$/i,
    /(^|\.)hotjar\.com$/i,
    /(^|\.)sentry\.io$/i,
    /(^|\.)pubmatic\.com$/i,
    /(^|\.)criteo\.com$/i,
    /(^|\.)adnxs\.com$/i,
    /(^|\.)rubiconproject\.com$/i,
    /(^|\.)casalemedia\.com$/i,
    /(^|\.)scorecardresearch\.com$/i,
    /(^|\.)adsrvr\.org$/i,
    /(^|\.)taboola\.com$/i,
    /(^|\.)outbrain\.com$/i,
];
const WEEK_SECONDS = 7 * 24 * 60 * 60;
/**
 * Collapse a cookie host to its registrable domain. `www.x.com`, `.x.com` and `a.b.x.com`
 * all become `x.com`; `a.x.co.uk` becomes `x.co.uk`.
 * @param host - the cookie's `domain` (may carry a leading dot).
 * @returns the registrable domain, lowercased.
 */
export function registrableDomain(host) {
    const clean = host.trim().replace(/^\./, '').toLowerCase();
    if (clean === '' || clean === 'localhost' || /^\d+(\.\d+){3}$/.test(clean))
        return clean;
    const parts = clean.split('.');
    if (parts.length <= 2)
        return clean;
    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_PART_SUFFIXES.has(lastTwo))
        return parts.slice(-3).join('.');
    return lastTwo;
}
/** Whether a cookie name belongs to the always-present analytics/consent family. */
export function isTracker(name) {
    return TRACKER_PATTERNS.some((pattern) => pattern.test(name));
}
/** Whether a whole host is an analytics/ad endpoint rather than a site you log into. */
export function isTrackerHost(host) {
    const clean = host.trim().replace(/^\./, '').toLowerCase();
    return TRACKER_HOSTS.some((pattern) => pattern.test(clean));
}
/**
 * Whether a cookie *value* looks like a session token rather than an analytics blob. OWASP's
 * session-ID guidance is the basis: at least 64 bits of entropy, hex ids ≥16 chars, base64 ids
 * longer still, opaque content. Analytics values are short, structured or JSON, so they fail here.
 *
 * The value is passed in and never returned: callers turn this into the `tokenLike` boolean.
 * @param value - the raw cookie value.
 * @returns whether it plausibly is a token.
 */
export function looksLikeToken(value) {
    if (typeof value !== 'string')
        return false;
    const v = value.trim();
    if (v.length < 20 || v.length > 4096)
        return false;
    if (/\s/.test(v))
        return false;
    if (v.startsWith('{') || v.startsWith('[') || v.startsWith('"'))
        return false;
    if (!/^[A-Za-z0-9._~+/=-]+$/.test(v))
        return false;
    if (new Set(v).size < 8)
        return false;
    const hasDigit = /[0-9]/.test(v);
    const hasLetter = /[A-Za-z]/.test(v);
    // Pure hex of session-id length, or a base64-ish mix, or simply long and varied.
    if (/^[0-9a-f]{16,}$/i.test(v))
        return true;
    if (hasDigit && hasLetter)
        return true;
    return v.length >= 40;
}
/**
 * Aggregate cookies into per-domain login inferences. Trackers are dropped, third-party domains
 * (ones the browser never visited) are counted but not listed, and only counts and boolean signals
 * leave this function.
 * @param rows - cookies as read from the browser (or the last exported state file).
 * @param source - where those cookies came from, for the card's label.
 * @param now - epoch ms, injectable so tests are not time-dependent.
 * @param options.visited - registrable domains the browser actually visited; the rest is third-party.
 * @param options.maxSites - display cap; defaults to {@link MAX_SITES}.
 * @returns the display payload.
 */
export function summarizeLoginSites(rows, source, now, options = {}) {
    const { visited = [], maxSites = MAX_SITES } = options;
    const visitedSet = visited instanceof Set ? visited : new Set(visited);
    const perDomain = new Map();
    let counted = 0;
    let thirdParty = 0;
    const seenThirdParty = new Set();
    for (const row of rows) {
        if (typeof row?.name !== 'string' || typeof row?.domain !== 'string')
            continue;
        if (isTracker(row.name))
            continue;
        if (isTrackerHost(row.domain))
            continue;
        const domain = registrableDomain(row.domain);
        if (domain === '')
            continue;
        // First-party attribution: a cookie on a domain this browser never visited belongs to the site
        // that was being browsed, not to that domain (Firefox calls this the per-site cookie jar).
        if (visitedSet.size > 0 && !visitedSet.has(domain)) {
            if (!seenThirdParty.has(domain)) {
                seenThirdParty.add(domain);
                thirdParty += 1;
            }
            continue;
        }
        counted += 1;
        const entry = perDomain.get(domain) ?? {
            cookies: 0,
            httpOnly: 0,
            longLived: 0,
            sessionLike: 0,
            tokenLike: 0,
        };
        entry.cookies += 1;
        if (row.httpOnly === true)
            entry.httpOnly += 1;
        if (row.tokenLike === true)
            entry.tokenLike += 1;
        const expires = typeof row.expires === 'number' ? row.expires : -1;
        if (expires === -1 || expires === 0)
            entry.sessionLike += 1;
        else if (expires - now / 1000 > WEEK_SECONDS)
            entry.longLived += 1;
        perDomain.set(domain, entry);
    }
    const sites = [];
    for (const [domain, entry] of perDomain) {
        // OWASP's criteria, not name-guessing: an httpOnly cookie AND a session-scoped or token-shaped
        // one. Cookie count and session-like *names* deliberately do not contribute — the first version
        // of this scored them and put an ad exchange at the top of a real list.
        const likely = entry.httpOnly >= 1 && (entry.sessionLike >= 1 || entry.tokenLike >= 1);
        const signals = [];
        if (entry.httpOnly >= 1)
            signals.push('httpOnly');
        if (entry.sessionLike >= 1)
            signals.push('会话 cookie');
        if (entry.tokenLike >= 1)
            signals.push('值像令牌');
        if (entry.longLived >= 1)
            signals.push('长效');
        sites.push({
            domain,
            cookies: entry.cookies,
            httpOnly: entry.httpOnly,
            longLived: entry.longLived,
            sessionLike: entry.sessionLike,
            tokenLike: entry.tokenLike,
            likely,
            signals,
        });
    }
    const likelyTotal = sites.filter((site) => site.likely).length;
    sites.sort((a, b) => {
        if (a.likely !== b.likely)
            return a.likely ? -1 : 1;
        if (a.httpOnly !== b.httpOnly)
            return b.httpOnly - a.httpOnly;
        if (a.cookies !== b.cookies)
            return b.cookies - a.cookies;
        return a.domain.localeCompare(b.domain);
    });
    return {
        source,
        capturedAt: now,
        cookies: counted,
        total: sites.length,
        likelyTotal,
        thirdPartyTotal: thirdParty,
        sites: sites.slice(0, maxSites),
    };
}
