#!/usr/bin/env node
/**
 * doctor —— 一句话回答「DSH 又发版了，这个插件还能不能跑」。
 *
 * 逐个 import 这个插件依赖的 @deepseek-ai/* 包，检查源码真正用到的具名导出是否
 * 还在，并打印每个包实际装的版本。类型层面的兼容性由 tsc 回答（npm run build）。
 *
 * 用法:  node scripts/doctor.mjs
 * 退出码 0 = 全部可用；1 = 至少一个包需要处理。
 *
 * 出现 ❌ 时按这个顺序处理：
 *   1. 只是导出改名 → 把引用搬进 src/compat.ts（那里是唯一的边界适配层）；
 *   2. 是插件真用到的运行时 API 没了 → 适配代码，别去改 peer 范围；
 *   3. 装错版本 → 在 profile 里对齐版本，而不是把本目录钉成旧版。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/** 运行时真正 import 的名字；缺一个就是载荷失败。 */
const REQUIRED = {
  '@deepseek-ai/cordis': ['Service'],
  '@deepseek-ai/schemastery': ['default'],
  '@deepseek-ai/dsh-tools': ['default', 'defineTool'],
  '@deepseek-ai/dsh-llm': ['BlockAssembler', 'createUserMessage'],
}

/** 只有测试 / 开发路径用到的包；缺了只提醒，不算失败。 */
const OPTIONAL = {
  '@deepseek-ai/dsh-system-prompt': ['default'],
  '@deepseek-ai/dsh-session': [],
  '@deepseek-ai/dsh-attachment': [],
  '@deepseek-ai/dsh-agent': [],
}

const require = createRequire(import.meta.url)

/** Installed version of one package, or a marker when it is absent. */
function versionOf(pkg) {
  try {
    return JSON.parse(readFileSync(require.resolve(pkg + '/package.json'), 'utf8')).version
  } catch {
    return '(未安装)'
  }
}

/** Probe one package and return the missing export names. */
async function probe(pkg, names) {
  let mod
  try {
    mod = await import(pkg)
  } catch (error) {
    return { missing: names, module: undefined, fatal: String(error.message ?? error) }
  }
  return { missing: names.filter((name) => !(name in mod)), module: mod, fatal: undefined }
}

let failed = 0
console.log('依赖体检（运行时导出）')
console.log('')

for (const [pkg, names] of Object.entries(REQUIRED)) {
  const { missing, fatal } = await probe(pkg, names)
  const version = versionOf(pkg)
  if (fatal !== undefined) {
    failed += 1
    console.log('❌ ' + pkg + ' ' + version)
    console.log('   导入失败: ' + fatal)
    continue
  }
  if (missing.length > 0) {
    failed += 1
    console.log('❌ ' + pkg + ' ' + version + ' —— 缺少导出: ' + missing.join(', '))
    console.log('   ' + (names.length > 0 ? '需要: ' + names.join(', ') : ''))
    continue
  }
  console.log('✅ ' + pkg + ' ' + version + (names.length > 0 ? '  (' + names.join(', ') + ')' : ''))
}

console.log('')
console.log('可选依赖（测试 / 开发路径）')
for (const [pkg, names] of Object.entries(OPTIONAL)) {
  const { missing, fatal } = await probe(pkg, names)
  const version = versionOf(pkg)
  if (fatal !== undefined || missing.length > 0) {
    console.log(
      '⚠️  ' + pkg + ' ' + version + (fatal !== undefined ? ' —— 导入失败' : ' —— 缺少: ' + missing.join(', ')),
    )
    continue
  }
  console.log('✅ ' + pkg + ' ' + version)
}

console.log('')
if (failed === 0) {
  console.log('全部可用。接着跑 `npm test` 与 `npm run verify` 确认行为没变。')
  process.exit(0)
}
console.log(failed + ' 个包需要处理：优先把改名搬进 src/compat.ts，别去钉版本。')
process.exit(1)
