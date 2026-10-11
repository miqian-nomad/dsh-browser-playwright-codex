/**
 * 文档必须与现实一致（"对外表述 vs 事实"这一类）。
 *
 * 为什么单独一个文件：`docs-consistency.test.ts` 盯的是"工具数、闸门出厂状态、忽略清单"这些
 * **由本仓库配置决定**的事实；这里盯的是另一类 —— **文档对世界说了什么**。2026-10-11 的第三方
 * 评审就是在这一类上扣的分：
 *
 *   1. README 第 42 行写着 "This package is **not on npm**"，而包从 v0.5.1（2026-10-05）起就在 npm 上；
 *      讽刺的是同一份 README 第 13 行又写着 `# from npm`。原来的守卫只管"闸门开还是关"，没管
 *      "在不在 npm 上"。
 *   2. NOTICE.md 里 7 个路径写成 `docs/PLUGIN-README.md`、`docs/DIALOG-POLICY.md` …，实际这些文件都在
 *      仓库根目录（`docs/` 下只有 `articles/`）。链接检查器只查 markdown 链接语法，**反引号包着的
 *      路径漏网**。
 *
 * 规则刻意设计成不误伤：见下面每条的注释。
 * @module dsh-browser-playwright-codex/tests/doc-reality
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const read = (rel: string): string => readFileSync(new URL(rel, ROOT), 'utf8')

/** 历史记录不算「对当下的承诺」：CHANGELOG 里说「当时还不在 npm 上」是真话。 */
const HISTORY = new Set(['CHANGELOG.md'])

/** Every markdown file that talks to the outside world (drafts under docs/articles included). */
function docFiles(): string[] {
  const walk = (dir: URL, prefix: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      if (entry.isDirectory()) out.push(...walk(new URL(entry.name + '/', dir), prefix + entry.name + '/'))
      else if (entry.name.endsWith('.md')) out.push(prefix + entry.name)
    }
    return out
  }
  return walk(ROOT, '').filter((file) => !HISTORY.has(file))
}

/** All file basenames that actually live in this repository (root + a few source dirs, one level deep). */
function repoBasenames(): Set<string> {
  const names = new Set<string>()
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile()) names.add(entry.name)
  }
  for (const dir of ['src', 'lib', 'scripts', 'tests', 'locale', 'patches', 'docs', 'docs/articles']) {
    const url = new URL(dir + '/', ROOT)
    if (!existsSync(url)) continue
    for (const entry of readdirSync(url, { withFileTypes: true })) if (entry.isFile()) names.add(entry.name)
  }
  return names
}

test('no document claims the package is not on npm', () => {
  // A flat ban, not a "check against the registry": the package has been on npm since v0.5.1, and a
  // guard that had to reach the network could not run in CI. If the package ever *stops* being
  // published, this test is the thing that has to change — deliberately, with a reason.
  const claim = /(not on npm|not published to npm|不在\s*npm|未发布到\s*npm)/i
  const offenders = docFiles().filter((file) => claim.test(read(file)))
  assert.deepEqual(offenders, [], 'these documents still say the package is not on npm: ' + offenders.join(', '))
})

test('the README shows the npm install path', () => {
  // The twin of the rule above: if the package is on npm, the first install instruction must say so.
  const readme = read('README.md')
  assert.match(
    readme,
    /dsh plugin --profile <name> add dsh-browser-playwright-codex\b/,
    'README must show `dsh plugin --profile <name> add dsh-browser-playwright-codex` as an install path',
  )
})

test('every backticked repository path in the docs exists', () => {
  // Only flags a path that is *clearly ours but in the wrong place*: the path does not exist, yet a
  // file with the same basename does exist in this repository. That catches the NOTICE.md bug
  // (`docs/PLUGIN-README.md` while the file sits at the repo root) and stays quiet about genuine
  // external references — NOTICE.md points readers at an upstream document named
  // `docs/browser-safety.md`, which exists in no shape here and must not be "fixed" into our tree.
  const basenames = repoBasenames()
  const offenders: string[] = []
  for (const file of docFiles()) {
    const text = read(file)
    for (const match of text.matchAll(/`([A-Za-z0-9._/-]+\.(?:md|ts|js|mjs|cjs|json|yml|yaml))`/g)) {
      const path = match[1]
      if (!path.includes('/')) continue
      if (path.startsWith('~') || path.startsWith('http')) continue
      // `./x` / `../x` 相对「写它的那份文档」；其余一律相对仓库根（src/tool.ts 就是 src/tool.ts）
      const resolved = path.startsWith('.') ? new URL(path, new URL(file, ROOT)) : new URL(path, ROOT)
      if (existsSync(resolved)) continue
      const basename = path.slice(path.lastIndexOf('/') + 1)
      if (basenames.has(basename)) offenders.push(file + ' → `' + path + '` (该文件在仓库里，但不在这个路径)')
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these documents point at a path where the file does not live:\n  ' + offenders.join('\n  '),
  )
})

test('line-number references in the docs still point inside the file', () => {
  // 0.5.x 的重构把代码搬了家：SECURITY.md 里 "src/playwright.ts (~:2041)" 这种"文件名 + 行号"
  // 的引用在这之后就是错的（那个文件现在只有 55 行）。上一版守卫只查"路径存不存在"，覆盖不到
  // 这个形态 —— 于是加这一条：行号必须落在该文件当前的行数之内，否则报错。
  // 只有**同时**写了文件名与行号、且文件名真在仓库里时才判（纯数字在散文里太常见，不能乱抓）。
  const reference = /([A-Za-z0-9_./-]+\.(?:ts|js|mjs|cjs|json|yml))[^\n]{0,12}?[:(]\s*~?:?(\d{3,5})/g
  const offenders: string[] = []
  for (const file of docFiles()) {
    for (const match of read(file).matchAll(reference)) {
      const path = match[1].replace(/^\.\//, '')
      if (!existsSync(new URL(path, ROOT))) continue
      const lines = readFileSync(new URL(path, ROOT), 'utf8').split('\n').length
      if (Number(match[2]) > lines)
        offenders.push(file + ' → ' + match[1] + ':' + match[2] + '（该文件现在只有 ' + lines + ' 行）')
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these documents cite a line number past the end of the file: \n  ' + offenders.join('\n  '),
  )
})

test('a numeric Critical count lives only in SECURITY.md', () => {
  // 计数会随扫描器与代码变（v0.4.9 时代是 2，0.5.3 是 1）。所以规定：**只有 SECURITY.md 写数字**，
  // 其它文档一律用文字指过去（"那个 Critical"）。否则任何一次扫描变化都会重新种出"两份文档对不上"。
  // CHANGELOG 是历史记录，跳过。
  const numeric = /\b[0-9]+\s*(?:个\s*)?Critical\b/i
  const offenders = docFiles().filter((file) => file !== 'SECURITY.md' && numeric.test(read(file)))
  assert.deepEqual(
    offenders,
    [],
    'only SECURITY.md may state a numeric Critical count (others: refer to it): ' + offenders.join(', '),
  )
})
