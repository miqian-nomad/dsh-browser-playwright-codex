/**
 * 发版前置审计（preflight）：把"文档对世界说的话"和"包里到底装了什么"一次查干净。
 *
 * 为什么有这个脚本（2026-10-11，用户第二次因此不满）：
 *   之前是"只改点不看面"—— 修了 README 的 npm 说法，却没查 SECURITY 的计数、NOTICE 的路径、
 *   发帖草稿里的数字、以及"文档引用的文件/行号在重构后是否还存在"。用户的原话是
 *   「你能不能检查清楚再发新版本啊，别给我检查出来又一堆 bug」。所以这份检查挂在 `prepublishOnly`
 *   上：**不通过就发不出去**，而不是等用户事后发现。
 *
 * 三类输出，语义严格区分：
 *   ✗ 必须修   —— 硬错误（文件读不到、清单缺项、路径/行号/链接失效、测试失败、计数与实测不符）
 *   ？ 待确认 —— 可能是历史、上游或有意为之（例如 "published since v0.5.1"、上游插件的旧包名）
 *   ✓ 已一致   —— 已经核对过的基线数字
 *
 * 规则刻意收窄避免噪声（第一版误报过：把 IP 当版本号、把上游文档的版本当我们的、把竞品的工具数
 * 当我们的、把"三个闸门合计 127 token"这个子项当成总成本）。
 *
 * 用法: node preflight.mjs [项目根]     退出码: 0 通过 / 2 有硬错误
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const problems = []
const confirm = []
const ok = []

const readOrThrow = (rel) => {
  const p = join(root, rel)
  if (!existsSync(p)) throw new Error('读不到文件（硬错误，不许当通过）：' + rel)
  return readFileSync(p, 'utf8')
}

// ── A. 包里装了什么 ───────────────────────────────────────────────────────────
const packed = new Set(
  JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', shell: true }),
  )[0].files.map((f) => f.path),
)
// 这些是"用户从 npm 装到之后必须能看到"的文件：许可证与归属声明（NOTICE）、安全说明、变更记录、
// 以及让 Gradle 式的 loader 能挂载的 cordis.patch.yml。2026-10-11 的审计就是靠这份清单抓到
// NOTICE.md 一直没进包（npm 只会自动带上 LICENSE，不会带 NOTICE）。
const SHOULD_SHIP = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'NOTICE.md',
  'LICENSE',
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  // 这两个脚本随包发布，而且只依赖 lib/ 与 harness —— 也就是说装上 npm 包的用户能直接跑它们，
  // README 就是这么承诺的。把整个 scripts/ 收窄成白名单时最容易顺手丢掉它们，所以钉在这里。
  'scripts/doctor.mjs',
  'scripts/dsh-browser-verify.mjs',
]
for (const f of SHOULD_SHIP) if (!packed.has(f)) problems.push('包里缺文件：' + f)
if (![...packed].some((p) => p.startsWith('lib/'))) problems.push('包里没有 lib/（插件实际加载的就是它）')
if ([...packed].some((p) => p.startsWith('src/') || p.startsWith('tests/'))) problems.push('包里不该有 src/ 或 tests/')
if ([...packed].some((p) => p.endsWith('.bak'))) problems.push('包里有 .bak 残渣')
ok.push('包内 ' + packed.size + ' 个文件；已确认含 lib/、locale/、cordis.patch.yml，且不含 src/tests/.bak')

// ── B. 基线数字（来自命令本身，不是文档自述） ─────────────────────────────────
const pkg = JSON.parse(readOrThrow('package.json'))
const cost = execFileSync('npm', ['run', 'cost'], { cwd: root, encoding: 'utf8', shell: true })
const toolCount = Number((cost.match(/工具数[:：]\s*(\d+)/) ?? [])[1])
const chars = Number((cost.match(/字符总数[:：]\s*(\d+)/) ?? [])[1])
const tokens = Number((cost.match(/粗估 token[:：]\s*~?(\d+)/) ?? [])[1])
if (!toolCount || !chars || !tokens) problems.push('拿不到 npm run cost 的数字')
else ok.push('成本基线：' + toolCount + ' 工具 / ' + chars + ' 字符 / ~' + tokens + ' token/轮')

const suite = execFileSync('node', ['--test', 'tests/*.test.ts'], { cwd: root, encoding: 'utf8', shell: true })
const n = (re) => Number((suite.match(re) ?? [])[1])
if (n(/ℹ fail (\d+)/) > 0) problems.push('测试有失败：' + n(/ℹ fail (\d+)/) + ' 条')
else
  ok.push(
    '测试：' + n(/ℹ tests (\d+)/) + ' / pass ' + n(/ℹ pass (\d+)/) + ' / fail 0 / skipped ' + n(/ℹ skipped (\d+)/),
  )

// ── C. 文档断言 ───────────────────────────────────────────────────────────────
const docFiles = []
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.md')) docFiles.push(relative(root, p).replace(/\\/g, '/'))
  }
}
walk(root)
const HISTORY = new Set(['CHANGELOG.md'])
/** 上游项目（被借鉴的那个插件）自己的文档：里面出现旧包名/旧版本是对的。 */
const UPSTREAM_DOCS = new Set([
  'PLUGIN-README.md',
  'codex-rules.md',
  'patches/README.md',
  'docs/articles/focus-stealing.md',
])
const current = docFiles.filter((f) => !HISTORY.has(f))

const basenames = new Set()
for (const dir of ['', 'src', 'lib', 'scripts', 'tests', 'locale', 'patches', 'docs', 'docs/articles']) {
  const abs = dir ? join(root, dir) : root
  if (!existsSync(abs)) continue
  for (const e of readdirSync(abs, { withFileTypes: true })) if (e.isFile()) basenames.add(e.name)
}

for (const f of docFiles) {
  const text = readOrThrow(f)
  const currentDoc = current.includes(f)
  text.split('\n').forEach((line, i) => {
    const where = f + ':' + (i + 1)
    const historical = /(since|since v|起|之前|以后|published|发布|历史|历史值|for the record|v0[.]4)/i.test(line)

    // C1. 看起来是"本包版本"的数字
    if (currentDoc && !historical) {
      const notOurs =
        /(Node|node|playwright-core|upstream|上游|Chenyu|Codex|scan of|扫描|dsh-plugin-vet|electron)/i.test(line)
      for (const m of line.matchAll(/\bv(\d+\.\d+\.\d+)\b/g)) {
        if (notOurs) break
        if (m[1] !== pkg.version)
          confirm.push(where + ' 提到版本 v' + m[1] + '（当前 ' + pkg.version + '）→ ' + line.trim().slice(0, 80))
      }
    }

    // C2. 写死的工具数：只有当这句在说"我们"时才核对（竞品对照说的是别人）
    const tc = line.match(/\b(\d{2})\s*(?:个)?\s*(?:browser_\*?\s*)?(?:tools|工具)/i)
    if (currentDoc && tc && Number(tc[1]) >= 10) {
      const aboutUs = /(我们|this package|本包|registered|注册)/i.test(line)
      const aboutThem = /(同类|竞品|其它|其他|competitor|alternative|更轻)/i.test(line)
      if (aboutUs && !aboutThem && Number(tc[1]) !== toolCount)
        problems.push(where + ' 写死工具数 ' + tc[1] + '（实测 ' + toolCount + '）')
    }

    // C3. 写死的总成本：只核对"总计/常驻"这类句子，且量级要像总数（≈127 这种子项不算）
    const tk = line.match(/\b(\d[\d,]{2,6})\s*(?:tokens?|token)/i)
    if (currentDoc && tk) {
      const value = Number(tk[1].replace(/,/g, ''))
      const aboutTotal = /(常驻|总计|合计|resident|per turn|每轮)/i.test(line)
      if (aboutTotal && value >= 500 && Math.abs(value - tokens) > 200)
        problems.push(where + ' 写死的总 token 数 ' + tk[1] + '（实测 ~' + tokens + '）')
    }

    // C4. 旧包名：.state.json 是刻意保留的；上游文档里出现是对的
    if (
      /dsh-browser-playwright(?!-codex)/.test(line) &&
      !UPSTREAM_DOCS.has(f) &&
      !/\.state\.json/.test(line) &&
      !/(上游|upstream|Chenyu)/i.test(line)
    ) {
      confirm.push(where + ' 出现旧包名（确认语境）→ ' + line.trim().slice(0, 80))
    }

    // C5. 反引号里的仓库路径
    for (const m of line.matchAll(/`([A-Za-z0-9._/-]+\.(?:md|ts|js|mjs|cjs|json|yml|yaml))`/g)) {
      const p = m[1]
      if (!p.includes('/') || p.startsWith('~') || p.startsWith('http')) continue
      const abs = p.startsWith('.') ? resolve(root, f, '..', p) : join(root, p)
      if (existsSync(abs)) continue
      if (basenames.has(p.slice(p.lastIndexOf('/') + 1)))
        problems.push(where + ' 路径写错：`' + p + '`（文件在本仓库，但不在这个位置）')
    }

    // C6. 「文件:行号」引用
    for (const m of line.matchAll(/([A-Za-z0-9_./-]+\.(?:ts|js|mjs|cjs|json|yml))[^\n]{0,12}?[:(]\s*~?:?(\d{3,5})/g)) {
      const abs = join(root, m[1].replace(/^\.\//, ''))
      if (!existsSync(abs)) continue
      const lines = readFileSync(abs, 'utf8').split('\n').length
      if (Number(m[2]) > lines)
        problems.push(where + ' 行号越界：' + m[1] + ':' + m[2] + '（该文件现在 ' + lines + ' 行）')
    }
  })
  // C7. markdown 相对链接
  for (const m of readOrThrow(f).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    const target = m[1]
    if (/^(https?:|mailto:)/.test(target) || target.startsWith('#')) continue
    if (!existsSync(resolve(root, f, '..', target))) problems.push(f + ' markdown 链接失效：' + target)
  }
}

// ── 输出 ─────────────────────────────────────────────────────────────────────
console.log('=== ✗ 必须修（硬错误）===')
console.log(problems.length ? problems.map((p) => '  ✗ ' + p).join('\n') : '  （无）')
console.log('')
console.log('=== ？ 待确认（历史 / 上游 / 有意为之）===')
const uniqueConfirm = [...new Set(confirm)]
console.log(uniqueConfirm.length ? uniqueConfirm.map((c) => '  ？ ' + c).join('\n') : '  （无）')
console.log('')
console.log('=== ✓ 已核对 ===')
console.log(ok.map((o) => '  ✓ ' + o).join('\n'))
console.log('')
console.log('结论：' + problems.length + ' 处硬错误、' + uniqueConfirm.length + ' 处待确认。')
process.exitCode = problems.length ? 2 : 0
