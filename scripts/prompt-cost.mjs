/**
 * prompt-cost — 「工具面常驻成本」的**唯一测量实现**。
 *
 * 为什么单独成模块：这个测量既被 `measure-prompt-cost.mjs`（给人看的 CLI）用，也被文档守卫测试
 * （`tests/docs-consistency.test.ts`）用。两份实现各自漂移过一次了（cost 脚本的标签被注释骗到），
 * 所以这里只留一份。
 *
 * 它只做一件事：组装工具面、读 `ctx.tools.schemas()` 的 wire 尺寸。
 * **不 acquire 会话、不开浏览器** —— 所以测试里也能直接跑。
 */
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import BrowserRuntime from '../src/service.ts'
import { PlaywrightProvider } from '../src/provider.ts'
import * as browserTool from '../src/tool.ts'
import { bundleConfig } from './shipped-gates.mjs'

/** Launch config for the throwaway context (no page is ever opened, so this is inert). */
const PW_CONFIG = {
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

/** `Config({})`: the schema defaults, before any patch layer. */
export const CONFIG_DEFAULTS = {
  toolPrefix: 'browser_',
  allowEvaluate: false,
  allowCdp: false,
  registerDisabledTools: false,
  maxWaitMs: 60000,
  interactiveOnlyDefault: false,
}

/** The shipped bundle layer: Config defaults plus this package's `cordis.patch.yml`. */
export function shippedConfig() {
  return { ...CONFIG_DEFAULTS, ...bundleConfig() }
}

/** Everything registered: gated tools stay registered while off, which also pulls in `extract`. */
export function everythingConfig() {
  return { ...shippedConfig(), registerDisabledTools: true }
}

/** Assemble one tool surface and return its per-schema wire sizes. */
export async function measureSurface(config) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(BrowserRuntime)
  root.browser.registerProvider(new PlaywrightProvider(PW_CONFIG))
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

/** The rough per-turn token estimate the docs quote: characters / 3.6, rounded. */
export const approxTokens = (chars) => Math.round(chars / 3.6)
