/**
 * 「已登录站点」的只读推断：把 cookie 按可注册域聚合、打分，供设置页展示。
 *
 * 红线（写给下一个改这个文件的人）：
 *   1. **永不输出 cookie 的值，也不输出 cookie 的名字。** 出去的东西只有域名、条数和几个
 *      布尔信号；名字只在本模块内部用于打分。设备里存着的东西不因为它被"看一眼"就安全，
 *      所以这份数据一旦离开进程就不该再含有可冒用的内容。
 *   2. **不读 Chrome 的密码库**（Login Data）。这里只碰 cookie，且只碰浏览器自己给的那份。
 *   3. **这份数据不给模型看。** 它只经由设置页的路由出去；不注册工具、不写进 diagnostics。
 *
 * 另一个诚实的说明：**cookie 存在 ≠ 登录着**。任何网站都会塞分析/风控 cookie，所以先按
 * 名字剔除tracker（否则每个访问过的站看起来都像"已登录"），再按 httpOnly / 有效期 /
 * 名字特征打分，最后只给"推测"结论（`likely`），不打包票。
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
}
/** One aggregated site. Contains no cookie names and no values. */
export interface LoginSite {
    /** Registrable domain, e.g. `github.com` or `x.co.uk`. */
    domain: string;
    /** Non-tracker cookies seen for this domain. */
    cookies: number;
    httpOnly: number;
    /** Expiry more than a week out. */
    longLived: number;
    /** Session cookies (dropped when the browser closes). */
    sessionLike: number;
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
    /** Non-tracker cookies counted across all sites. */
    cookies: number;
    /** Total sites seen (before the display cap). */
    total: number;
    /** The capped, sorted list actually shown. */
    sites: LoginSite[];
}
/** Whether a whole host is an analytics/CDN endpoint rather than a site you log into. */
export declare function isTrackerHost(host: string): boolean;
/**
 * Collapse a cookie host to its registrable domain. `www.x.com`, `.x.com` and `a.b.x.com`
 * all become `x.com`; `a.x.co.uk` becomes `x.co.uk`.
 * @param host - the cookie's `domain` (may carry a leading dot).
 * @returns the registrable domain, lowercased.
 */
export declare function registrableDomain(host: string): string;
/** Whether a cookie name belongs to the always-present analytics/consent family. */
export declare function isTracker(name: string): boolean;
/**
 * Aggregate cookies into per-domain login inferences. Trackers are dropped, never counted,
 * and never surfaced; only counts and boolean signals leave this function.
 * @param rows - cookies as read from the browser (or the last exported state file).
 * @param source - where those cookies came from, for the card's label.
 * @param now - epoch ms, injectable so tests are not time-dependent.
 * @param maxSites - display cap; defaults to {@link MAX_SITES}.
 * @returns the display payload.
 */
export declare function summarizeLoginSites(rows: readonly CookieRow[], source: 'live' | 'snapshot', now: number, maxSites?: number): LoginSites;
