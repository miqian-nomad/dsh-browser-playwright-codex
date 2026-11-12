/**
 * coverage — 「哪些模块一条测试都没覆盖」，用 Node 自带的覆盖率做，不引入新依赖。
 *
 * 为什么不用 c8（2026-11-12，MOSS 要求装 c8）：
 *   这个仓库的 `node_modules/@deepseek-ai/*` 全是**指向活运行时的软链接**，往里装包要先跑
 *   `npm install`，那是这台机器上的硬红线（会把 DS 正在用的运行时搅坏）。而 Node 24 自带
 *   `--experimental-test-coverage`，出来的就是行/分支/函数三个数 —— 目标（能出数、能看 0 覆盖）
 *   它已经满足，没必要为此动 node_modules。想换 c8 的话，在一台干净机器上 `npm i -D c8` 即可，
 *   本脚本的入口换成 `c8 node --test ...` 就能用。
 *
 * 自带的报告有一个坑：**它只列"被加载过的文件"**。一个从没被任何测试 import 的模块
 * （恰恰是最该看的那些）根本不出现。所以这里补一步：把 `src/**\/*.ts` 的完整清单和报告里
 * 实际出现过的文件求差集 —— 差出来的就是 0 覆盖，明着列出来。
 *
 * 用法：node scripts/coverage.mjs [--verbose]
 *   退出码恒为 0：覆盖率**不是**门禁（一开始就拿它卡人会挡路）。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const verbose = process.argv.includes('--verbose')

/** Every TypeScript module under src/, as repo-relative posix paths. */
function sourceFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        out.push(relative(root, full).replace(/\\/g, '/'))
      }
    }
  }
  walk(join(root, 'src'))
  return out.sort()
}

/**
 * Parse the tree table Node prints.
 *
 * Rows look like `ℹ scripts` then `ℹ  preflight-suite.mjs | 100.00 | 70.97 | 100.00 |`
 * — one space of indentation per directory level, and a leaf row is the one with
 * the numeric columns. The tree is rebuilt from the leading spaces so the reported
 * leaf names can be matched against real paths.
 */
function parseReport(output) {
  const files = new Map()
  const stack = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/^ℹ\s?/, '')
    const match = /^( *)(\S.*?)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|/.exec(line)
    if (match === null) continue
    const indent = (match[1] ?? '').length
    const name = match[2] ?? ''
    const lines = match[3] ?? ''
    const branches = match[4] ?? ''
    const funcs = match[5] ?? ''
    stack[indent] = name
    stack.length = indent + 1
    if (lines === '' && branches === '' && funcs === '') continue // a directory row
    files.set([...stack].join('/'), {
      lines: Number(lines),
      branches: Number(branches),
      funcs: Number(funcs),
    })
  }
  return files
}

/** The default suite's files, expanded here rather than through a shell glob. */
function testFiles() {
  return readdirSync(join(root, 'tests'))
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => 'tests/' + name)
}

const started = Date.now()
let output = ''
let failedToRun = ''
try {
  // No `shell: true`: on Windows the node path may contain spaces, and a shell mangles the
  // argument list (the first version of this script "ran" in 0.0s and reported every module
  // as uncovered). Passing the file list explicitly keeps it deterministic everywhere.
  output = execFileSync(process.execPath, ['--test', '--experimental-test-coverage', ...testFiles()], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
} catch (error) {
  // 测试失败时覆盖率照样要能看（先看数，再看红）。
  const failed = /** @type {{ stdout?: unknown, stderr?: unknown, message?: unknown }} */ (error)
  output = String(failed.stdout ?? '') + String(failed.stderr ?? '')
  if (String(failed.stdout ?? '') === '' && String(failed.stderr ?? '') === '') {
    failedToRun = String(failed.message ?? error)
  }
}

if (failedToRun !== '') {
  console.error('✗ 覆盖率这次没跑起来：' + failedToRun)
  console.error('  （不报一组假的 0 覆盖：读不到数就说读不到）')
  process.exitCode = 2
  process.exit(2)
}

const reported = parseReport(output)
const sources = sourceFiles()
const covered = sources.filter((file) => reported.has(file))
const uncovered = sources.filter((file) => !reported.has(file))

const byLine = [...reported.entries()]
  .filter(([file]) => file.startsWith('src/'))
  .sort((a, b) => a[1].lines - b[1].lines)

const pct = (value) => value.toFixed(1) + '%'
const totals = sources.length
console.log('')
console.log('=== 覆盖率（Node 自带，仅统计行 / 分支 / 函数）===')
console.log('src/ 模块总数：' + String(totals) + '，本次被测试加载：' + String(covered.length))
console.log('')
console.log('-- 0 覆盖（从来没有被任何测试加载）--')
if (uncovered.length === 0) console.log('  （没有：每个模块都被加载过）')
else for (const file of uncovered) console.log('  ' + file)
console.log('')
console.log('-- 已加载模块里最低的 12 个（按行覆盖）--')
const lowest = byLine.slice(0, 12)
if (lowest.length === 0) console.log('  （没有 src/ 模块出现在报告里）')
for (const [file, stats] of lowest) {
  console.log(
    '  ' +
      pct(stats.lines).padStart(6) +
      ' 行 / ' +
      pct(stats.branches).padStart(6) +
      ' 分支 / ' +
      pct(stats.funcs).padStart(6) +
      ' 函数   ' +
      file,
  )
}
if (verbose) {
  console.log('')
  console.log('-- 全部已加载模块 --')
  for (const [file, stats] of byLine) console.log('  ' + pct(stats.lines).padStart(6) + '  ' + file)
}
console.log('')
console.log('用时 ' + ((Date.now() - started) / 1000).toFixed(1) + 's。覆盖率不是门禁（不进 prepublishOnly）。')
