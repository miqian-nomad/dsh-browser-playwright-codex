/**
 * 「已登录站点」推断的测试。
 *
 * 最要紧的一条是隐私断言：整份产出序列化之后，**不许出现任何 cookie 名字或值**。
 * 其余覆盖分组（含 com.cn / co.uk 这类多段后缀）、tracker 剔除、打分阈值、展示上限，
 * 以及 runtime-state 的读写是防御性拷贝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registrableDomain, isTracker, summarizeLoginSites, type CookieRow } from '../src/login-sites.ts'
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
  const payload = summarizeLoginSites(rows, 'live', NOW, 5)
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
    sites: [
      { domain: 'x.com', cookies: 2, httpOnly: 2, longLived: 0, sessionLike: 0, likely: true, signals: ['httpOnly'] },
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
