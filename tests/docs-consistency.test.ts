/**
 * docs-consistency — 让「文档里写的事实」和「代码/配置里的真相」互相钉住。
 *
 * 为什么需要它：2026-10-02 一天之内就出现 5 次「文档写的 ≠ 代码事实」，而且**每次都是人偶然发现**：
 *
 *   1. README 工具段、PLUGIN-README：本包出厂 `allowEvaluate` / `allowCdp` **开着**（0.4.7 起是关的）
 *   2. README 安全段、配套件指引：同一句话的另外两次
 *   3. 中文说明 §3.5 / §4.6：把 CDP 白名单写成「`DOM.`/`CSS.`/`Accessibility.`/`Page.`/`Input.` 等前缀家族」
 *      —— 实际是**默认拒绝 + 显式方法清单**，`Accessibility.` 根本不在白名单里，`Input.` 只点名四个方法
 *   4. 中文说明验收表：写着「出厂 bundle 22 工具 ≈ 4842」（实际 20 ≈ 4176）
 *   5. `scripts/measure-prompt-cost.mjs` 自己的标签：解析 `cordis.patch.yml` 时被**注释里的示例**骗到，
 *      把出厂层报成「两个闸门都开着」
 *
 * 它们的共同点是：**一个朴素解析就能当场发现**。所以这件事交给测试，不交给记性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { bundleConfig } from '../scripts/shipped-gates.mjs'
import { registeredToolNames, type ToolSurfaceConfig } from '../src/contract.ts'
import { CDP_ALLOW_PREFIXES } from '../src/cdp-policy.ts'

const read = (rel: string) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8')

/** 文档：这四份是对外承诺，改动它们必须与代码一致。CHANGELOG 是历史，不在此列。 */
const DOCS = ['README.md', 'PLUGIN-README.md', '中文说明.md', 'SECURITY.md']

/** 出厂闸门的**期望值**：包里的默认值改了，就改这一处（并同步文档）。 */
const EXPECTED_SHIPPED_GATES = { allowEvaluate: false, allowCdp: false }

const SURFACE_OFF: ToolSurfaceConfig = {
  allowEvaluate: false,
  allowCdp: false,
  extractConfigured: false,
  registerDisabledTools: false,
}
const SURFACE_BOTH_GATES: ToolSurfaceConfig = { ...SURFACE_OFF, allowEvaluate: true, allowCdp: true }
const SURFACE_ALL: ToolSurfaceConfig = {
  allowEvaluate: true,
  allowCdp: true,
  extractConfigured: true,
  registerDisabledTools: true,
}

test('shipped gates: the parser reads the file, not the example inside a comment', () => {
  const raw = read('cordis.patch.yml')
  const real = bundleConfig()

  assert.deepEqual(real, EXPECTED_SHIPPED_GATES)

  // The trap must still be present in the file, or this test is no longer testing anything:
  // the opt-in snippet in the comments contains the opposite of the real value.
  assert.ok(
    /#.*allowEvaluate: true/.test(raw),
    'cordis.patch.yml should still document the opt-in example in a comment; if that changed, revisit this test',
  )

  // Independent parse (different route to the same truth): drop full-line comments, then
  // cut trailing comments by hand. If the module ever stops stripping comments, the two
  // disagree and this fails — which is exactly how the bug shipped.
  const independent = raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .map((line) => (line.includes('#') ? line.slice(0, line.indexOf('#')) : line))
    .join('\n')
  const row =
    independent.split(/\n(?=\s*- id: )/).find((block) => block.includes('dsh-browser-playwright-codex/tool')) ?? ''
  const flag = (name: string) => new RegExp(name + ':\\s*(true|false)').exec(row)?.[1] === 'true'
  assert.deepEqual(
    { allowEvaluate: flag('allowEvaluate'), allowCdp: flag('allowCdp') },
    real,
    'shipped-gates must agree with a comment-stripped parse of the same file',
  )
})

test('docs: nothing claims the package ships a gate on while it ships it off', () => {
  const on = (v: boolean) => (v ? 'true' : 'false')
  for (const doc of DOCS) {
    const lines = read(doc).split('\n')
    lines.forEach((line, i) => {
      // "this package ships … allowEvaluate: true" — a claim about what the package does.
      const claim = /(ships?|出厂|随包|包里)[^\n]{0,80}allow(Evaluate|Cdp):\s*(true|false)/i.exec(line)
      if (claim === null) return
      const gate = claim[2] === 'Evaluate' ? 'allowEvaluate' : 'allowCdp'
      const value = claim[3] === 'true'
      assert.equal(
        value,
        EXPECTED_SHIPPED_GATES[gate as 'allowEvaluate' | 'allowCdp'],
        `${doc}:${i + 1} claims the package ships ${gate}: ${on(value)} — it ships ${on(
          EXPECTED_SHIPPED_GATES[gate as 'allowEvaluate' | 'allowCdp'],
        )}: ${line.trim()}`,
      )
      // The sentence must also not say "on" in words while the value is false.
      if (!value) {
        assert.ok(
          !/(ships?|出厂|随包)[^\n]{0,60}\*{0,2}(on|打开|开启)\*{0,2}/i.test(line),
          `${doc}:${i + 1} says the gate is on in prose: ${line.trim()}`,
        )
      }
    })
  }
})

test('docs: the tool counts quoted next to `npm run cost` come from contract.ts', () => {
  const off = registeredToolNames('browser_', SURFACE_OFF).length
  const both = registeredToolNames('browser_', SURFACE_BOTH_GATES).length
  const all = registeredToolNames('browser_', SURFACE_ALL).length
  assert.ok(off < both && both < all, `expected the gates to add tools: ${off} / ${both} / ${all}`)

  // Chinese doc: the acceptance table row for the command (not the prose that also names it).
  const zhLine = read('中文说明.md')
    .split('\n')
    .find((line) => line.trimStart().startsWith('| `npm run cost`'))
  assert.ok(zhLine !== undefined, '中文说明.md should still document `npm run cost` in the acceptance table')
  const zhCounts = [...(zhLine as string).matchAll(/(\d+)\s*工具/g)].map((m) => Number(m[1]))
  assert.ok(zhCounts.length > 0, 'the cost row should quote tool counts: ' + (zhLine as string).trim())
  for (const n of zhCounts) {
    assert.ok(
      [off, both, all].includes(n),
      `the cost row quotes ${n} tools, which is no surface contract.ts can produce (${off}/${both}/${all})`,
    )
  }
  assert.ok(
    new RegExp('\\b' + off + '\\b').test(zhLine as string),
    `the cost row must quote the shipped surface (${off} tools): ${(zhLine as string).trim()}`,
  )
  assert.ok(
    new RegExp('\\b' + all + '\\b').test(zhLine as string),
    `the cost row must quote the full surface (${all} tools): ${(zhLine as string).trim()}`,
  )
  assert.ok(
    new RegExp('出厂[^|]{0,60}\\b' + off + '\\b').test(zhLine as string),
    `the shipped row must quote the shipped surface (${off}) next to 出厂: ${(zhLine as string).trim()}`,
  )

  // English README: the same sentence must quote the shipped surface.
  const enLine = read('README.md')
    .split('\n')
    .find((line) => line.includes('`npm run cost`'))
  assert.ok(enLine !== undefined, 'README.md should still document `npm run cost`')
  assert.ok(
    new RegExp(`\\b${off}\\s+tools?\\b`).test(enLine as string),
    `README's cost sentence should quote the shipped surface (${off} tools): ${(enLine as string).trim()}`,
  )
})

test('docs: CDP domains are only advertised as allowed when they are in the allow-list', () => {
  const allowed = (domain: string) => CDP_ALLOW_PREFIXES.some((p) => p.startsWith(domain + '.'))
  const deniedWord = /拒绝|denied|rejected|not allowed|不在/

  for (const doc of DOCS) {
    read(doc)
      .split('\n')
      .forEach((line, i) => {
        // `Accessibility.` is NOT in the allow-list. The doc used to list it as allowed; if it
        // ever becomes allowed, add it to CDP_ALLOW_PREFIXES and delete this guard.
        if (line.includes('Accessibility.')) {
          assert.fail(
            `${doc}:${i + 1} mentions the Accessibility domain, which the CDP allow-list does not contain: ${line.trim()}`,
          )
        }
        if (!/白名单|allow-list/.test(line)) return
        // Every domain named on an allow-list line must either be allowed, or the line must
        // deny it (so documenting "Network. is rejected" stays legal).
        for (const m of line.matchAll(/`([A-Z][A-Za-z0-9]*)\./g)) {
          const domain = m[1] as string
          if (allowed(domain)) continue
          assert.ok(
            deniedWord.test(line),
            `${doc}:${i + 1} names \`${domain}.\` next to an allow-list claim, but that domain is not allowed and the line does not say so: ${line.trim()}`,
          )
        }
      })
  }

  // The old wording described the policy as domain families. It is an explicit list.
  for (const doc of DOCS) {
    assert.ok(
      !read(doc).includes('白名单前缀'),
      `${doc} still uses the old "白名单前缀" wording; the policy is default-deny with an explicit method list`,
    )
  }
})

test('docs: the cost script does not carry a stale claim about the shipped bundle', () => {
  const script = read('scripts/measure-prompt-cost.mjs')
  for (const stale of ['都打开了', 'both gates on', 'allowEvaluate / allowCdp 都打开']) {
    assert.ok(!script.includes(stale), `measure-prompt-cost.mjs still claims: ${stale}`)
  }
  assert.ok(
    script.includes("from './shipped-gates.mjs'"),
    'the cost script should use the shared shipped-gates parser rather than its own',
  )
})

test('docs: a quoted suite total cannot rot into an understated number', () => {
  // A fixed total ("71 项" → "99 项") goes stale the moment a test is added, and that happened
  // twice in one day. A floor stays true: "100+" is fine, an exact number below it is not.
  const FLOOR = 100
  for (const doc of [...DOCS, '对比与优势.md']) {
    read(doc)
      .split('\n')
      .forEach((line, i) => {
        if (!/npm test|项测试|\d+\s+tests?/.test(line)) return
        if (line.includes(FLOOR + '+')) return
        // NOTE: `\b` is useless here — JS word characters are [A-Za-z0-9_], so a boundary after
        // the CJK 项 never matches and the whole check silently passes (measured: "99 项" slipped
        // through the first version of this guard). `(?!\w)` does the job for both scripts.
        for (const m of line.matchAll(/(\d+)\s*(?:项测试|项|tests?)(?!\w)/g)) {
          const n = Number(m[1])
          assert.ok(
            n >= FLOOR,
            `${doc}:${i + 1} quotes ${n} as the suite total, but it only grows — write "${FLOOR}+" or update it: ${line.trim()}`,
          )
        }
      })
  }
})
