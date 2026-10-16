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
  name: string
  domain: string
  /** Unix seconds; -1 (or absent) marks a session cookie. */
  expires?: number
  httpOnly?: boolean
  secure?: boolean
}

/** One aggregated site. Contains no cookie names and no values. */
export interface LoginSite {
  /** Registrable domain, e.g. `github.com` or `x.co.uk`. */
  domain: string
  /** Non-tracker cookies seen for this domain. */
  cookies: number
  httpOnly: number
  /** Expiry more than a week out. */
  longLived: number
  /** Session cookies (dropped when the browser closes). */
  sessionLike: number
  /** Inference, not a fact: see the module header. */
  likely: boolean
  /** Short labels explaining the score — never cookie names. */
  signals: string[]
}

/** What the settings card renders. */
export interface LoginSites {
  /** `live` = read from the open browser; `snapshot` = last exported state file. */
  source: 'live' | 'snapshot'
  /** Epoch ms when this summary was computed. */
  capturedAt: number
  /** Non-tracker cookies counted across all sites. */
  cookies: number
  /** Total sites seen (before the display cap). */
  total: number
  /** The capped, sorted list actually shown. */
  sites: LoginSite[]
}

/** How many sites the payload carries at most. */
const MAX_SITES = 60

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
])

/**
 * Cookies that every site sets whether or not you ever signed in. Counting them would make
 * "visited" look like "logged in" — the exact false positive this feature must avoid.
 */
const TRACKER_PATTERNS: readonly RegExp[] = [
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
]

/** Names that look like a server-side session / auth token. */
const SESSION_NAME =
  /(^|[._-])(sid|sess|session|sessionid|jsessionid|phpsessid|auth|token|jwt|ticket|login|remember|account|uid|user)([._-]|$)/i

const WEEK_SECONDS = 7 * 24 * 60 * 60

/**
 * Collapse a cookie host to its registrable domain. `www.x.com`, `.x.com` and `a.b.x.com`
 * all become `x.com`; `a.x.co.uk` becomes `x.co.uk`.
 * @param host - the cookie's `domain` (may carry a leading dot).
 * @returns the registrable domain, lowercased.
 */
export function registrableDomain(host: string): string {
  const clean = host.trim().replace(/^\./, '').toLowerCase()
  if (clean === '' || clean === 'localhost' || /^\d+(\.\d+){3}$/.test(clean)) return clean
  const parts = clean.split('.')
  if (parts.length <= 2) return clean
  const lastTwo = parts.slice(-2).join('.')
  if (MULTI_PART_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.')
  return lastTwo
}

/** Whether a cookie name belongs to the always-present analytics/consent family. */
export function isTracker(name: string): boolean {
  return TRACKER_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Aggregate cookies into per-domain login inferences. Trackers are dropped, never counted,
 * and never surfaced; only counts and boolean signals leave this function.
 * @param rows - cookies as read from the browser (or the last exported state file).
 * @param source - where those cookies came from, for the card's label.
 * @param now - epoch ms, injectable so tests are not time-dependent.
 * @param maxSites - display cap; defaults to {@link MAX_SITES}.
 * @returns the display payload.
 */
export function summarizeLoginSites(
  rows: readonly CookieRow[],
  source: 'live' | 'snapshot',
  now: number,
  maxSites: number = MAX_SITES,
): LoginSites {
  const perDomain = new Map<
    string,
    { cookies: number; httpOnly: number; longLived: number; sessionLike: number; names: number; secure: number }
  >()
  let counted = 0
  for (const row of rows) {
    if (typeof row?.name !== 'string' || typeof row?.domain !== 'string') continue
    if (isTracker(row.name)) continue
    const domain = registrableDomain(row.domain)
    if (domain === '') continue
    counted += 1
    const entry = perDomain.get(domain) ?? {
      cookies: 0,
      httpOnly: 0,
      longLived: 0,
      sessionLike: 0,
      names: 0,
      secure: 0,
    }
    entry.cookies += 1
    if (row.httpOnly === true) entry.httpOnly += 1
    if (row.secure === true) entry.secure += 1
    const expires = typeof row.expires === 'number' ? row.expires : -1
    if (expires === -1 || expires === 0) entry.sessionLike += 1
    else if (expires - now / 1000 > WEEK_SECONDS) entry.longLived += 1
    if (SESSION_NAME.test(row.name)) entry.names += 1
    perDomain.set(domain, entry)
  }

  const sites: LoginSite[] = []
  for (const [domain, entry] of perDomain) {
    // Score, then threshold. httpOnly is the strongest single hint: analytics cookies are
    // almost never httpOnly, while a server-side session cookie usually is. A session-like
    // *name* alone is weak (plenty of anonymous visitors get `uid`), so it needs a partner.
    const signals: string[] = []
    let score = 0
    if (entry.httpOnly >= 1) {
      score += 2
      signals.push('httpOnly')
    }
    if (entry.names >= 1) {
      score += 1
      signals.push('session-like name')
    }
    if (entry.sessionLike >= 1) {
      score += 1
      signals.push('session cookie')
    }
    if (entry.longLived >= 1) {
      score += 1
      signals.push('long-lived')
    }
    if (entry.cookies >= 3) {
      score += 1
      signals.push('several cookies')
    }
    if (entry.secure >= 1) signals.push('secure')
    sites.push({
      domain,
      cookies: entry.cookies,
      httpOnly: entry.httpOnly,
      longLived: entry.longLived,
      sessionLike: entry.sessionLike,
      likely: score >= 3,
      signals,
    })
  }

  sites.sort((a, b) => {
    if (a.likely !== b.likely) return a.likely ? -1 : 1
    if (a.cookies !== b.cookies) return b.cookies - a.cookies
    return a.domain.localeCompare(b.domain)
  })

  return { source, capturedAt: now, cookies: counted, total: sites.length, sites: sites.slice(0, maxSites) }
}
