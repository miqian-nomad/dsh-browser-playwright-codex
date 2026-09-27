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
 * 注意：唯一会抬高这个数字的动作是「注册新工具」或「把策略类工具的 schema
 * 打开」。文档、脚本、git 都不进 prompt，随便写。
 */
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import BrowserRuntime from '../src/service.ts'
import { PlaywrightProvider } from '../src/playwright.ts'
import * as browserTool from '../src/tool.ts'

const pwConfig = {
  launch: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
    navigationTimeoutMs: 5000,
    ignoreHTTPSErrors: false,
  },
  idleTimeoutMs: 0,
  maxSessions: 2,
  snapshot: { maxNodes: 200, maxNameLength: 120, maxTextLength: 300 },
}

const baseConfig = {
  toolPrefix: 'browser_',
  allowEvaluate: false,
  allowCdp: false,
  registerDisabledTools: false,
  maxWaitMs: 60000,
  interactiveOnlyDefault: false,
}

/** Assemble one tool surface and return its per-schema wire sizes. */
async function surface(config) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(BrowserRuntime)
  root.browser.registerProvider(new PlaywrightProvider(pwConfig))
  browserTool.apply(root, config)
  const rows = root.tools
    .schemas()
    .map((s) => [
      s.name,
      JSON.stringify({ name: s.name, description: s.description, parameters: s.parameters }).length,
      s.description.length,
    ])
    .sort((a, b) => b[1] - a[1])
  return { rows, total: rows.reduce((n, r) => n + r[1], 0) }
}

function report(label, { rows, total }) {
  console.log('')
  console.log(label)
  console.log('  工具数: ' + rows.length + '   wire 字符总数: ' + total + '   粗估 token: ~' + Math.round(total / 3.6))
  console.log('  最贵的 5 个:')
  for (const [name, wire, desc] of rows.slice(0, 5)) {
    console.log('    ' + name.padEnd(26) + ' wire ' + String(wire).padStart(5) + '  (描述 ' + desc + ')')
  }
  return total
}

console.log('常驻 prompt 成本体检（工具 schema 每轮都在系统提示里）')
const shipped = await surface(baseConfig)
const t0 = report('① 出厂默认（evaluate / cdp / extract 未启用，故不注册）', shipped)
const full = await surface({ ...baseConfig, allowEvaluate: true, allowCdp: true, registerDisabledTools: true })
const t1 = report('② 全量打开（含被能力开关挡住的那三个）', full)

console.log('')
console.log('结论：默认省下 ' + (t1 - t0) + ' 字符 ≈ ' + Math.round((t1 - t0) / 3.6) + ' token/轮；')
console.log('      要换成可发现性，把 registerDisabledTools / allowEvaluate / allowCdp 打开即可。')
