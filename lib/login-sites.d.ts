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
/** The cookie fields this module may look at. `value` is deliberately absent. */
export interface CookieRow {
    name: string;
    domain: string;
    /** Unix seconds; -1 (or absent) marks a session cookie. */
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    /**
     * Whether the value looked like a session token (long, opaque, mixed alphabet). Computed by
     * `session.cookieJar()` from the value and reduced to a boolean there — the value itself never
     * leaves that function.
     */
    tokenLike?: boolean;
}
/** One aggregated site. Contains no cookie names and no values. */
export interface LoginSite {
    /** Registrable domain the browser actually visited. */
    domain: string;
    /** Non-tracker cookies seen for this domain. */
    cookies: number;
    httpOnly: number;
    /** Expiry more than a week out. */
    longLived: number;
    /** Session cookies (dropped when the browser closes). */
    sessionLike: number;
    /** Cookies whose value looked like a token. */
    tokenLike: number;
    /** Inference, not a fact: see the module header. */
    likely: boolean;
    /** Short labels explaining the score — never cookie names. */
    signals: string[];
}
/** What the settings card renders. */
export interface LoginSites {
    /** `live` = read from the open browser; `snapshot` = last exported state file. */
    source: 'live' | 'snapshot';
    /** Epoch ms when this summary was computed. */
    capturedAt: number;
    /** Non-tracker cookies counted across first-party domains. */
    cookies: number;
    /** First-party domains seen (before the display cap). */
    total: number;
    /** How many of those look signed in. */
    likelyTotal: number;
    /** Domains excluded because the browser never visited them (analytics/ad endpoints). */
    thirdPartyTotal: number;
    /**
     * Whether first-party attribution could be applied. `unfiltered` means no visited-domain set was
     * available (no live pages and no exported origins), so the list may contain third-party domains —
     * the card says so instead of silently looking authoritative. 2026-10-16: the offline run of the
     * real export file hit exactly this, and a silent fallback is how a feature overstates itself.
     */
    attribution: 'first-party' | 'unfiltered';
    /** The capped, sorted list actually shown. */
    sites: LoginSite[];
}
/**
 * Collapse a cookie host to its registrable domain. `www.x.com`, `.x.com` and `a.b.x.com`
 * all become `x.com`; `a.x.co.uk` becomes `x.co.uk`.
 * @param host - the cookie's `domain` (may carry a leading dot).
 * @returns the registrable domain, lowercased.
 */
export declare function registrableDomain(host: string): string;
/** Whether a cookie name belongs to the always-present analytics/consent family. */
export declare function isTracker(name: string): boolean;
/** Whether a whole host is an analytics/ad endpoint rather than a site you log into. */
export declare function isTrackerHost(host: string): boolean;
/**
 * Whether a cookie *value* looks like a session token rather than an analytics blob. OWASP's
 * session-ID guidance is the basis: at least 64 bits of entropy, hex ids ≥16 chars, base64 ids
 * longer still, opaque content. Analytics values are short, structured or JSON, so they fail here.
 *
 * The value is passed in and never returned: callers turn this into the `tokenLike` boolean.
 * @param value - the raw cookie value.
 * @returns whether it plausibly is a token.
 */
export declare function looksLikeToken(value: string): boolean;
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
export declare function summarizeLoginSites(rows: readonly CookieRow[], source: 'live' | 'snapshot', now: number, options?: {
    visited?: readonly string[] | ReadonlySet<string>;
    maxSites?: number;
}): LoginSites;
