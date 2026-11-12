/**
 * preflight 的测试汇总判读（2026-11-12）。
 *
 * 这条测试存在的理由是一个**真实发生过的假绿**：0.7.8 有 7 条用例被打成
 * `cancelledByParent`，`node --test` 的摘要里 `fail` 仍是 0，旧的 preflight 只读 `fail`
 * 这个数（而且摘要那句 `fail 0` 还是写死的字符串），于是对外说的"278 通过"里实际只跑了
 * 271 条。用户拿到的是一份比实际更漂亮的报告。
 *
 * 所以这里不靠"再跑一遍真测试"来证明，而是直接喂**合成的汇总文本**：造一个"取消 7 条、
 * fail 0"的运行，断言 preflight 的判读函数会红。最后再加一条静态守卫，确保 preflight.mjs
 * 真的在用这个函数 —— 否则函数改红了、脚本却还在用老的正则，等于什么也没修。
 * @module dsh-browser-playwright-codex/tests/preflight-suite
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkSuiteSummary, parseSuiteSummary } from '../scripts/preflight-suite.mjs'

const read = (rel: string) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8')

/** 一段形状正确的 node --test 摘要。 */
const summary = (fields: Record<string, number>, extra = '') =>
  [...Object.entries(fields).map(([name, value]) => 'ℹ ' + name + ' ' + String(value)), ...(extra ? [extra] : [])].join(
    '\n',
  )

test('a clean run passes and the ok line quotes the real numbers', () => {
  const clean = summary({ tests: 353, suites: 0, pass: 350, fail: 0, cancelled: 0, skipped: 3, todo: 0 })
  const result = checkSuiteSummary(clean, 0)
  assert.deepEqual(result.problems, [], 'a clean summary must produce no problems')
  // 旧实现把 `fail 0` 写死成字符串；这里换成另一组数字，okLine 必须跟着变。
  const other = summary({ tests: 100, suites: 0, pass: 97, fail: 0, cancelled: 0, skipped: 3, todo: 0 })
  const otherResult = checkSuiteSummary(other, 0)
  assert.match(otherResult.okLine, /100 \/ pass 97/, 'the ok line must be read, not hard-coded')
  assert.match(otherResult.okLine, /cancelled 0/, 'the ok line must show the cancelled count too')
  assert.match(otherResult.okLine, /todo 0/, 'the ok line must show the todo count too')
})

test('the 0.7.8 shape: 7 cancelled but fail 0 must be RED', () => {
  // 这就是当年被判绿的那一组数字：总数对得上（271 + 7 = 278），fail 是 0。
  const cancelled = summary({ tests: 278, suites: 0, pass: 271, fail: 0, cancelled: 7, skipped: 0, todo: 0 })
  const result = checkSuiteSummary(cancelled, 0)
  assert.ok(result.problems.length > 0, 'cancelled tests must never pass as green')
  assert.match(result.problems.join('\n'), /被取消：7 条/, 'the problem must name the cancelled count')
})

test('a todo test is not a pass', () => {
  const todo = summary({ tests: 10, suites: 0, pass: 9, fail: 0, cancelled: 0, skipped: 0, todo: 1 })
  const result = checkSuiteSummary(todo, 0)
  assert.ok(
    result.problems.some((p) => /todo/.test(p)),
    'todo must be a hard error: ' + result.problems,
  )
})

test('the identity must hold: every test needs a conclusion', () => {
  // 350 条总数，但 349 + 3 = 352 —— 对不上，说明有 2 条的结论根本没被报出来。
  const skew = summary({ tests: 350, suites: 0, pass: 349, fail: 0, cancelled: 0, skipped: 3, todo: 0 })
  const result = checkSuiteSummary(skew, 0)
  assert.ok(
    result.problems.some((p) => /计数对不上/.test(p)),
    'a broken identity must be a hard error: ' + result.problems,
  )
})

test('a missing count is not a zero: unreadable output stays red', () => {
  // 没有 `ℹ cancelled` 这一行（输出格式变了 / 命令没跑起来）：读不到就不算绿。
  const incomplete = ['ℹ tests 10', 'ℹ pass 10', 'ℹ fail 0', 'ℹ skipped 0', 'ℹ todo 0'].join('\n')
  const parsed = parseSuiteSummary(incomplete)
  assert.deepEqual(parsed.missing, ['cancelled'], 'the parser must report what it could not read')
  const result = checkSuiteSummary(incomplete, 0)
  assert.ok(
    result.problems.some((p) => /读不到计数/.test(p)),
    'missing counts must be red, not zero',
  )
})

test('a non-zero exit is red even when the numbers look clean', () => {
  const clean = summary({ tests: 5, suites: 0, pass: 5, fail: 0, cancelled: 0, skipped: 0, todo: 0 })
  const result = checkSuiteSummary(clean, 1)
  assert.ok(
    result.problems.some((p) => /非零退出/.test(p)),
    'exit code 1 must not pass as green',
  )
})

test('cancelledByParent is caught when a Node version reports it', () => {
  const parent = summary(
    { tests: 5, suites: 0, pass: 5, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
    'ℹ cancelledByParent 2',
  )
  const result = checkSuiteSummary(parent, 0)
  assert.ok(
    result.problems.some((p) => /cancelledByParent/.test(p)),
    'the silent-drop channel must be named: ' + result.problems,
  )
})

test('preflight.mjs actually uses this judgement (no orphaned guard)', () => {
  // 静态守卫：函数修好了、脚本却还用老正则，等于没修。这两句就是那条通道的门。
  const script = read('scripts/preflight.mjs')
  assert.ok(script.includes('checkSuiteSummary('), 'preflight.mjs must call checkSuiteSummary')
  assert.ok(!/' fail 0 '|fail 0 \/ skipped/.test(script), 'preflight.mjs still hard-codes the "fail 0" summary string')
  assert.ok(script.includes("from './preflight-suite.mjs'"), 'preflight.mjs must import the shared parser')
})

test('preflight.mjs has no bypass: nothing can replace the test run from outside', () => {
  // 2026-11-12 的教训：为了做端到端证明，第一版给 preflight 开了个 PREFLIGHT_SUITE_OUTPUT_FILE
  // 环境变量，结果是「手写一份全过的汇总、一条测试不跑、门禁照样绿」——假绿通道换了个入口又回来了。
  // 生产门禁不许有任何外部注入点；这条守卫就是防止它再被加回来。
  const script = read('scripts/preflight.mjs')
  assert.ok(
    !/PREFLIGHT_SUITE_(OUTPUT_FILE|EXIT)/.test(script),
    'preflight.mjs must not accept an injected suite summary (that is the false-green channel again)',
  )
  assert.ok(
    /execFileSync\(\s*'node',\s*\['--test'/.test(script),
    'preflight.mjs must run the suite itself, not read a summary from somewhere',
  )
})

test('process level: the shared judgement exits 2 on the 0.7.8 shape', () => {
  // 进程级证明，但走**系统临时目录里的 wrapper**，仓库里的生产脚本一个字都不改。
  // wrapper 做的事和 preflight 对测试汇总是同一件：调 checkSuiteSummary，有硬错误就 exit 2。
  const dir = mkdtempSync(join(tmpdir(), 'dsh-preflight-cancel-'))
  const root = fileURLToPath(new URL('../', import.meta.url))
  const moduleUrl = pathToFileURL(join(root, 'scripts', 'preflight-suite.mjs')).href
  const wrapper = join(dir, 'judge.mjs')
  writeFileSync(
    wrapper,
    [
      'import { checkSuiteSummary } from ' + JSON.stringify(moduleUrl),
      'const result = checkSuiteSummary(process.env.FAKE_SUITE ?? "", 0)',
      'for (const problem of result.problems) console.error("✗ " + problem)',
      'process.exit(result.problems.length > 0 ? 2 : 0)',
    ].join('\n'),
  )
  const fake = ['ℹ tests 278', 'ℹ suites 0', 'ℹ pass 271', 'ℹ fail 0', 'ℹ cancelled 7', 'ℹ skipped 0', 'ℹ todo 0'].join(
    '\n',
  )
  const run = spawnSync(process.execPath, [wrapper], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_SUITE: fake },
    timeout: 60_000,
  })
  const output = String(run.stdout ?? '') + String(run.stderr ?? '')
  assert.equal(run.status, 2, 'the judgement must exit 2 (hard error), got ' + String(run.status) + ':\n' + output)
  assert.match(output, /被取消：7 条/, 'it must name the cancelled count:\n' + output)
})
