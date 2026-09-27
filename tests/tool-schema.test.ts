import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import BrowserRuntime from '../src/service.ts'
import { PlaywrightProvider } from '../src/playwright.ts'
import type { PlaywrightConfig } from '../src/playwright.ts'
import * as browserTool from '../src/tool.ts'
import type { ToolConfig } from '../src/tool.ts'
import { registeredToolNames, toolNames, type ToolSurfaceConfig } from '../src/contract.ts'

const pwConfig: PlaywrightConfig = {
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

/** The shipped defaults: evaluate and cdp off, extract unconfigured. */
const defaultSurface: ToolSurfaceConfig = {
  allowEvaluate: false,
  allowCdp: false,
  extractConfigured: false,
  registerDisabledTools: false,
}

const toolConfig: ToolConfig = {
  toolPrefix: 'browser_',
  allowEvaluate: false,
  allowCdp: false,
  registerDisabledTools: false,
  maxWaitMs: 60000,
  interactiveOnlyDefault: false,
}

/** Assemble one context with the tool family applied and return the wire names. */
async function assemble(config: ToolConfig): Promise<{ root: Context; names: string[] }> {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(BrowserRuntime)
  root.browser.registerProvider(new PlaywrightProvider(pwConfig))
  browserTool.apply(root, config)
  const names = root.tools
    .schemas()
    .map((schema) => schema.name)
    .filter((name) => name.startsWith(config.toolPrefix))
    .sort()
  return { root, names }
}

test('the registered surface matches the contract exactly, in both directions', async () => {
  const { names } = await assemble(toolConfig)
  const expected = registeredToolNames('browser_', defaultSurface).sort()
  // deepEqual, not "contains": a tool the code registers but contract.ts does
  // not list (or vice versa) must fail here, because the tool list is both the
  // model-visible API and the resident prompt cost.
  assert.deepEqual(names, expected)
  // Guard against a contract that has quietly shrunk: every suffix stays known.
  assert.ok(expected.every((name) => toolNames('browser_').includes(name)))
})

test('a disabled capability is not shipped: gated tools stay out of the prompt', async () => {
  const { names } = await assemble(toolConfig)
  for (const gated of ['browser_evaluate', 'browser_cdp', 'browser_extract']) {
    assert.ok(!names.includes(gated), `${gated} must not register while its capability is off`)
  }
  // The always-on surface is unchanged: the batch that costs prompt tokens is
  // bounded by contract.ts, which is what measure-prompt-cost.mjs verifies.
  assert.ok(names.includes('browser_navigate'))
  assert.ok(names.includes('browser_dialog'))
})

test('enabling a capability brings its tool back', async () => {
  const { names } = await assemble({ ...toolConfig, allowEvaluate: true, allowCdp: true })
  assert.ok(names.includes('browser_evaluate'))
  assert.ok(names.includes('browser_cdp'))
  assert.ok(!names.includes('browser_extract'), 'extract needs provider and model, not a boolean')
})

test('registerDisabledTools restores the full discoverable surface', async () => {
  const { names } = await assemble({ ...toolConfig, registerDisabledTools: true })
  assert.deepEqual(names, toolNames('browser_').sort())
})

test('spot-check the wire projection of one schema', async () => {
  const { root } = await assemble(toolConfig)
  const navigate = root.tools.schemas().find((schema) => schema.name === 'browser_navigate')
  assert.ok(navigate !== undefined)
  assert.match(navigate.description, /navigate/i)
  const params = navigate.parameters as { properties: Record<string, unknown>; required: string[] }
  assert.deepEqual(params.required, ['url'])
  assert.ok('waitFor' in params.properties)
})

test('tool names respect the configured prefix', async () => {
  const { root } = await assemble({ ...toolConfig, toolPrefix: 'web_' })
  assert.ok(root.tools.schemas().some((schema) => schema.name === 'web_click'))
})

test('invalid tool prefixes fail plugin load', async () => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  await root.plugin(BrowserRuntime)
  root.browser.registerProvider(new PlaywrightProvider(pwConfig))
  assert.throws(() => browserTool.apply(root, { ...toolConfig, toolPrefix: 'Bad-Prefix!' }), /toolPrefix/)
})
