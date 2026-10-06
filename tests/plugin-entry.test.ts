/**
 * 入口契约：DSH 的 loader 是按 `package.json` exports 里的子路径加载插件的，
 * `cordis.patch.yml` 里写的就是 `dsh-browser-playwright-codex/playwright`。
 *
 * 这个子路径因此必须导出 **`Config`**（schemastery schema）：Cordis 靠它补默认值。
 * 2026-10-06 就坏过一次 —— 拆分源码时 schema 挪进了 `config.ts`，入口忘了转出，
 * 而 profile 的配置块里**没有 `snapshot`**，`provider.ts` 又直接读 `config.snapshot.engine`。
 * 当时 119 条测试一条都没报，因为它们全都直接 `new PlaywrightProvider(完整配置)`，
 * 没有一条真的从"子路径"加载入口。这个文件补的就是那一段。
 *
 * 检查的是**源码与产物两条路**：产物（`lib/`）才是 loader 实际加载的东西，
 * 所以两者都得在，任何一边漂了都要报红。
 * @module dsh-browser-playwright-codex/tests/plugin-entry
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as entrySource from '../src/playwright.ts'
import * as entryBuilt from '../lib/playwright.js'
import * as toolEntry from '../src/tool.ts'

/** The runtime surface the loader / other packages may rely on for the ./playwright subpath. */
const ENTRY_SURFACE = [
  'Config',
  'PlaywrightProvider',
  'assertAllowedUrl',
  'resolveSnapshotEngine',
  'name',
  'inject',
  'apply',
] as const

/** What a real profile's config block looks like: it never spells out `snapshot`. */
const PROFILE_CONFIG = {
  launch: { headless: true, persistent: true, navigationTimeoutMs: 60_000 },
  idleTimeoutMs: 0,
  maxSessions: 8,
}

const schemaOf = (mod: unknown, label: string): ((input: unknown) => Record<string, never>) => {
  const Config = (mod as { Config?: unknown }).Config
  assert.equal(typeof Config, 'function', `${label} must export a callable Config schema`)
  return Config as (input: unknown) => Record<string, never>
}

test('入口子路径 ./playwright 保留 loader 需要的导出（源码与产物都要有）', () => {
  for (const [label, mod] of [
    ['src/playwright.ts', entrySource],
    ['lib/playwright.js', entryBuilt],
  ] as const) {
    for (const name of ENTRY_SURFACE) {
      assert.ok(name in mod, `${label} 少了导出 \`${name}\` —— loader 或既有调用方会直接失败`)
    }
  }
})

test('入口 schema 会补上 provider 真正会读的默认值', () => {
  const config = schemaOf(entrySource, 'src/playwright.ts')({}) as unknown as {
    snapshot: { engine: string; maxNodes: number }
    launch: { navigationTimeoutMs: number }
  }
  assert.equal(config.snapshot.engine, 'legacy', 'provider.ts 读 config.snapshot.engine')
  assert.equal(typeof config.snapshot.maxNodes, 'number')
  assert.equal(config.launch.navigationTimeoutMs, 30_000)
})

test('P1 的原始故障场景：不含 snapshot 的 profile 配置也必须能起来', () => {
  const config = schemaOf(entrySource, 'src/playwright.ts')(PROFILE_CONFIG) as unknown as {
    snapshot: { engine: string }
  }
  assert.equal(config.snapshot.engine, 'legacy')
  assert.doesNotThrow(() => void config.snapshot.engine, 'provider 在构造期就会读它')
})

test('产物与源码的 schema 行为一致（loader 加载的是产物）', () => {
  const fromSource = schemaOf(entrySource, 'src/playwright.ts')(PROFILE_CONFIG)
  const fromBuilt = schemaOf(entryBuilt, 'lib/playwright.js')(PROFILE_CONFIG)
  assert.deepEqual(fromBuilt, fromSource, 'lib/ 与 src/ 漂了 —— 记得 npm run build')
})

test('cordis.patch.yml 的 loader 行指向的就是上面被测的这三个子路径', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  for (const sub of ['service', 'playwright', 'tool'] as const) {
    assert.match(
      patch,
      new RegExp('dsh-browser-playwright-codex/' + sub),
      `cordis.patch.yml 必须挂载 <pkg>/${sub}，否则这个测试覆盖的不是真正被加载的模块`,
    )
  }
})

test('工具侧 schema 也自带默认值（配置块不写全套键也不会 undefined）', () => {
  const config = schemaOf(toolEntry, 'src/tool.ts')({}) as unknown as {
    interactiveOnlyDefault: boolean
  }
  // The home patch spells out five of the six tool keys; this one is only ever defaulted.
  assert.equal(config.interactiveOnlyDefault, false)
})
