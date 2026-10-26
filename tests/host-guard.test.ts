/**
 * 白名单要拦在**路上**，不能只在调用入口打勾。
 *
 * 2026-10-26 实测的绕过：名单设成 `127.0.0.1`，直接导航到 `localhost` 会被拒，但
 * - 页面自己 `location.href = 'http://localhost/…'` → 过去了；
 * - 白名单站点的 302 跳到名单外 → 过去了；
 * - 页面脚本 `fetch` 到名单外 → 数据出去了。
 * 这些导航都不是插件发起的，入口检查永远追不上，所以白名单现在装在 context 的请求层上
 * （navigation-guard.ts）。本文件把这三条钉死。
 *
 * 用的是同一台本地服务器：`127.0.0.1` 在白名单里，`localhost` 是另一个主机名，不在。
 * @module dsh-browser-playwright-codex/tests/host-guard
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { PlaywrightProvider } from '../src/provider.ts'
import type { PlaywrightConfig } from '../src/config.ts'
import { publishGates } from '../src/runtime-state.ts'

process.env.DSH_BROWSER_STATE_FILE = path.join(os.tmpdir(), 'dsh-browser-tests-state-host-guard.json')
// Each case reads page state through session.evaluate.
publishGates({ allowEvaluate: true, allowCdp: true, diagnostics: true })

let server: Server
let port = 0
/** Requests the server actually received, by path — the honest signal for "did it leave". */
const hits = new Map<string, number>()
const hit = (key: string) => (hits.get(key) ?? 0) + 1

const page = (body: string) => '<html><head><title>guard</title></head><body>' + body + '</body></html>'

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/'
    hits.set(url, hit(url))
    if (url === '/redirect') {
      // A 302 the plugin never sees: the browser follows it on its own.
      res.writeHead(302, { location: 'http://localhost:' + String(port) + '/plain' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    if (url === '/jump') {
      // In-page navigation: no entry point of ours is involved.
      res.end(page('<h1>jumping</h1><script>location.href = "http://localhost:' + String(port) + '/plain"</script>'))
      return
    }
    if (url === '/xhr') {
      // A data request to a host outside the allow-list.
      res.end(
        page(
          '<h1>xhr</h1><script>fetch("http://localhost:' +
            String(port) +
            '/data").then(() => { window.__done = "ok" }).catch(() => { window.__done = "blocked" })</script>',
        ),
      )
      return
    }
    res.end(page('<h1>plain</h1>'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  port = address.port
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function providerFor(allowedDomains: string[] | undefined) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-browser-guard-'))
  const config: PlaywrightConfig = {
    launch: {
      channel: 'chrome',
      headless: true,
      persistent: false,
      profileDir,
      viewport: { width: 1280, height: 800 },
      navigationTimeoutMs: 15_000,
      ignoreHTTPSErrors: false,
    },
    ...(allowedDomains === undefined ? {} : { allowedDomains }),
    idleTimeoutMs: 0,
    maxSessions: 4,
    snapshot: { engine: 'legacy', diff: false, maxNodes: 500, maxNameLength: 120, maxTextLength: 300 },
  }
  return new PlaywrightProvider(config)
}

test('no allow-list: the guard stays out of the way and localhost works (the default must not change)', async () => {
  const provider = providerFor(undefined)
  try {
    const session = await provider.acquire('guard-default')
    const snap = await session.navigate('http://localhost:' + String(port) + '/plain', 'load')
    assert.equal(snap.title, 'guard')
  } finally {
    await provider.dispose()
  }
})

test('302 to a host outside the allow-list is refused, and named as such', async () => {
  const provider = providerFor(['127.0.0.1'])
  try {
    const session = await provider.acquire('guard-302')
    await assert.rejects(
      session.navigate('http://127.0.0.1:' + String(port) + '/redirect', 'load'),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'URL_NOT_ALLOWED', 'the refusal must carry URL_NOT_ALLOWED, got: ' + error.message)
        assert.match(error.message, /localhost/)
        return true
      },
    )
  } finally {
    await provider.dispose()
  }
})

test('a page that navigates itself off the allow-list never gets there', async () => {
  const provider = providerFor(['127.0.0.1'])
  try {
    const session = await provider.acquire('guard-jump')
    // The refusal may surface as the action's error or as the page staying put;
    // what must never happen is the tab ending up on localhost.
    await session.navigate('http://127.0.0.1:' + String(port) + '/jump', 'load').catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const url = await session.run(async () => session.context.pages()[0]?.url() ?? '')
    assert.ok(!String(url).includes('localhost'), 'the tab must not land on the disallowed host: ' + String(url))
  } finally {
    await provider.dispose()
  }
})

test('a data request to a host outside the allow-list never reaches it', async () => {
  const provider = providerFor(['127.0.0.1'])
  const before = hits.get('/data') ?? 0
  try {
    const session = await provider.acquire('guard-xhr')
    await session.navigate('http://127.0.0.1:' + String(port) + '/xhr', 'load')
    await new Promise((resolve) => setTimeout(resolve, 800))
    assert.equal(hits.get('/data') ?? 0, before, 'the fetch to localhost must be stopped before it reaches the server')
  } finally {
    await provider.dispose()
  }
})
