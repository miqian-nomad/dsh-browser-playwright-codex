#!/usr/bin/env node
/**
 * measure-prompt-cost —— 常驻 prompt 成本体检。
 *
 * 工具 schema 是随系统提示每轮常驻的：这个脚本把它量出来，改动前后各跑一次，
 * 就知道这次改动有没有偷偷加税。和 doctor 一样，它不碰浏览器，只组装工具面。
 *
 * 用法:  node node_modules/tsx/dist/cli.mjs scripts/measure-prompt-cost.mjs
 *        （或 npm run cost）
 *
 * 三行分别对应三种"默认"，别混：
 *   ① 配置默认值（Config({})，不含任何补丁层）
 *   ② 出厂 bundle 层 —— 本包 cordis.patch.yml 里给 browser-tool 的配置，
 *      也就是 profile 挂上这个 bundle 后真正生效的那份。两个闸门默认关闭，
 *      所以这一行正常情况下应当与 ① 相同；包里的默认值一改，它自己跟着变。
 *   ③ 全量注册（再加 registerDisabledTools: true）
 *
 * 注意：唯一会抬高这个数字的动作是「注册新工具」。文档、脚本、git 都不进 prompt。
 *
 * 测量实现放在 scripts/prompt-cost.mjs：脚本与文档守卫测试（tests/docs-consistency）
 * 共用一份，免得两边各写一遍再各自漂移。
 */
import { CONFIG_DEFAULTS, shippedConfig, everythingConfig, measureSurface, approxTokens } from './prompt-cost.mjs'

function report(label, { rows, total }) {
  console.log('')
  console.log(label)
  console.log('  工具数: ' + rows.length + '   wire 字符总数: ' + total + '   粗估 token: ~' + approxTokens(total))
  console.log('  最贵的 5 个:')
  for (const [name, wire, desc] of rows.slice(0, 5)) {
    console.log('    ' + name.padEnd(26) + ' wire ' + String(wire).padStart(5) + '  (描述 ' + desc + ')')
  }
  return total
}

console.log('常驻 prompt 成本体检（工具 schema 每轮都在系统提示里）')
const t0 = report('① 配置默认值 Config({})', await measureSurface(CONFIG_DEFAULTS))
const shipped = shippedConfig()
const t1 = report(
  '② 出厂 bundle 层（cordis.patch.yml：allowEvaluate=' +
    shipped.allowEvaluate +
    ', allowCdp=' +
    shipped.allowCdp +
    '）',
  await measureSurface(shipped),
)
const t2 = report('③ 全量注册（registerDisabledTools: true，再加 extract）', await measureSurface(everythingConfig()))

console.log('')
console.log(
  '② → ③ 的差 = 被能力开关挡住、没有关掉的那些 schema：' +
    (t2 - t1) +
    ' 字符 ≈ ' +
    approxTokens(t2 - t1) +
    ' token/轮。',
)
console.log('想让这个数字更小，就在 cordis.patch.yml 里把用不上的能力关掉（关掉即不注册）。')
