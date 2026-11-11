/**
 * The value exposure added to the snapshot must never leak a credential.
 *
 * A password field holds a secret the user typed in the visible window; reading
 * it back into the snapshot would send it to the model API. This walks the real
 * chain — browser_navigate -> browser_fill (email, password) -> browser_snapshot —
 * against the store fixture's /login page and asserts the password value never
 * reaches the rendered tree while the ordinary field's value does.
 * @module dsh-browser-playwright-codex/tests/value-privacy
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
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
import { startStoreServer, type StoreFixture } from './fixtures/store-server.ts'

process.env.DSH_BROWSER_STATE_FILE = path.join(os.tmpdir(), 'dsh-browser-value-privacy-state.json')

const pwConfig: PlaywrightConfig = {
  launch: {
    channel: 'chrome',
    headless: true,
    persistent: false,
    profileDir: path.join(os.tmpdir(), 'dsh-browser-value-privacy-profile'),
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

let store: StoreFixture
let provider: PlaywrightProvider

before(async () => {
  store = await startStoreServer()
  provider = new PlaywrightProvider(pwConfig)
})

after(async () => {
  await provider.dispose()
  await store.close()
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
    agent: { session: { id: 'value-privacy-agent' } } as unknown as Agent,
  })
  const settled = batch.results[0]
  if (settled === undefined) throw new Error('tool batch returned no result for ' + name)
  return settled.result
}

function treeOf(result: ToolExecutionResult): string {
  const value = result.value as { tree?: unknown }
  return typeof value.tree === 'string' ? value.tree : ''
}

/** The rendered text a model reads back (content blocks), for message assertions. */
function textOf(result: ToolExecutionResult): string {
  const blocks = (result as unknown as { content?: readonly { type?: string; text?: string }[] }).content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

function lineFor(tree: string, role: string, name: string): string | undefined {
  return tree.split('\n').find((l) => l.includes('"' + name + '"') && l.includes(role))
}

test('a filled password never reaches the snapshot, while an ordinary field does', async () => {
  const ctx = await assemble()
  const nav = await call(ctx, 'browser_navigate', { url: store.base + '/login', waitFor: 'load' })
  assert.equal(nav.isError, false)

  const tree = treeOf(nav)
  const emailRef = lineFor(tree, 'textbox', 'Email')?.match(/ref=(\w+)/)?.[1] ?? null
  const passwordRef = lineFor(tree, 'textbox', 'Password')?.match(/ref=(\w+)/)?.[1] ?? null
  assert.ok(emailRef !== null, 'email box must be in the snapshot')
  assert.ok(passwordRef !== null, 'the password field itself is not hidden — only its value is suppressed')

  // An ordinary field takes a fill and shows its value back.
  const filledEmail = await call(ctx, 'browser_fill', { ref: emailRef, text: 'demo@store.test' })
  assert.equal(filledEmail.isError, false)

  // browser_fill refuses a password outright — the plugin's own rule. The model-facing
  // text names the rule in prose (the stable code stays internal).
  const filledPassword = await call(ctx, 'browser_fill', { ref: passwordRef, text: 'secret123' })
  assert.equal(filledPassword.isError, true, 'browser_fill must refuse a password field')
  assert.match(textOf(filledPassword), /refuses credential fields/i)

  // Simulate the value being there anyway (the user typed it in the visible window):
  // put it on the element directly, then snapshot.
  await call(ctx, 'browser_evaluate', {
    expression: "document.getElementById('login-password').value = 'secret123'",
  })

  const snap = await call(ctx, 'browser_snapshot', {})
  assert.equal(snap.isError, false)
  const snapText = treeOf(snap)

  // The ordinary field shows its value so the model can verify the fill...
  const emailLine = lineFor(snapText, 'textbox', 'Email')
  assert.ok(emailLine !== undefined, 'the email textbox must be in the snapshot')
  assert.match(emailLine, /value=demo@store\.test/)

  // ...but the password line carries NO value flag: the secret must never reach it.
  const passwordLine = lineFor(snapText, 'textbox', 'Password')
  assert.ok(passwordLine !== undefined, 'the password textbox must still be in the snapshot')
  assert.doesNotMatch(passwordLine, /value=/, 'password value leaked: ' + passwordLine)
  assert.doesNotMatch(passwordLine, /secret123/, 'password value leaked: ' + passwordLine)
})

test('each <option> names itself, not the whole select', async () => {
  const ctx = await assemble()
  const nav = await call(ctx, 'browser_navigate', { url: store.base + '/product/keyboard', waitFor: 'load' })
  assert.equal(nav.isError, false)
  const tree = treeOf(nav)

  // The fixture's variant select holds "Brown Switch" and "Blue Switch". Each
  // option line must carry its OWN text; before the fix every option inherited
  // the enclosing label's text and the two became indistinguishable.
  const optionLines = tree.split('\n').filter((l) => l.trimStart().startsWith('- option '))
  assert.ok(optionLines.length >= 2, 'the variant options must be in the snapshot: ' + tree.slice(0, 200))
  const names = optionLines.map((l) => /- option "(.*?)"/.exec(l)?.[1] ?? '')
  assert.deepEqual(names, ['Brown Switch', 'Blue Switch'])
  // No option may repeat the select's whole text.
  for (const line of optionLines) {
    assert.doesNotMatch(line, /Variant.*Switch.*Switch/, 'option name swallowed the whole select: ' + line)
  }
})

test('a card-number field (recognised by autocomplete) never leaks its value', async () => {
  const ctx = await assemble()
  // Put one item in the cart so /checkout renders the payment form.
  await call(ctx, 'browser_navigate', { url: store.base + '/', waitFor: 'load' })
  await call(ctx, 'browser_evaluate', {
    expression:
      "fetch('/api/cart/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'keyboard', qty: 1 }) }).then(r => r.status)",
  })
  const nav = await call(ctx, 'browser_navigate', { url: store.base + '/checkout', waitFor: 'load' })
  assert.equal(nav.isError, false)
  const tree = treeOf(nav)
  const cardRef = lineFor(tree, 'textbox', 'Card number')?.match(/ref=(\w+)/)?.[1] ?? null
  assert.ok(cardRef !== null, 'the card field must be in the snapshot')

  // browser_fill refuses it (it is a credential field)...
  const refused = await call(ctx, 'browser_fill', { ref: cardRef, text: '4111111111111111' })
  assert.equal(refused.isError, true, 'a card-number field must be refused')
  // ...and even with the value present on the element, the snapshot must not read it back.
  await call(ctx, 'browser_evaluate', {
    expression: "document.getElementById('card').value = '4111111111111111'",
  })
  const snap = await call(ctx, 'browser_snapshot', {})
  const snapText = treeOf(snap)
  const cardLine = lineFor(snapText, 'textbox', 'Card number')
  assert.ok(cardLine !== undefined, 'the card field must still be in the snapshot')
  assert.doesNotMatch(cardLine, /value=/, 'card value leaked: ' + cardLine)
  assert.doesNotMatch(snapText, /4111111111111111/, 'card value leaked into the snapshot')
})
