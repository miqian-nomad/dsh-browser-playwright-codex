/**
 * A role="combobox" text input must still expose its value in the snapshot.
 *
 * The <select> value is deliberately omitted (its name already shows the chosen
 * option), but the exclusion is by TAG, not by role: autocomplete search boxes
 * routinely carry an explicit role="combobox" on an <input>, and hiding their
 * value would bring back the "filled but cannot see what I typed" blind spot.
 * This walks the real chain against a local page holding both cases.
 * @module dsh-browser-playwright-codex/tests/combobox-value
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { CallId } from '../src/compat.ts'
import BrowserRuntime from '../src/service.ts'
import { PlaywrightProvider } from '../src/provider.ts'
import * as browserTool from '../src/tool.ts'
import type { PlaywrightConfig } from '../src/config.ts'
import type { ToolConfig } from '../src/tool.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

process.env.DSH_BROWSER_STATE_FILE = path.join(os.tmpdir(), 'dsh-browser-combobox-state.json')

const PAGE = `<!doctype html>
<html><body>
  <label for="combo">Site search</label>
  <input id="combo" role="combobox" aria-label="Site search" autocomplete="off">
  <label for="notes">Notes</label>
  <textarea id="notes" aria-label="Notes"></textarea>
  <label for="variant">Variant</label>
  <select id="variant" aria-label="Variant">
    <option>Small</option>
    <option>Large</option>
  </select>
</body></html>`

const pwConfig: PlaywrightConfig = {
  launch: {
    channel: 'chrome',
    headless: true,
    persistent: false,
    profileDir: path.join(os.tmpdir(), 'dsh-browser-combobox-profile'),
    viewport: { width: 1280, height: 800 },
    navigationTimeoutMs: 8000,
    ignoreHTTPSErrors: false,
  },
  idleTimeoutMs: 0,
  maxSessions: 2,
  snapshot: { engine: 'legacy', diff: false, maxNodes: 500, maxNameLength: 120, maxTextLength: 300 },
}

const toolConfig: ToolConfig = {
  toolPrefix: 'browser_',
  allowEvaluate: true,
  allowCdp: false,
  diagnostics: false,
  registerDisabledTools: false,
  maxWaitMs: 20000,
  interactiveOnlyDefault: false,
}

let server: Server
let base = ''
let provider: PlaywrightProvider

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/combo') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = 'http://127.0.0.1:' + String(typeof address === 'object' && address !== null ? address.port : 0)
  provider = new PlaywrightProvider(pwConfig)
})

after(async () => {
  await provider.dispose()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function assemble(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  nativeExecutor.apply(ctx)
  await ctx.plugin(BrowserRuntime)
  ctx.browser.registerProvider(provider)
  browserTool.apply(ctx, toolConfig)
  return ctx
}

let callCounter = 0

async function call(ctx: Context, name: string, args: unknown): Promise<ToolExecutionResult> {
  callCounter += 1
  const batch = await ctx.tools.execute({
    signal: new AbortController().signal,
    calls: [
      {
        type: 'tool-call',
        id: CallId('call-' + String(callCounter)),
        name,
        arguments: JSON.stringify(args),
      },
    ],
    agent: { session: { id: 'combobox-value-agent' } } as unknown as Agent,
  })
  return batch.results[0]!.result
}

function treeOf(result: ToolExecutionResult): string {
  const value = result.value as { tree?: unknown }
  return typeof value.tree === 'string' ? value.tree : ''
}

function lineFor(tree: string, role: string, name: string): string | undefined {
  return tree.split('\n').find((l) => l.includes('"' + name + '"') && l.includes(role))
}

function refOf(line: string): string | null {
  return /ref=(\w+)/.exec(line)?.[1] ?? null
}

test('a role=combobox text input shows its value; a real <select> does not', async () => {
  const ctx = await assemble()
  const nav = await call(ctx, 'browser_navigate', { url: base + '/combo', waitFor: 'load' })
  assert.equal(nav.isError, false)

  const tree = treeOf(nav)
  const comboLine = lineFor(tree, 'combobox', 'Site search')
  assert.ok(comboLine !== undefined, 'the combobox input must be in the snapshot')
  const comboRef = refOf(comboLine)
  assert.ok(comboRef !== null)

  const filled = await call(ctx, 'browser_fill', { ref: comboRef, text: 'playwright 测试' })
  assert.equal(filled.isError, false, 'browser_fill must accept a role=combobox text input')

  const snap = await call(ctx, 'browser_snapshot', {})
  const snapText = treeOf(snap)
  const afterCombo = lineFor(snapText, 'combobox', 'Site search')
  assert.ok(afterCombo !== undefined)
  assert.match(afterCombo, /value=playwright 测试/, 'the combobox must show what was typed: ' + afterCombo)

  // A real <select> still omits value: its name already names the chosen option.
  const selectLine = lineFor(snapText, 'combobox', 'Variant')
  assert.ok(selectLine !== undefined, 'the select must still be in the snapshot')
  assert.doesNotMatch(selectLine, /value=/, 'a <select> must not print the value twice: ' + selectLine)
})

test('a textarea (which is role=textarea) shows its value', async () => {
  const ctx = await assemble()
  const nav = await call(ctx, 'browser_navigate', { url: base + '/combo', waitFor: 'load' })
  assert.equal(nav.isError, false)
  const tree = treeOf(nav)
  const notesLine = lineFor(tree, 'textarea', 'Notes')
  assert.ok(notesLine !== undefined, 'the textarea must be in the snapshot')
  const ref = refOf(notesLine)
  assert.ok(ref !== null)

  const filled = await call(ctx, 'browser_fill', { ref, text: 'hello notes' })
  assert.equal(filled.isError, false)

  const snap = await call(ctx, 'browser_snapshot', {})
  const after = lineFor(treeOf(snap), 'textarea', 'Notes')
  assert.ok(after !== undefined)
  assert.match(after, /value=hello notes/, 'the textarea must show what was typed: ' + after)
})
