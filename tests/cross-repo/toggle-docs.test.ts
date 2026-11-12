/**
 * 配套件（`dsh-browser-toggle`）与主插件的文档一致性。
 *
 * 这个文件**故意不在默认测试套件里**（`tests/*.test.ts` 只匹配一层，这里是 `tests/cross-repo/`）。
 *
 * 原因（2026-11-12，MOSS 复核）：它要读**邻座仓库**的文档，而 CI 只 checkout 这一个仓库。
 * 原来它靠 `existsSync('../../dsh-browser-toggle/')` 嗅探文件系统决定跑不跑 —— 于是
 * 同一份代码在不同机器上报出两个数（有邻座仓库：350 通过 / 3 跳过；没有：349 通过 / 4 跳过）。
 * 中间的修法改成"默认跳过"，但**跳过在摘要里和通过看起来一样**，等于把一条没验的检查
 * 藏进数字里。
 *
 * 现在的做法：默认套件里完全没有它，计数因此在任何机器上都一致；`npm run test:toggle`
 * 或 `npm run preflight`（设了 `DSH_TOGGLE_DIR` 时）单独跑它。**没跑就在 preflight 里明写
 * 「未验证」**，不冒充通过。
 *
 * 跑法：`DSH_TOGGLE_DIR=<配套件仓库路径> npm run test:toggle`
 * @module dsh-browser-playwright-codex/tests/cross-repo/toggle-docs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (rel: string): string => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8')
const toggleDir = process.env.DSH_TOGGLE_DIR ?? ''

test('the companion checkout is actually reachable (so a run is not a silent pass)', () => {
  // 这个文件只应该在明确指定了配套件路径时被运行。没有路径就直接失败，而不是"什么都没检查却通过"。
  assert.ok(
    toggleDir !== '',
    'DSH_TOGGLE_DIR is not set: run this suite with `npm run test:toggle` and an explicit path',
  )
})

test('cross-doc: 配套件文档与主插件的安全承诺一致', () => {
  if (toggleDir === '') return // 上一条已经失败；这条不重复报错
  const toggleReadme = readFileSync(join(toggleDir, 'README.md'), 'utf8')
  const toggleZh = readFileSync(join(toggleDir, '中文说明.md'), 'utf8')
  const security = read('SECURITY.md')
  const failures: string[] = []
  for (const [name, text] of [
    ['dsh-browser-toggle/README.md', toggleReadme],
    ['dsh-browser-toggle/中文说明.md', toggleZh],
    ['SECURITY.md', security],
  ] as const) {
    if (!/x-dsh-plugin/.test(text)) failures.push(name + ' 没提 /logins 要求的 x-dsh-plugin 防伪头')
  }
  for (const [name, text] of [
    ['dsh-browser-toggle/README.md', toggleReadme],
    ['dsh-browser-toggle/中文说明.md', toggleZh],
  ] as const) {
    if (!/模型看不到|the model cannot|model cannot read/.test(text)) {
      failures.push(name + ' 没承诺"模型看不到这份名单"')
    }
  }
  assert.deepEqual(failures, [], '配套件与主插件文档对不上:\n  ' + failures.join('\n  '))
})
