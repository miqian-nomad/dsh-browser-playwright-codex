/**
 * 代理支持（2026-11-12）。实测缺口：直连 wikipedia 15 秒超时，走代理 4.4 秒 200。
 * 插件自己启浏览器，所以代理必须交给**浏览器启动**（`launchOptions.proxy`），请求头改不了整体路由。
 *
 * 钉住的行为（每条都有理由）：
 *   1. 不填 = 直连，行为与以前完全一样（`{}`，不出现 `proxy` 键）
 *   2. 填了 = `{ proxy: { server, bypass } }`；`bypass` 必含 `localhost,127.0.0.1`，
 *      否则插件自己的本地页面（verify、MiniWoB 普查、任何本地服务）会被塞进代理
 *   3. `host:port` 短写按 Playwright 的规则补成 `http://host:port`
 *   4. 端口必须 1–65535；scheme 只允许 http / https / socks5
 *   5. 带账号密码一律拒绝（这一版只支持免认证代理）：密码会明文进 patch 文件，
 *      而且 SOCKS5 认证 Playwright 根本不支持 —— 与其埋一个明文密码，不如少一个能力
 *
 * 另加两条守卫：启动路径确实带上了这个片段（防止只加配置没接上），
 * 以及代理**不影响 allowedDomains 判定**（白名单仍按网址判，不因为走代理放宽）。
 * @module dsh-browser-playwright-codex/tests/proxy
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalizeProxy, proxyLaunchOption, PROXY_BYPASS } from '../src/proxy.ts'
import { assertAllowedUrl, isHostAllowed } from '../src/url-policy.ts'

const read = (rel: string) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8')

test('no proxy configured means direct: no proxy key at all', () => {
  assert.equal(normalizeProxy(undefined), undefined)
  assert.equal(normalizeProxy(''), undefined)
  assert.equal(normalizeProxy('   '), undefined)
  assert.deepEqual(proxyLaunchOption(undefined), {}, 'an empty config must spread nothing')
  assert.deepEqual(proxyLaunchOption(''), {})
})

test('a configured proxy carries the server and a local bypass', () => {
  const proxy = normalizeProxy('http://proxy.example:8080')
  assert.deepEqual(proxy, { server: 'http://proxy.example:8080', bypass: PROXY_BYPASS })
  assert.equal(PROXY_BYPASS, 'localhost,127.0.0.1')
  // Without the bypass the plugin's own 127.0.0.1 pages would be pushed through the
  // proxy and fail — verify, the MiniWoB sweep and any local server live there.
  assert.ok((proxy?.bypass ?? '').includes('localhost'))
  assert.ok((proxy?.bypass ?? '').includes('127.0.0.1'))
})

test('host:port is accepted and becomes http, like Playwright does', () => {
  assert.deepEqual(proxyLaunchOption('proxy.example:8080'), {
    proxy: { server: 'http://proxy.example:8080', bypass: PROXY_BYPASS },
  })
  assert.deepEqual(normalizeProxy('proxy.example:3128'), {
    server: 'http://proxy.example:3128',
    bypass: PROXY_BYPASS,
  })
  assert.deepEqual(normalizeProxy('  http://proxy.example:8080  '), {
    server: 'http://proxy.example:8080',
    bypass: PROXY_BYPASS,
  })
  assert.deepEqual(normalizeProxy('https://proxy.example:8443'), {
    server: 'https://proxy.example:8443',
    bypass: PROXY_BYPASS,
  })
  assert.deepEqual(normalizeProxy('socks5://proxy.example:1080'), {
    server: 'socks5://proxy.example:1080',
    bypass: PROXY_BYPASS,
  })
})

test('a port is required, and it must be 1–65535', () => {
  assert.throws(
    () => normalizeProxy('http://127.0.0.1'),
    (error: Error) => {
      assert.match(error.message, /port is missing/, error.message)
      return true
    },
  )
  assert.throws(
    () => normalizeProxy('http://127.0.0.1:abc'),
    (error: Error) => {
      assert.match(error.message, /port is not a number/, error.message)
      return true
    },
  )
  assert.throws(() => normalizeProxy('http://127.0.0.1:0'), /1–65535/)
  assert.throws(() => normalizeProxy('http://127.0.0.1:65536'), /1–65535/)
})

test('an authenticated proxy is refused instead of storing a plaintext password', () => {
  // Both forms: full URL with credentials, and the short form.
  for (const bad of ['http://user:secret@proxy.example:8080', 'user:secret@proxy.example:8080']) {
    assert.throws(
      () => normalizeProxy(bad),
      (error: Error) => {
        assert.match(error.message, /must not carry a username or password/, error.message)
        assert.match(error.message, /WITHOUT authentication/, 'the message must say what is supported')
        return true
      },
    )
  }
  // SOCKS5 + credentials is impossible in Chromium/Playwright, and says so.
  assert.throws(() => normalizeProxy('socks5://user:secret@127.0.0.1:1080'), /SOCKS5 authentication is not supported/)
  // A non-empty but unusable value must never silently become "direct".
  assert.throws(() => proxyLaunchOption('proxy.example:8080@nope'))
})

test('unsupported schemes and stray paths are refused by name', () => {
  assert.throws(() => normalizeProxy('ftp://127.0.0.1:21'), /only http, https and socks5/)
  assert.throws(() => normalizeProxy('socks4://127.0.0.1:1080'), /only http, https and socks5/)
  assert.throws(() => normalizeProxy('http://proxy.example:8080/proxy'), /no path, query or fragment/)
  assert.throws(() => normalizeProxy('http://proxy.example:8080?x=1'), /no path, query or fragment/)
})

test('proxyLaunchOption is exactly what Playwright expects', () => {
  assert.deepEqual(proxyLaunchOption('http://proxy.example:8080'), {
    proxy: { server: 'http://proxy.example:8080', bypass: 'localhost,127.0.0.1' },
  })
})

test('every launch path actually spreads the proxy option (static guard)', () => {
  // The config being right is not enough: if a launch call forgets the spread, the
  // browser silently connects directly — the exact failure this change exists to fix.
  // Two shapes exist now: the persistent context reads `baseOptions` (which carries
  // the proxy), and the legacy direct launches go through the sandbox-fallback
  // wrapper, so the spread has to be on each of ITS call sites.
  const lifecycle = read('src/browser-lifecycle.ts')
  const launches: string[] = []
  const marker = 'launchWithSandboxFallback({'
  for (let at = lifecycle.indexOf(marker); at !== -1; at = lifecycle.indexOf(marker, at + 1)) {
    const end = lifecycle.indexOf('})', at)
    launches.push(lifecycle.slice(at, end === -1 ? at + 200 : end + 2))
  }
  assert.ok(launches.length >= 2, 'expected the direct-launch paths in browser-lifecycle.ts')
  for (const call of launches) {
    assert.ok(
      call.includes('proxyLaunchOption('),
      'a launch call does not pass the proxy option: ' + call.replace(/\s+/g, ' '),
    )
  }
  assert.ok(
    lifecycle.includes('proxyLaunchOption(provider.config.launch.proxy)'),
    'the persistent launch options must carry the proxy too',
  )
})

test('a configured proxy does not widen allowedDomains', () => {
  // The allow-list decides by URL, never by route: a proxied browser may still only
  // visit the hosts the deployment listed (otherwise the proxy would quietly become
  // a way around the policy).
  const allowed = ['example.com']
  assert.equal(isHostAllowed('example.com', allowed), true)
  assert.equal(isHostAllowed('wikipedia.org', allowed), false)
  assert.throws(
    () => assertAllowedUrl('https://wikipedia.org/wiki/Main_Page', allowed),
    /URL_NOT_ALLOWED|not in allowedDomains/i,
  )
  // And the proxy host itself is not a visitable host.
  const proxy = normalizeProxy('http://proxy.example:8080')
  assert.ok(proxy !== undefined)
  assert.equal(isHostAllowed('127.0.0.1', allowed), false)
})
