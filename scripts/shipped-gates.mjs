/**
 * shipped-gates — 「出厂包里那两个闸门到底是什么值」，只此一份实现。
 *
 * 为什么要单独成模块：这段逻辑被注释骗过一次（2026-10-02）。包里 0.4.7 起两个闸门都是
 * false，而 cordis.patch.yml 里同时写着「怎么开启」的注释示例 —— 里面先出现一行
 * `allowEvaluate: true`。一个不剥注释的正则会匹配到**注释**，于是 cost 脚本把出厂层
 * 报成 "两个都开着 / 22 工具 ≈ 4842"，而真实是 "都关着 / 20 工具 ≈ 4176"。
 * 抽出来之后：脚本用它、守卫测试也用它（并对着一份独立解析比对），谁改坏了都会当场失败。
 */
import { readFileSync } from 'node:fs'

/**
 * Read the shipped bundle layer: what a deployment actually gets.
 *
 * Comment lines are stripped first, and that is not cosmetic: the file documents the
 * opt-in snippet, so a naive regex matches the *example* `allowEvaluate: true` inside a
 * comment. Attribute lines inside comments are documentation, not configuration.
 *
 * @param {URL} [patchUrl] - defaults to this package's cordis.patch.yml.
 * @returns {{ allowEvaluate: boolean, allowCdp: boolean }}
 */
export function bundleConfig(patchUrl = new URL('../cordis.patch.yml', import.meta.url)) {
  const yml = readFileSync(patchUrl, 'utf8')
  const code = stripComments(yml)
  const row = code.split(/\n(?=\s*- id: )/).find((block) => block.includes('dsh-browser-playwright-codex/tool')) ?? ''
  if (row === '') throw new Error('cordis.patch.yml: no dsh-browser-playwright-codex/tool row found')
  const flag = (name) => new RegExp(name + ':\\s*(true|false)').exec(row)?.[1] === 'true'
  return { allowEvaluate: flag('allowEvaluate'), allowCdp: flag('allowCdp') }
}

/**
 * Drop `#` comments (full-line and trailing) so documentation examples cannot be read
 * as configuration. Exported so a guard test can compare an independent parse.
 * @param {string} yml
 * @returns {string}
 */
export function stripComments(yml) {
  return yml
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, ''))
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}
