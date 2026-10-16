/**
 * 「已登录站点」推断的测试。
 *
 * 最要紧的一条是隐私断言：整份产出序列化之后，**不许出现任何 cookie 名字或值**。
 * 其余覆盖分组（含 com.cn / co.uk 这类多段后缀）、tracker 剔除、打分阈值、展示上限，
 * 以及 runtime-state 的读写是防御性拷贝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { siteAlias, siteGroup } from '../src/site-aliases.ts'
import {
  registrableDomain,
  isTracker,
  isTrackerHost,
  looksLikeToken,
  summarizeLoginSites,
  type CookieRow,
} from '../src/login-sites.ts'
import { getLoginSites, publishLoginSites } from '../src/runtime-state.ts'

const NOW = 1_700_000_000_000
const WEEK = 8 * 24 * 60 * 60

const cookie = (name: string, domain: string, extra: Partial<CookieRow> = {}): CookieRow => ({
  name,
  domain,
  ...extra,
})

test('可注册域：www/前导点/多段后缀都归到同一个域', () => {
  assert.equal(registrableDomain('.x.com'), 'x.com')
  assert.equal(registrableDomain('www.x.com'), 'x.com')
  assert.equal(registrableDomain('a.b.x.com'), 'x.com')
  assert.equal(registrableDomain('a.x.co.uk'), 'x.co.uk')
  assert.equal(registrableDomain('shop.x.com.cn'), 'x.com.cn')
  assert.equal(registrableDomain('localhost'), 'localhost')
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1')
  assert.equal(registrableDomain('  .EXAMPLE.com '), 'example.com')
})

test('tracker 判定：分析与同意类 cookie 一律剔除', () => {
  for (const name of ['_ga', '_ga_ABC123', '_gid', '__cf_bm', 'Hm_lvt_abc', 'BAIDUID', '_fbp', 'OptanonConsent']) {
    assert.equal(isTracker(name), true, name + ' 应该被当作 tracker')
  }
  for (const name of ['sid', 'sessionid', 'auth_token', 'JSESSIONID', 'csrftoken']) {
    assert.equal(isTracker(name), false, name + ' 不该被当作 tracker')
  }
})

test('只访问过、从没登录的站不该看起来像登录', () => {
  const payload = summarizeLoginSites(
    [cookie('_ga', '.shop.com'), cookie('_gid', '.shop.com'), cookie('__cf_bm', '.shop.com')],
    'live',
    NOW,
  )
  assert.equal(payload.cookies, 0, '三个全是 tracker，计数必须是 0')
  assert.deepEqual(payload.sites, [], '没有非 tracker cookie 就不该出现这个站')
})

test('httpOnly 会话 cookie 判为"推测登录"，弱信号不判', () => {
  const payload = summarizeLoginSites(
    [
      cookie('sid', 'github.com', { httpOnly: true, secure: true }),
      cookie('logged_in', 'github.com', { httpOnly: true, expires: Math.floor(NOW / 1000) + WEEK }),
      cookie('uid', 'weak.example'), // 只有一个弱名字，不足以推断
    ],
    'snapshot',
    NOW,
  )
  const byDomain = new Map(payload.sites.map((site) => [site.domain, site]))
  const github = byDomain.get('github.com')
  assert.ok(github !== undefined)
  assert.equal(github.likely, true)
  assert.equal(github.cookies, 2)
  assert.equal(github.httpOnly, 2)
  assert.ok(github.signals.includes('httpOnly'))
  assert.equal(byDomain.get('weak.example')?.likely, false)
  assert.equal(payload.source, 'snapshot')
  assert.equal(payload.capturedAt, NOW)
})

test('排序：推测登录的在前，其次按 cookie 数', () => {
  const payload = summarizeLoginSites(
    [
      cookie('a', 'small.example', { httpOnly: true }),
      cookie('b', 'small.example', { httpOnly: true }),
      cookie('c', 'big.example'),
      cookie('d', 'big.example'),
      cookie('e', 'big.example'),
      cookie('f', 'big.example'),
    ],
    'live',
    NOW,
  )
  assert.deepEqual(
    payload.sites.map((site) => site.domain),
    ['small.example', 'big.example'],
    '有 httpOnly 的站排在前面',
  )
})

test('展示上限：超出只截断列表，总数仍然诚实', () => {
  const rows: CookieRow[] = []
  for (let i = 0; i < 12; i += 1) rows.push(cookie('sid', 'site' + String(i) + '.example', { httpOnly: true }))
  const payload = summarizeLoginSites(rows, 'live', NOW, { maxSites: 5 })
  assert.equal(payload.sites.length, 5, '列表被截断到 5')
  assert.equal(payload.total, 12, 'total 必须报告真实数量')
})

test('隐私红线：产出里不许出现任何 cookie 名字或值', () => {
  const rows = [
    cookie('sid', '.github.com', { httpOnly: true }),
    cookie('auth_token', '.github.com', { httpOnly: true, secure: true }),
    cookie('csrftoken', '.github.com'),
    cookie('_ga', '.github.com'),
    { name: 'sekrit', domain: '.secret.example', httpOnly: true } as CookieRow,
  ]
  const serialized = JSON.stringify(summarizeLoginSites(rows, 'live', NOW))
  for (const forbidden of ['sid', 'auth_token', 'csrftoken', 'sekrit', '_ga', 'value']) {
    assert.ok(!serialized.includes(forbidden), '产出里不该出现 ' + forbidden + '：' + serialized.slice(0, 200))
  }
  assert.ok(serialized.includes('secret.example'), '但域名本身要出现（这是展示的主体）')
})

test('runtime-state 的读写是防御性拷贝', () => {
  publishLoginSites({
    source: 'live',
    capturedAt: NOW,
    cookies: 2,
    total: 1,
    likelyTotal: 1,
    thirdPartyTotal: 0,
    attribution: 'live' === 'live' ? 'first-party' : 'unfiltered',
    sites: [
      {
        domain: 'x.com',
        cookies: 2,
        httpOnly: 2,
        longLived: 0,
        sessionLike: 0,
        tokenLike: 0,
        likely: true,
        signals: ['httpOnly'],
      },
    ],
  })
  const first = getLoginSites()
  assert.ok(first !== undefined)
  first.sites[0].domain = 'tampered.example'
  first.sites[0].signals.push('tampered')
  const second = getLoginSites()
  assert.equal(second?.sites[0].domain, 'x.com', '调用方改返回值不能污染已发布的状态')
  assert.deepEqual(second?.sites[0].signals, ['httpOnly'])
})
test('整个域就是统计服务时不出现（真实 payload 抓到的误报：mmstat.com）', () => {
  // 2026-10-16：这个功能第一次吐出真实名单时，mmstat.com（阿里的统计域）带着 30 个 cookie 排在
  // 第 5 位，标着"推测登录" —— 但那只是逛过淘宝的痕迹。名字级名单拦不住"整个域就是统计端点"。
  assert.equal(isTrackerHost('mmstat.com'), true)
  assert.equal(isTrackerHost('hm.baidu.com'), true)
  assert.equal(isTrackerHost('www.google-analytics.com'), true)
  assert.equal(isTrackerHost('github.com'), false)
  assert.equal(isTrackerHost('taobao.com'), false)
  const payload = summarizeLoginSites(
    [cookie('cna', 'mmstat.com'), cookie('sid', 'github.com', { httpOnly: true })],
    'live',
    NOW,
  )
  assert.deepEqual(
    payload.sites.map((s) => s.domain),
    ['github.com'],
  )
  assert.equal(payload.cookies, 1)
})

// ── 2026-10-16 重写后新增：成熟产品的两条做法 ──────────────────────────────────

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'

test('令牌判据：像会话 ID 的值通过，分析用的结构化值不通过', () => {
  assert.equal(looksLikeToken(TOKEN), true, 'JWT 形状')
  assert.equal(looksLikeToken('a1b2c3d4e5f60718293a4b5c6d7e8f90'), true, '32 位十六进制')
  assert.equal(looksLikeToken('9f8e7d6c5b4a39281706f5e4d3c2b1a0'), true, '32 位十六进制（数字开头）')
  assert.equal(looksLikeToken('short'), false, '太短')
  assert.equal(looksLikeToken('1'), false)
  assert.equal(looksLikeToken('2026-10-16T12:00:00Z'), false, '时间戳这类结构化值')
  assert.equal(looksLikeToken('{%22a%22:1,%22b%22:2}'), false, 'JSON 形状')
  assert.equal(looksLikeToken('aaaaaaaaaaaaaaaaaaaaaaaaaaaa'), false, '字符种类太少')
})

test('第一方归属：浏览器没访问过的域只计数、不进列表（Firefox 的 cookie jar 模型）', () => {
  const payload = summarizeLoginSites(
    [
      cookie('sid', 'github.com', { httpOnly: true }),
      cookie('cna', 'pubmatic.com'),
      cookie('t', 'mmstat.com'),
      cookie('x', 'some-ad-exchange.example'),
    ],
    'live',
    NOW,
    { visited: ['github.com'] },
  )
  assert.deepEqual(
    payload.sites.map((s) => s.domain),
    ['github.com'],
    '只列访问过的域',
  )
  assert.equal(payload.thirdPartyTotal, 1, '没访问过、也不在域级名单里的域只报个数')
  assert.equal(payload.attribution, 'first-party', '拿到访问集合时必须标明做了第一方归属')
  assert.equal(
    summarizeLoginSites([cookie('sid', 'x.example', { httpOnly: true })], 'live', NOW).attribution,
    'unfiltered',
    '拿不到访问集合时必须如实标成未过滤，而不是假装过滤过了',
  )
  assert.equal(payload.total, 1)
})

test('OWASP 判据：httpOnly + 会话级/令牌才算"推测登录"，名字与条数不再能凑分', () => {
  const rows = [
    // 真会话：httpOnly + 无过期
    cookie('whatever', 'a.example', { httpOnly: true }),
    // httpOnly + 值是令牌形状
    cookie('x', 'b.example', { httpOnly: true, tokenLike: true }),
    // 只有 httpOnly，既非会话级也不像令牌 → 不算
    cookie('y', 'c.example', { httpOnly: true, expires: Math.floor(NOW / 1000) + 86400 }),
    // 名字像会话 + cookie 很多，但没有 httpOnly → 不算（这正是上一版把广告域排到前面的原因）
    cookie('sid', 'd.example', { expires: Math.floor(NOW / 1000) + WEEK }),
    cookie('sessionid', 'd.example', { expires: Math.floor(NOW / 1000) + WEEK }),
    cookie('auth', 'd.example'),
    cookie('login', 'd.example'),
    cookie('ticket', 'd.example'),
  ]
  const byDomain = new Map(summarizeLoginSites(rows, 'live', NOW).sites.map((s) => [s.domain, s]))
  assert.equal(byDomain.get('a.example')?.likely, true, 'httpOnly + 会话级')
  assert.equal(byDomain.get('b.example')?.likely, true, 'httpOnly + 值像令牌')
  assert.equal(byDomain.get('c.example')?.likely, false, '只有 httpOnly 不算')
  assert.equal(byDomain.get('d.example')?.likely, false, '名字像会话 + 条数多，但没有 httpOnly → 不算')
  assert.equal(byDomain.get('d.example')?.cookies, 5, '但条数照实统计')
})

test('载荷的统计要诚实：likelyTotal / total / thirdPartyTotal 都在', () => {
  const payload = summarizeLoginSites(
    [
      cookie('a', 'one.example', { httpOnly: true }),
      cookie('b', 'two.example', { httpOnly: true, expires: Math.floor(NOW / 1000) + 86400 }),
      cookie('c', 'three.example', { httpOnly: true, tokenLike: true }),
      cookie('d', 'never-visited.example'),
    ],
    'live',
    NOW,
    { visited: ['one.example', 'two.example', 'three.example'] },
  )
  assert.equal(payload.total, 3)
  assert.equal(payload.likelyTotal, 2, 'one 与 three 像登录态，two 只有 httpOnly')
  assert.equal(payload.thirdPartyTotal, 1)
})

test('网页自己的标题会随行带出，且只在知道时才有', () => {
  // 认不出域名是这个功能真实的痛点（用户原话："我都不知道我登的这些是什么"）。浏览器与密码管理器
  // 的做法是显示网页自己的标题 —— 那是网站自己报的名字，不会过期。导出文件里没有标题，所以快照路径
  // 天然为空，卡片就只显示域名。
  const rows = [cookie('sid', 'example.com', { httpOnly: true }), cookie('sid', 'notitle.example', { httpOnly: true })]
  const withTitles = summarizeLoginSites(rows, 'live', NOW, {
    titles: new Map([['example.com', '  示例站点   首页  ']]),
  })
  const byDomain = new Map(withTitles.sites.map((s) => [s.domain, s]))
  assert.equal(byDomain.get('example.com')?.title, '示例站点 首页', '标题应被规整（去多余空白）')
  assert.equal(byDomain.get('notitle.example')?.title, undefined, '没有标题时不该编一个')
  const withoutTitles = summarizeLoginSites(rows, 'snapshot', NOW)
  assert.equal(withoutTitles.sites[0]?.title, undefined, '快照路径没有标题')
  // 标题只用于展示：不得因此把 cookie 名或值带出去
  const serialized = JSON.stringify(withTitles)
  for (const forbidden of ['"value"', '"name"', 'sid']) {
    assert.ok(!serialized.includes(forbidden), '产出里不该出现 ' + forbidden)
  }
})

test('域名说明：认识的说清楚、不认识的不瞎猜', () => {
  // 用户原话："我都不知道我登的这些是什么"。对照表只解释确实认识的；认不出就返回 undefined，
  // 界面退回显示域名本身，绝不给一个编出来的名字。
  assert.equal(siteAlias('jinritemai.com'), '巨量千川（抖音电商广告后台）')
  assert.equal(siteAlias('.JD.COM'), '京东', '大小写与前导点都要能对上')
  assert.ok(siteAlias('a-mo.net')?.includes('广告'), '广告域要标出来')
  assert.equal(siteAlias('some-unknown-host.example'), undefined, '不认识就留空')
  assert.equal(siteAlias(''), undefined)
})

test('载荷里的每行都带上说明（有就带，没有就不带）', () => {
  const payload = summarizeLoginSites(
    [cookie('sid', 'jinritemai.com', { httpOnly: true }), cookie('sid', 'unknown-xyz.example', { httpOnly: true })],
    'live',
    NOW,
  )
  const byDomain = new Map(payload.sites.map((s) => [s.domain, s]))
  assert.equal(byDomain.get('jinritemai.com')?.alias, '巨量千川（抖音电商广告后台）')
  assert.equal(byDomain.get('unknown-xyz.example')?.alias, undefined)
})

test('归属分组：同一家公司的域归到一组（用户要的"一个类型的放一起"）', () => {
  // 真实名单里京东系占了二十来个域，各自一行会淹掉别的站。
  assert.deepEqual(siteGroup('jd.com'), { key: 'jd', label: '京东系' })
  assert.deepEqual(siteGroup('jddj.com'), { key: 'jd', label: '京东系' })
  assert.deepEqual(siteGroup('taobao.com'), { key: 'alibaba', label: '阿里系' })
  assert.deepEqual(siteGroup('douyin.com'), { key: 'bytedance', label: '字节系' })
  assert.deepEqual(siteGroup('adroll.com'), { key: 'ads', label: '广告 / 统计平台' })
  assert.equal(siteGroup('github.com'), undefined, '独苗不成组')
  assert.equal(siteGroup('unknown-xyz.example'), undefined)
  const payload = summarizeLoginSites([cookie('sid', 'jddj.com', { httpOnly: true })], 'live', NOW)
  assert.deepEqual(payload.sites[0]?.group, { key: 'jd', label: '京东系' }, '载荷里要带上归属')
})
