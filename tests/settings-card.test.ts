/**
 * 设置卡（settings-card.ts）的端到端测试 —— 走**真实 HTTP 路由**，不是函数级模拟。
 *
 * 为什么必须补这一块：它是全仓最大的零测试模块（518 行），而且出过真事故 ——
 * GitHub issue #4：设置页保存一次，写出的 YAML 里 `diagnostics` 键重复，严格 YAML 是非法的，
 * DSH 下次启动直接 fatal。那次是"用户关掉浏览器就再也打不开"级别的故障，却没有任何测试拦它。
 *
 * 这里钉四件事：
 *   1. 保存后写出的文件**能被重新解析、且没有重复键**（把 #4 的场景做成常驻测试）；
 *   2. 切换能力开关**不能把用户已有配置抹掉**（`profileDir` 被整块重写丢掉、全站登出那次）；
 *   3. 路由的 `x-dsh-plugin` 防伪头（四个路由逐个验，缺头必须 403，且不泄露内容）；
 *   4. 同一份补丁层里已有未标记的 `- id: browser` 行时，**不许写出第二行**（2026-11-12 实测发现：
 *      旧实现会追加一次模板，于是同一个 id 被挂两次 —— 与 #4 同一类"保存写出坏文件"）。
 *
 * 为什么用自己起的小 HTTP 服务器：DSH 的 `webServer` 服务不在本仓库的 node_modules 里
 * （`@deepseek-ai/dsh-web-server` 没有随包发布），所以无法挂载真正的宿主服务。但路由的
 * handler 就是 DSH 会调用的同一个函数，这里用一个只做路径分发的 `node:http` 服务器把它们
 * 接到真实 socket 上 —— 请求行、方法、请求头、请求体、状态码、响应头都走真实的 HTTP 栈，
 * 不是伪造的 req/res 对象。
 * @module dsh-browser-playwright-codex/tests/settings-card
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

// 所有落盘状态都进临时目录：真实用户的 ~/.dsh 不能被读到，更不能被改写。
const home = mkdtempSync(join(tmpdir(), 'dsh-settings-card-'))
process.env.DSH_HOME = home
process.env.DSH_BROWSER_STATE_FILE = join(home, 'state.json')
process.env.DSH_BROWSER_SWARM_FILE = join(home, 'played.json')

const card = await import('../src/settings-card.ts')
const runtimeState = await import('../src/runtime-state.ts')
const gatesPatch = await import('../src/gates-patch.ts')

const patchFile = join(home, 'cordis.patch.yml')
const HEADER = { 'x-dsh-plugin': 'browser-toggle' }

// ---------------------------------------------------------------------------
// 一个够用的 YAML 子集审计器
// ---------------------------------------------------------------------------
// 为什么自己写：仓库里没有 YAML 解析库（`yaml` / `js-yaml` 都不可解析），而"装一个新依赖"要动
// 用户的 node_modules（这台的 @deepseek-ai/* 全是活运行时的软链接，不能 npm install）。
// 所以这里只验证**插件自己会写出来的那个子集**：缩进块映射 + 序列 + 注释。这不是通用 YAML 解析器，
// 但它正好覆盖 issue #4 —— 同一层里出现两个同名 key。
//
// 判据刻意保守：同一缩进、同一个 key 再出现一次 = 重复键。真实 YAML 里这正是非法的。

interface YamlAudit {
  readonly issues: readonly string[]
  /** `- id: <value>` 的行数，用来断言"一个包只有一行 loader"。 */
  readonly rowIds: readonly string[]
}

function auditYaml(text: string): YamlAudit {
  const issues: string[] = []
  const rowIds: string[] = []
  const seen = new Map<string, number>()
  const lines = text.split(/\r?\n/)
  let prev: { indent: number; opens: boolean } | null = null
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? ''
    const trimmedRaw = raw.trim()
    if (trimmedRaw === '' || trimmedRaw.startsWith('#')) continue
    const where = 'line ' + String(i + 1)
    if (raw.includes('\t')) issues.push(where + ': tab character in indentation')
    const indent = raw.length - raw.trimStart().length
    if (prev !== null && indent > prev.indent && !prev.opens) {
      issues.push(where + ': indented under a line that does not open a block')
    }
    const body = trimmedRaw
    if (body === '-' || body.startsWith('- ')) {
      const rest = body.slice(2).trim()
      const item = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(rest)
      if (item === null) {
        prev = { indent, opens: false }
        continue
      }
      const key = item[1] as string
      if (key === 'id' && rest.startsWith('id: browser')) rowIds.push(String(item[2] ?? ''))
      const entry = String(indent + 2) + '::' + key
      const first = seen.get(entry)
      if (first !== undefined)
        issues.push(where + ': duplicate key "' + key + '" (first at line ' + String(first) + ')')
      else seen.set(entry, i + 1)
      prev = { indent: indent + 2, opens: item[2] === undefined }
      continue
    }
    const entryMatch = /^([^\s:#][^:]*):(?:\s+(.*))?$/.exec(body)
    if (entryMatch === null) {
      issues.push(where + ': not a mapping or sequence line: ' + body)
      continue
    }
    const key = (entryMatch[1] as string).trim()
    const value = entryMatch[2]
    const entry = String(indent) + '::' + key
    const first = seen.get(entry)
    if (first !== undefined) issues.push(where + ': duplicate key "' + key + '" (first at line ' + String(first) + ')')
    else seen.set(entry, i + 1)
    prev = { indent, opens: value === undefined || value === '' }
  }
  return { issues, rowIds }
}

function writePatch(text: string): void {
  writeFileSync(patchFile, text, 'utf8')
}

function readPatch(): string {
  return readFileSync(patchFile, 'utf8')
}

// ---------------------------------------------------------------------------
// 真实 HTTP：把设置卡注册的路由接到一个本地 socket 上
// ---------------------------------------------------------------------------

type Handler = (req: unknown, res: unknown) => unknown | Promise<unknown>

function makeContext() {
  const routes = new Map<string, Handler>()
  const disposers: (() => void)[] = []
  const ctx = {
    webServer: {
      register(route: { path: string; handler: Handler }) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    effect(fn: () => unknown) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer as () => void)
      return () => undefined
    },
  }
  return {
    ctx,
    routes,
    dispose() {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

let server: Server
let base = ''
let app: ReturnType<typeof makeContext>
let originalPatch: string

before(async () => {
  app = makeContext()
  // settings-card 的 apply 只用到 ctx.webServer.register 与 ctx.effect（两者都在上面实现了）。
  await (card.apply as unknown as (ctx: unknown) => void)(app.ctx)

  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const handler = app.routes.get(path)
    if (handler === undefined) {
      res.statusCode = 404
      res.end('no route')
      return
    }
    void handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port)
  originalPatch = ''
})

after(async () => {
  app.dispose()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

interface Reply {
  readonly status: number
  readonly body: Record<string, unknown>
}

async function request(
  method: string,
  path: string,
  options: { header?: boolean; body?: unknown; rawBody?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {}
  if (options.header !== false) Object.assign(headers, HEADER)
  const payload =
    options.rawBody !== undefined
      ? options.rawBody
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined
  if (payload !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, {
    method,
    headers,
    ...(payload !== undefined ? { body: payload } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) }
}

const managedBlock = (): string => gatesPatch.renderBrowserBlock(false, false, false)

/** 用户自己写过的配置：模板里没有这些键，切换开关时一个都不许丢。 */
const USER_KEYS = [
  '    playwright:',
  "      profileDir: 'D:/dsh-profile'",
  '      launch:',
  '        channel: chrome',
  '      maxSessions: 3',
  '    tool:',
  '      toolPrefix: "my_"',
  '      maxWaitMs: 90000',
  '      allowEvaluate: false',
  '      allowCdp: false',
].join('\n')

const userPatch = (): string =>
  [
    '# 用户自己的补丁层',
    'rules: []',
    '',
    gatesPatch.BEGIN,
    '- id: browser',
    "  name: 'dsh-browser-playwright-codex'",
    '  config:',
    USER_KEYS,
    '    diagnostics: false',
    gatesPatch.END,
    '',
  ].join('\n')

// ---------------------------------------------------------------------------
// 1. issue #4：保存后的文件必须能重新解析，且没有重复键
// ---------------------------------------------------------------------------

test('the YAML auditor has teeth: it really reports a duplicate key', () => {
  // 先证明审计器本身有效，否则下面那些"没有重复键"可能是它根本不会报。
  const bad = ['tool:', '  allowEvaluate: false', '  diagnostics: false', '  diagnostics: true'].join('\n')
  const audit = auditYaml(bad)
  assert.ok(
    audit.issues.some((issue) => /duplicate key "diagnostics"/.test(issue)),
    'the auditor must catch the exact issue #4 shape: ' + audit.issues.join('; '),
  )
})

test('saving the gates writes YAML that re-parses with no duplicate key (#4)', async () => {
  // 起点：一个 0.7.x 形状的块 —— 有 allowEvaluate/allowCdp，没有 diagnostics。
  writePatch(userPatch())
  const reply = await request('POST', '/api/browser-playwright/gates', {
    body: { allowEvaluate: true, allowCdp: true, diagnostics: true },
  })
  assert.equal(reply.status, 200, 'the save must succeed: ' + JSON.stringify(reply.body))
  assert.equal(reply.body.changed, true)
  assert.equal(reply.body.patch, patchFile)

  const written = readPatch()
  const audit = auditYaml(written)
  assert.deepEqual(audit.issues, [], 'the written YAML must be re-parsable with no duplicate keys')
  // 一个包只能有一行 loader：重复行也是"保存写出坏文件"。
  assert.deepEqual(audit.rowIds, ['browser'], 'exactly one `- id: browser` row, no duplicate loader')
  // diagnostics 只出现一次，且带着刚写进去的值。
  const diagLines = written.split('\n').filter((line) => /^\s*diagnostics:/.test(line))
  assert.equal(diagLines.length, 1, 'diagnostics must appear exactly once: ' + diagLines.join(' | '))
  assert.match(diagLines[0] as string, /true/)

  // 写进去的值能被插件自己的解析器读回来（不是只靠字符串匹配）。
  const parsed = gatesPatch.parseBrowserBlock(written)
  assert.deepEqual(parsed, { allowEvaluate: true, allowCdp: true, diagnostics: true })
})

// ---------------------------------------------------------------------------
// 2. 切开关不许抹掉用户已有配置（profileDir 那次事故）
// ---------------------------------------------------------------------------

test('flipping a gate preserves settings the template does not know about', async () => {
  writePatch(userPatch())
  const reply = await request('POST', '/api/browser-playwright/gates', {
    body: { allowEvaluate: true, allowCdp: false, diagnostics: false },
  })
  assert.equal(reply.status, 200)

  const written = readPatch()
  // profileDir 丢掉 = 下次启动换 profile = 全站登出。这条就是那次事故的钉子。
  assert.match(written, /profileDir: 'D:\/dsh-profile'/, 'profileDir must survive a gate flip')
  assert.match(written, /channel: chrome/, 'the launch channel must survive')
  assert.match(written, /maxSessions: 3/, 'maxSessions must survive')
  assert.match(written, /toolPrefix: "my_"/, 'toolPrefix must survive')
  assert.match(written, /maxWaitMs: 90000/, 'maxWaitMs must survive')
  assert.match(written, /rules: \[\]/, 'content outside the managed block must survive')
  assert.deepEqual(auditYaml(written).issues, [])
})

test('a second save with unchanged values reports changed:false and leaves the file alone', async () => {
  writePatch(userPatch())
  await request('POST', '/api/browser-playwright/gates', {
    body: { allowEvaluate: true, allowCdp: true, diagnostics: true },
  })
  const once = readPatch()
  runtimeState.publishGates({ allowEvaluate: true, allowCdp: true, diagnostics: true })
  const reply = await request('POST', '/api/browser-playwright/gates', {
    body: { allowEvaluate: true, allowCdp: true, diagnostics: true },
  })
  assert.equal(reply.status, 200)
  assert.equal(reply.body.changed, false, 'an unchanged flip must not rewrite the file')
  assert.equal(readPatch(), once, 'the file must be byte-identical when nothing changed')
})

// ---------------------------------------------------------------------------
// 3. 防伪头：四个路由逐个验
// ---------------------------------------------------------------------------

test('every settings route refuses a request without the x-dsh-plugin header', async () => {
  const cases: [string, string, Record<string, unknown>?][] = [
    ['GET', '/api/browser-playwright/state'],
    ['POST', '/api/browser-playwright/toggle', { enabled: true }],
    ['POST', '/api/browser-playwright/engine', { engine: 'aria' }],
    ['POST', '/api/browser-playwright/gates', { allowEvaluate: true, allowCdp: true }],
    ['GET', '/api/browser-playwright/logins'],
    ['GET', '/api/browser-playwright/disk/stat'],
  ]
  for (const [method, path, body] of cases) {
    const reply = await request(method, path, { header: false, body })
    assert.equal(reply.status, 403, method + ' ' + path + ' must be 403 without the header')
    const error = reply.body.error as { code?: string } | undefined
    assert.equal(error?.code, 'CSRF', method + ' ' + path + ' must answer CSRF: ' + JSON.stringify(reply.body))
    // 被拒的请求不许泄露任何内容（例如登录站点列表）。
    assert.equal(reply.body.logins, undefined, method + ' ' + path + ' must not include the payload')
  }
})

test('the same routes answer with the header', async () => {
  runtimeState.publishGates({ allowEvaluate: true, allowCdp: false, diagnostics: false })
  runtimeState.publishLoginSites({
    source: 'cookies',
    capturedAt: '2026-11-12T00:00:00.000Z',
    cookies: 3,
    total: 1,
    sites: [],
  } as never)

  const state = await request('GET', '/api/browser-playwright/state')
  assert.equal(state.status, 200)
  assert.equal(state.body.allowEvaluate, true, 'the route reports the published gates')
  assert.equal(state.body.allowCdp, false)

  const logins = await request('GET', '/api/browser-playwright/logins')
  assert.equal(logins.status, 200)
  assert.ok('logins' in logins.body)

  const toggle = await request('POST', '/api/browser-playwright/toggle', { body: { enabled: false } })
  assert.equal(toggle.status, 200)
  assert.equal(toggle.body.enabled, false)

  const engine = await request('POST', '/api/browser-playwright/engine', { body: { engine: 'aria' } })
  assert.equal(engine.status, 200)
  assert.equal(engine.body.engine, 'aria')
})

// ---------------------------------------------------------------------------
// 4. 方法 / 请求体校验（坏输入在写盘之前就被拒）
// ---------------------------------------------------------------------------

test('wrong methods and bodies are refused before anything is written', async () => {
  writePatch(userPatch())
  const before = readPatch()

  const getToggle = await request('GET', '/api/browser-playwright/toggle')
  assert.equal(getToggle.status, 405)

  const badJson = await request('POST', '/api/browser-playwright/gates', { rawBody: '{not json' })
  assert.equal(badJson.status, 400)
  assert.equal((badJson.body.error as { code?: string }).code, 'INVALID_JSON')

  const wrongType = await request('POST', '/api/browser-playwright/gates', { body: { allowEvaluate: 'yes' } })
  assert.equal(wrongType.status, 400)
  assert.equal((wrongType.body.error as { code?: string }).code, 'INVALID_BODY')

  const badEngine = await request('POST', '/api/browser-playwright/engine', { body: { engine: 'gecko' } })
  assert.equal(badEngine.status, 400)

  assert.equal(readPatch(), before, 'a refused request must not touch the patch file')
})

// ---------------------------------------------------------------------------
// 5. 已有未标记的 loader 行：收编，不许写第二行（2026-11-12 发现）
// ---------------------------------------------------------------------------

test('an unmarked existing loader row is adopted, not duplicated', async () => {
  // 用户手写过、或旧版本留下的行：没有标记，但已经挂了这个包。
  writePatch(
    [
      '# 用户自己的补丁层',
      '- id: browser',
      "  name: 'dsh-browser-playwright-codex'",
      '  config:',
      "    playwright: { profileDir: 'D:/keep-me' }",
      '    tool:',
      '      allowEvaluate: false',
      '',
    ].join('\n'),
  )
  const reply = await request('POST', '/api/browser-playwright/gates', {
    body: { allowEvaluate: true, allowCdp: true, diagnostics: true },
  })
  assert.equal(reply.status, 200, 'adopting the row must succeed: ' + JSON.stringify(reply.body))

  const written = readPatch()
  const audit = auditYaml(written)
  assert.equal(audit.rowIds.length, 1, 'still exactly one loader row after adopting: ' + written)
  assert.match(written, /profileDir: 'D:\/keep-me'/, 'the user key must survive adoption')
  assert.match(written, new RegExp(gatesPatch.BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(written, new RegExp(gatesPatch.END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.deepEqual(audit.issues, [], 'the adopted block must still be valid YAML')
  assert.deepEqual(gatesPatch.parseBrowserBlock(written), {
    allowEvaluate: true,
    allowCdp: true,
    diagnostics: true,
  })
})

test('an unmarked row for a different package fails closed instead of writing a second row', async () => {
  const other = ['# 别人的配置', '- id: browser', "  name: 'someone-else-plugin'", '  config: {}', ''].join('\n')
  writePatch(other)
  const reply = await request('POST', '/api/browser-playwright/gates', {
    body: { allowEvaluate: true, allowCdp: true, diagnostics: false },
  })
  assert.equal(reply.status, 500, 'a conflicting row must be a loud failure, not a broken write')
  assert.equal((reply.body.error as { code?: string }).code, 'PATCH_WRITE')
  assert.match(String((reply.body.error as { message?: string }).message), /id: browser/)
  assert.equal(readPatch(), other, 'the file must be left byte-identical when we refuse')
})

test('the baseline fixture itself is valid YAML (so the assertions above mean something)', () => {
  const audit = auditYaml(originalPatch === '' ? userPatch() : originalPatch)
  assert.deepEqual(audit.issues, [], 'the fixture must be valid, otherwise the duplicate checks are vacuous')
})
