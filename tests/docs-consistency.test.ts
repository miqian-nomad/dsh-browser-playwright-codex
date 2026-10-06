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
import {
  CONFIG_DEFAULTS,
  shippedConfig,
  everythingConfig,
  measureSurface,
  approxTokens,
} from '../scripts/prompt-cost.mjs'
import { registeredToolNames, type ToolSurfaceConfig } from '../src/contract.ts'
import { CDP_ALLOWED_METHODS } from '../src/cdp-policy.ts'

const read = (rel: string) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8')

/** 文档：这四份是对外承诺，改动它们必须与代码一致。CHANGELOG 是历史，不在此列。 */
const DOCS = ['README.md', 'PLUGIN-README.md', '中文说明.md', 'SECURITY.md']

/** 出厂闸门的**期望值**：包里的默认值改了，就改这一处（并同步文档）。 */
const EXPECTED_SHIPPED_GATES = { allowEvaluate: false, allowCdp: false }
const ANY_SHIPPED_GATE_ON = EXPECTED_SHIPPED_GATES.allowEvaluate || EXPECTED_SHIPPED_GATES.allowCdp

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
  // Both rules are anchored on a *shipping* word, so ordinary advice stays out of scope
  // ("opt in with `allowEvaluate: true`" is not a claim about the package). Proximity matters:
  // SECURITY.md legitimately writes "Only when `allowEvaluate: true`. **The package ships
  // `false`**" — the value belongs to the reachability condition, not to the shipping claim.
  const shipped = '(ships?|出厂|随包|包里|本包自?带|bundle 层)'
  // A: the shipping word is followed by an explicit gate value — "ships `allowEvaluate: false`".
  const explicit = new RegExp(shipped + '[^\\n]{0,24}allow(Evaluate|Cdp)\\s*:\\s*(true|false)', 'i')
  // B: the shipping word is followed by a gate named in prose and a nearby "on" word —
  // "本包自带的 bundle 层是… `allowEvaluate`/`allowCdp` 打开".
  const prose = new RegExp(
    shipped + '[^\\n]{0,40}allow(Evaluate|Cdp)[^\\n]{0,24}(打开|开启|启用|默认开|\\bon\\b|enabled)',
    'i',
  )
  const offWord = /(关闭|默认关|\boff\b|disabled)/i
  for (const doc of DOCS) {
    read(doc)
      .split('\n')
      .forEach((line, i) => {
        const a = explicit.exec(line)
        if (a !== null) {
          const gate = ('allow' + a[2]) as 'allowEvaluate' | 'allowCdp'
          assert.equal(
            a[3] === 'true',
            EXPECTED_SHIPPED_GATES[gate],
            `${doc}:${i + 1} claims the package ships ${gate}: ${on(a[3] === 'true')} — it ships ${on(
              EXPECTED_SHIPPED_GATES[gate],
            )}: ${line.trim()}`,
          )
        }
        const b = prose.exec(line)
        if (b === null) return
        // 2026-10-06: the guard used to require an explicit `: true|false` and put the prose check
        // behind that early return, so 中文说明.md said "本包自带的 bundle 层是… `allowEvaluate`/
        // `allowCdp` 打开" for two days while the package shipped both off. A sentence that says
        // "on" without saying "off" has to match what actually ships.
        const window = line.slice(b.index, b.index + b[0].length)
        if (offWord.test(window)) return
        const gate = ('allow' + b[2]) as 'allowEvaluate' | 'allowCdp'
        assert.ok(
          EXPECTED_SHIPPED_GATES[gate],
          `${doc}:${i + 1} says the package ships ${gate} on, but it ships ${on(
            EXPECTED_SHIPPED_GATES[gate],
          )}: ${line.trim()}`,
        )
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
  const allowed = (domain: string) => CDP_ALLOWED_METHODS.some((p) => p.startsWith(domain + '.'))
  const deniedWord = /拒绝|denied|rejected|not allowed|不在/

  for (const doc of DOCS) {
    read(doc)
      .split('\n')
      .forEach((line, i) => {
        // `Accessibility.` is NOT in the allow-list. The doc used to list it as allowed; if it
        // ever becomes allowed, add it to CDP_ALLOWED_METHODS and delete this guard.
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
    script.includes("from './prompt-cost.mjs'"),
    'the cost script should use the shared measurement module rather than its own copy',
  )
  assert.ok(
    read('scripts/prompt-cost.mjs').includes("from './shipped-gates.mjs'"),
    'the shared measurement should take the shipped gates from shipped-gates.mjs',
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

// ---------------------------------------------------------------------------
// The token-effect table: measured, not eyeballed
// ---------------------------------------------------------------------------
// Scoping by keyword was the original mistake here: the guard looked at "the line containing
// `npm run cost`" (the caption) while the numbers live in table rows two lines below, so a row
// could say "evaluate + cdp on, 22 tools, 17,430 chars" long after the gates shipped off.
// These values are COMPUTABLE (measureSurface assembles the tool surface without opening a
// browser), so they are pinned to the measurement instead of to a pattern.
//
// Deliberately out of scope: historical deltas ("18,065 →", "-390 characters", "+211"). They
// describe a change that already happened and cannot rot; pinning them would be noise.

test('docs: the token-effect table quotes measured values for every layer', async () => {
  const [def, ship, all] = await Promise.all([
    measureSurface(CONFIG_DEFAULTS),
    measureSurface(shippedConfig()),
    measureSurface(everythingConfig()),
  ])
  const expected = [
    { label: /Schema defaults/i, surface: def },
    { label: /Shipped bundle/i, surface: ship },
    { label: /Everything registered/i, surface: all },
  ]

  for (const doc of ['README.md', 'PLUGIN-README.md']) {
    const lines = read(doc).split('\n')
    const header = lines.findIndex((line) => /^\|\s*Surface\s*\|\s*Tools\s*\|/.test(line.trim()))
    assert.ok(header >= 0, `${doc}: the token-effect table header is gone`)
    const rows = lines
      .slice(header + 2)
      .filter((line) => line.trim().startsWith('|'))
      .slice(0, expected.length)
    assert.equal(rows.length, expected.length, `${doc}: expected ${expected.length} surface rows`)

    rows.forEach((row, i) => {
      const cells = row.split('|').map((c) => c.trim())
      const want = expected[i] as (typeof expected)[number]
      assert.ok(want.label.test(row), `${doc}: row ${i + 1} should describe ${want.label}: ${row.trim()}`)
      const tools = Number(cells[2])
      const chars = Number((cells[3] ?? '').replace(/,/g, ''))
      const tokens = Number((cells[4] ?? '').replace(/[^\d]/g, ''))
      assert.equal(
        tools,
        want.surface.rows.length,
        `${doc}: row ${i + 1} quotes ${tools} tools; measured ${want.surface.rows.length}: ${row.trim()}`,
      )
      assert.equal(
        chars,
        want.surface.total,
        `${doc}: row ${i + 1} quotes ${chars} characters; measured ${want.surface.total}: ${row.trim()}`,
      )
      assert.equal(
        tokens,
        approxTokens(want.surface.total),
        `${doc}: row ${i + 1} quotes ≈${tokens} tokens; measured ≈${approxTokens(want.surface.total)}: ${row.trim()}`,
      )
      // The row's own wording must not contradict the gates it describes. Kept to the phrasing that
      // actually went stale ("evaluate + cdp on") — a broad "allowCdp … true" check would flag the
      // legitimate sentence "browser_cdp stays off until `allowCdp: true`".
      if (i === 1 && !ANY_SHIPPED_GATE_ON) {
        assert.ok(
          !/evaluate\s*\+\s*cdp\s*on|闸门[^|]{0,10}开|都开着/i.test(row),
          `${doc}: the shipped row says the gates are on while they ship off: ${row.trim()}`,
        )
      }
    })
  }
})

test('docs: prose about the shipped layer agrees with the shipped surface', () => {
  // The narrow keyword net (the table above is the structured one): any line that talks about the
  // shipped layer and names a tool count must name the real one. The gate wording is checked in the
  // table test instead — a broad "allowCdp … true" rule here would flag the legitimate sentence
  // "browser_cdp stays off until `allowCdp: true`".
  const off = registeredToolNames('browser_', SURFACE_OFF).length
  for (const doc of [...DOCS, '对比与优势.md']) {
    read(doc)
      .split('\n')
      .forEach((line, i) => {
        if (!/shipped (bundle )?layer|出厂 bundle|出厂层/i.test(line)) return
        for (const m of line.matchAll(/(\d+)\s*(?:工具|tools?)(?!\w)/g)) {
          assert.equal(
            Number(m[1]),
            off,
            `${doc}:${i + 1} says the shipped layer has ${m[1]} tools; it has ${off}: ${line.trim()}`,
          )
        }
      })
  }
})

test('docs: every file quotes the same acceptance count', () => {
  // Not derivable without running the acceptance suite (which needs a browser), so this only pins
  // the files to each other — enough to catch "one file updated, the others left behind".
  const claims = new Map<number, string[]>()
  for (const doc of [...DOCS, '对比与优势.md']) {
    read(doc)
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(/(\d+)\s*(?:项自包含验收|self-contained acceptance checks?)/g)) {
          const n = Number(m[1])
          const list = claims.get(n) ?? []
          list.push(`${doc}:${i + 1}`)
          claims.set(n, list)
        }
      })
  }
  assert.ok(
    claims.size <= 1,
    'the acceptance count is quoted differently across files: ' +
      JSON.stringify([...claims].map(([n, where]) => `${n} @ ${where.join(', ')}`)),
  )
})

test("docs: the registry entry matches the code and opens with the user's words", () => {
  // The `awesome-dsh-plugin` registry is the catalog behind dsh-market — the market most DSH users
  // install first — and this description is the text they read there. It is kept in-repo (and
  // pushed to the PR branch) precisely so the same guards cover it: numbers against contract.ts,
  // gate defaults against cordis.patch.yml, and the opening line against how people actually search
  // (source: the author's own finding that the first version led with "无障碍快照 / 稳定 ref", which
  // nobody searching "dsh 浏览器 填表" would ever match).
  const entry = read('registry/awesome-dsh-plugin.yml')
  const off = registeredToolNames('browser_', SURFACE_OFF).length
  const all = registeredToolNames('browser_', SURFACE_ALL).length
  const gated = all - off

  assert.ok(
    entry.includes('url: https://github.com/miqian-nomad/dsh-browser-playwright-codex'),
    'the entry must point at this repository',
  )
  assert.ok(entry.includes('name: miqian-nomad/dsh-browser-playwright-codex'), 'the entry name must match')
  assert.ok(/^category: browser$/m.test(entry), 'the entry category should stay "browser"')

  for (const want of [`${all} Playwright tools`, `${off} always on`, `${gated} gated`]) {
    assert.ok(entry.includes(want), `the English entry should quote the measured surface (${want})`)
  }
  for (const want of [`${all} 个 Playwright 工具`, `${off} 个常驻`, `${gated} 个默认关闭`]) {
    assert.ok(entry.includes(want), `the Chinese entry should quote the measured surface (${want})`)
  }
  assert.ok(/off by default/.test(entry) && /默认关闭/.test(entry), 'the entry must say the gates ship off')

  const zh = /zh:\s*'(.*)'/.exec(entry)?.[1] ?? ''
  assert.ok(zh !== '', 'the entry needs a Chinese description')
  const firstSentence = zh.split('。')[0] ?? ''
  const NEED = ['浏览器', '网页', '填表', '抓取', '多标签', '登录', '账号']
  const hits = NEED.filter((word) => firstSentence.includes(word))
  assert.ok(
    hits.length >= 3,
    `the pitch should open with words a user searches for (found ${hits.join('/') || 'none'}): ${firstSentence}`,
  )
  for (const jargon of ['无障碍快照', '稳定 ref', 'CSS 选择器', '工具族']) {
    assert.ok(
      !firstSentence.includes(jargon),
      `the pitch should not open with implementation jargon (${jargon}): ${firstSentence}`,
    )
  }
})

test('the changelog heading and package.json version agree', () => {
  // A version bump that forgets the CHANGELOG (or the reverse) is exactly the kind of drift the other
  // guards here exist to catch, and it stays invisible until someone reads both files side by side.
  const version = (JSON.parse(read('package.json')) as { version: string }).version
  // Tolerant of a Keep-a-Changelog style heading (`## [1.2.3] - 2026-10-03`), so a future reformat cannot
  // turn this into a confusing "undefined !== 0.5.0"; a missing heading is reported as such.
  const heading = /^## \[?(\d+\.\d+\.\d+)\]?/m.exec(read('CHANGELOG.md'))?.[1]
  assert.ok(heading, 'CHANGELOG.md needs a version heading near the top (## 1.2.3 or ## [1.2.3])')
  assert.equal(heading, version, `CHANGELOG's top section (${heading}) must be the package version (${version})`)
})

test('the README update log opens with the newest minor release', () => {
  // The 更新记录 section in README.md is the first thing a visitor reads, and it is hand-written. When
  // the 0.5.0 bullet was filed under the 0.4.0 heading, the repository looked like it had stopped at
  // 0.4.0 while the release list said v0.5.0 was latest. Only the opening entry is asserted: the log
  // deliberately keeps a curated set of milestones (0.2.0 is in CHANGELOG.md and not listed here).
  const section = read('README.md')
    .split(/^## /m)
    .find((part) => part.startsWith('更新记录'))
  assert.ok(section, 'README.md lost its 更新记录 section')
  const listed = [...section.matchAll(/^### (\d+\.\d+\.\d+)/gm)].map((m) => m[1])
  assert.ok(listed.length > 0, 'the 更新记录 section lists no versions')
  const released = new Set([...read('CHANGELOG.md').matchAll(/^## (\d+\.\d+\.\d+)/gm)].map((m) => m[1]))
  for (const version of listed) {
    assert.ok(released.has(version), `README.md logs ${version}, which is not in CHANGELOG.md`)
  }
  const newest = [...released]
    .filter((version) => version.endsWith('.0'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1)
  assert.equal(listed[0], newest, `the README update log must open with ${newest}, not ${listed[0]}`)
})
