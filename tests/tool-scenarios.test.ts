/**
 * Tool-layer scenarios: the same journeys as tests/scenarios.test.ts but driven
 * through ctx.tools.execute — the exact path a model takes (tool name, JSON
 * arguments, canonical value, rendered content blocks). A fabricated Agent
 * carries the harness session id that becomes the browser owner key, and fake
 * attachments/llm services stand in for the harness composition.
 * @module dsh-browser-playwright-codex/tests/tool-scenarios
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
// Boundary adapter: the harness renamed CallId to ToolCallId; this plugin owns
// its own brand so a harness release cannot break the import (src/compat.ts).
import { CallId } from '../src/compat.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BrowserRuntime from '../src/service.ts'
import { PlaywrightProvider } from '../src/playwright.ts'
import type { PlaywrightConfig } from '../src/playwright.ts'
import * as browserTool from '../src/tool.ts'
import type { ToolConfig } from '../src/tool.ts'
import { startStoreServer, type StoreFixture } from './fixtures/store-server.ts'

// 隔离设置页的真实用户状态：这套用例的期望值按 legacy（兼容模式）的树写。
process.env.DSH_BROWSER_STATE_FILE = path.join(os.tmpdir(), 'dsh-browser-tests-state-isolated.json')

const pwConfig: PlaywrightConfig = {
  launch: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
    navigationTimeoutMs: 5000,
    ignoreHTTPSErrors: false,
  },
  idleTimeoutMs: 0,
  maxSessions: 6,
  snapshot: { maxNodes: 500, maxNameLength: 120, maxTextLength: 300 },
}

const toolConfig: ToolConfig = {
  toolPrefix: 'browser_',
  allowEvaluate: false,
  allowCdp: false,
  registerDisabledTools: false,
  maxWaitMs: 60000,
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

// ---------------------------------------------------------------------------
// Harness stand-ins
// ---------------------------------------------------------------------------

/** A fabricated agent whose session id becomes the browser owner key. */
function agentFor(id: string): Agent {
  return { session: { id } } as unknown as Agent
}

let callCounter = 0

/** Fresh assembled context per test; all share the one real browser. */
async function assemble(overrides: Partial<ToolConfig> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(BrowserRuntime)
  ctx.browser.registerProvider(provider)
  browserTool.apply(ctx, { ...toolConfig, ...overrides })
  return ctx
}

/** Execute one tool exactly like the agent loop does. */
async function call(ctx: Context, name: string, args: unknown, agentId = 'tool-agent-1'): Promise<ToolExecutionResult> {
  callCounter += 1
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('call-' + String(callCounter)),
    name,
    arguments: args,
    agent: agentFor(agentId),
  })
}

/** Poll a tool until its canonical value satisfies the condition. */
async function callUntil(
  ctx: Context,
  name: string,
  args: unknown,
  condition: (value: unknown) => boolean,
  label: string,
  agentId = 'tool-agent-1',
  timeoutMs = 8000,
): Promise<ToolExecutionResult> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    const result = await call(ctx, name, args, agentId)
    if (!result.isError && condition(result.value)) return result
    if (result.isError) lastError = result.error
    if (Date.now() > deadline) {
      // Transient failures (e.g. a snapshot racing a JS navigation) are
      // retried like the agent loop would; only a persistent failure fails.
      if (lastError !== undefined)
        assert.fail('tool kept failing while waiting for ' + label + ': ' + JSON.stringify(lastError))
      assert.fail('tool condition never true: ' + label)
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/** The snapshot tree text a model reads from a browser tool result. */
function treeOf(result: ToolExecutionResult): string {
  assert.equal(result.isError, false)
  const value = result.value as { tree?: unknown }
  assert.equal(typeof value.tree, 'string', 'snapshot value must carry the rendered tree')
  return value.tree as string
}

/** First text block of a rendered result, if any. */
function textBlock(result: ToolExecutionResult): string {
  const block = result.content.find((b) => b.type === 'text')
  return block?.type === 'text' ? block.text : ''
}

/** Find a ref on a snapshot tree line shaped like: - role "name" [ref=e12] */
function refInTree(tree: string, role: string, name: string): string | null {
  const prefix = '- ' + role + ' "' + name + '" ['
  for (const line of tree.split('\n')) {
    if (!line.trimStart().startsWith(prefix)) continue
    const refMatch = /ref=(e[0-9]+)/.exec(line)
    if (refMatch !== null) return refMatch[1] ?? null
  }
  return null
}

// ---------------------------------------------------------------------------
// Scenario: a scripted agent completes a search → product journey by tool
// ---------------------------------------------------------------------------

test('tool journey: the model drives search and cart by tree refs', async () => {
  const ctx = await assemble()

  // browser_navigate returns the canonical snapshot value plus its tree text.
  const nav = await call(ctx, 'browser_navigate', { url: store.base + '/?nopromo=1', waitFor: 'load' })
  assert.equal(nav.isError, false)
  const navValue = nav.value as { url: string; title: string; refs: number; truncated: boolean; tree: string }
  assert.equal(navValue.title, 'Acme Store')
  assert.ok(navValue.refs > 10)
  assert.equal(navValue.truncated, false)
  assert.equal(textBlock(nav), navValue.tree, 'the rendered content is exactly the tree')

  // The model picks refs from the rendered tree, not from the wire schema.
  const searchRef = refInTree(navValue.tree, 'searchbox', 'Search products')
  assert.ok(searchRef !== null, 'search box ref must be visible in the tree')

  const filled = await call(ctx, 'browser_fill', { ref: searchRef, text: 'coffee' })
  assert.equal(filled.isError, false)
  const pressed = await call(ctx, 'browser_press', { ref: searchRef, key: 'Enter' })
  assert.equal(pressed.isError, false)

  const results = await callUntil(
    ctx,
    'browser_snapshot',
    {},
    (value) => (value as { url: string }).url.includes('/search?q=coffee'),
    'search results via snapshot polling',
  )
  const resultsTree = treeOf(results)
  const productRef = refInTree(resultsTree, 'link', 'Ceramic Pour-Over Set')
  assert.ok(productRef !== null, 'product link ref must be visible in the tree')

  // The click navigates; the model then re-snapshots until the page settles.
  const clicked = await call(ctx, 'browser_click', { ref: productRef })
  assert.equal(clicked.isError, false)
  const onProduct = await callUntil(
    ctx,
    'browser_snapshot',
    {},
    (value) => (value as { url: string }).url.includes('/product/coffee-set'),
    'product page after click',
  )
  const productTree = treeOf(onProduct)
  const addRef = refInTree(productTree, 'button', 'Add to cart')
  assert.ok(addRef !== null, 'add-to-cart ref must be visible in the tree')

  await call(ctx, 'browser_click', { ref: addRef })
  await callUntil(
    ctx,
    'browser_snapshot',
    {},
    (value) => (value as { tree: string }).tree.includes('Cart (1)'),
    'cart badge update',
  )
})

// ---------------------------------------------------------------------------
// Scenario: browser sessions follow the calling agent's session id
// ---------------------------------------------------------------------------

test('tool ownership: each agent session gets its own browser session', async () => {
  const ctx = await assemble()

  await call(ctx, 'browser_navigate', { url: store.base + '/product/coffee-set' }, 'agent-a')
  await call(ctx, 'browser_navigate', { url: store.base + '/product/sapiens' }, 'agent-b')

  const a = await call(ctx, 'browser_snapshot', {}, 'agent-a')
  const b = await call(ctx, 'browser_snapshot', {}, 'agent-b')
  assert.equal((a.value as { url: string }).url.includes('/product/coffee-set'), true)
  assert.equal((b.value as { url: string }).url.includes('/product/sapiens'), true)

  // A's cart stays private even after B shops.
  const addRef = refInTree(treeOf(a), 'button', 'Add to cart')
  assert.ok(addRef !== null)
  await call(ctx, 'browser_click', { ref: addRef }, 'agent-a')
  await callUntil(
    ctx,
    'browser_snapshot',
    {},
    (value) => (value as { tree: string }).tree.includes('Cart (1)'),
    'A cart badge',
    'agent-a',
  )
  const bCart = await call(ctx, 'browser_navigate', { url: store.base + '/cart' }, 'agent-b')
  assert.equal(treeOf(bCart).includes('Your cart is empty.'), true)
})

// ---------------------------------------------------------------------------
// Scenario: screenshot attachments through the harness attachments service
// ---------------------------------------------------------------------------

test('screenshot tool: stores a durable attachment and returns its facts', async () => {
  const ctx = await assemble()
  const saved: { data: Uint8Array; mediaType: string; name: string }[] = []
  ctx.provide('attachments', {
    async saveImage(input: { data: Uint8Array; mediaType: string; name: string }) {
      saved.push(input)
      const view = new DataView(input.data.buffer, input.data.byteOffset, input.data.byteLength)
      const width = view.getUint32(16)
      const height = view.getUint32(20)
      return {
        attachmentId: 'att-shot-1',
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width,
        height,
        name: input.name,
      }
    },
  })

  await call(ctx, 'browser_navigate', { url: store.base + '/product/coffee-set' })
  const shot = await call(ctx, 'browser_screenshot', { fullPage: false })
  assert.equal(shot.isError, false)
  const value = shot.value as { attachmentId: string; bytes: number; width: number; height: number; url: string }
  assert.equal(value.attachmentId, 'att-shot-1')
  assert.ok(value.bytes > 200)
  assert.ok(value.width > 100)
  assert.ok(value.height > 100)
  assert.ok(value.url.includes('/product/coffee-set'))

  // The rendered result carries both the summary text and the image block.
  const imageBlock = shot.content.find((block) => block.type === 'image')
  assert.ok(imageBlock?.type === 'image', 'screenshot result must include an image block')
  assert.equal((imageBlock as { attachment: { attachmentId: string } }).attachment.attachmentId, 'att-shot-1')

  // The service received a real PNG.
  assert.equal(saved.length, 1)
  assert.equal(saved[0]?.mediaType, 'image/png')
  assert.equal(saved[0]?.data[0], 0x89)
  assert.equal(saved[0]?.data[1], 0x50)
})

// ---------------------------------------------------------------------------
// Scenario: browser_extract through a (fake) auxiliary LLM route
// ---------------------------------------------------------------------------

test('extract tool: page data flows through the llm service into parsed JSON', async () => {
  const ctx = await assemble({
    extract: { provider: 'fake-provider', model: 'fake-model', maxInputChars: 20000, maxOutputTokens: 2000 },
  })

  const payload = JSON.stringify([
    { name: 'Designing Data-Intensive Applications', price: 42 },
    { name: 'Sapiens', price: 18.75 },
    { name: 'The Pragmatic Programmer', price: 31.5 },
  ])
  let promptSeen = ''
  ctx.provide('llm', {
    async *stream(options: { messages: { content: { type: string; text?: string }[] }[] }) {
      promptSeen = options.messages
        .flatMap((m) => m.content)
        .map((c) => c.text ?? '')
        .join('\n')
      yield { type: 'block-start', index: 0, blockType: 'text' } satisfies StreamChunk
      yield { type: 'text-delta', index: 0, text: payload.slice(0, 40) } satisfies StreamChunk
      yield { type: 'text-delta', index: 0, text: payload.slice(40) } satisfies StreamChunk
      yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } } satisfies StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } } satisfies StreamChunk
    },
  })

  await call(ctx, 'browser_navigate', { url: store.base + '/search?q=book' })
  const extracted = await call(ctx, 'browser_extract', {
    instruction: 'all book titles and prices as {name, price} objects',
  })
  assert.equal(extracted.isError, false)
  const value = extracted.value as { name: string; price: number }[]
  assert.equal(value.length, 3)
  assert.equal(value[0]?.name, 'Designing Data-Intensive Applications')
  assert.equal(value[0]?.price, 42)

  // The auxiliary model saw the instruction and the live page data.
  assert.ok(promptSeen.includes('all book titles and prices'), 'prompt must carry the instruction')
  assert.ok(promptSeen.includes('Designing Data-Intensive Applications'), 'prompt must carry the page content')

  // Without an llm service the tool fails loudly.
  const bare = await assemble({
    extract: { provider: 'fake-provider', model: 'fake-model', maxInputChars: 20000, maxOutputTokens: 2000 },
  })
  const failed = await call(bare, 'browser_extract', { instruction: 'anything' })
  assert.equal(failed.isError, true)
  assert.ok(textBlock(failed).includes('needs the llm service'))
})

// ---------------------------------------------------------------------------
// Scenario: safety gates — evaluate and wait bounds
// ---------------------------------------------------------------------------

test('safety gates: evaluate is off by default, wait is bounded', async () => {
  // The disabled-error path is only reachable when a deployment asks for the
  // gated tools anyway; by default they are not registered at all.
  const ctx = await assemble({ registerDisabledTools: true })

  const blocked = await call(ctx, 'browser_evaluate', { expression: 'document.title' })
  assert.equal(blocked.isError, true)
  assert.ok(textBlock(blocked).includes('browser_evaluate is disabled'))

  const tooLong = await call(ctx, 'browser_wait', { ms: 999999 })
  assert.equal(tooLong.isError, true)
  assert.ok(textBlock(tooLong).includes('no larger than'))

  const ok = await call(ctx, 'browser_wait', { ms: 50 })
  assert.equal(ok.isError, false)
  assert.equal(ok.value, null)

  // A separate deployment enables evaluate; then it returns page JSON.
  const open = await assemble({ allowEvaluate: true })
  await call(open, 'browser_navigate', { url: store.base + '/product/coffee-set' })
  const evaluated = await call(open, 'browser_evaluate', { expression: 'document.querySelector(".price").textContent' })
  assert.equal(evaluated.isError, false)
  assert.equal(evaluated.value, '$34.99')
})

// ---------------------------------------------------------------------------
// Scenario: close ends the session; the next call opens a fresh browser
// ---------------------------------------------------------------------------

test('close tool: the next browser call starts a fresh session', async () => {
  const ctx = await assemble()
  await call(ctx, 'browser_navigate', { url: store.base + '/?nopromo=1' })
  const closed = await call(ctx, 'browser_close', {})
  assert.equal(closed.isError, false)
  assert.equal(closed.value, null)

  const fresh = await call(ctx, 'browser_snapshot', {})
  assert.equal(fresh.isError, false)
  assert.equal((fresh.value as { url: string }).url, 'about:blank')
})

// ---------------------------------------------------------------------------
// Scenario: URL policy surfaces through the tool error channel
// ---------------------------------------------------------------------------

test('policy surface: a disallowed URL is a structured tool failure', async () => {
  const ctx = await assemble()
  const denied = await call(ctx, 'browser_navigate', { url: 'file:///etc/passwd' })
  assert.equal(denied.isError, true)
  const message = textBlock(denied)
  assert.ok(
    message.includes('URL_NOT_ALLOWED') || message.includes('http(s)'),
    'policy failure must be model-visible: ' + message,
  )
})

// ---------------------------------------------------------------------------
// Scenario: refs go stale across re-renders; the model re-snapshots
// ---------------------------------------------------------------------------

test('stale ref surface: an outdated ref fails fast, then a fresh snapshot recovers', async () => {
  const ctx = await assemble()
  const nav = await call(ctx, 'browser_navigate', { url: store.base + '/?nopromo=1' })
  const keyboardRef = refInTree(treeOf(nav), 'link', 'Mechanical Keyboard')
  assert.ok(keyboardRef !== null)

  // Re-render the grid, killing the old DOM.
  const kitchenRef = refInTree(treeOf(nav), 'button', 'Kitchen')
  assert.ok(kitchenRef !== null)
  await call(ctx, 'browser_click', { ref: kitchenRef })
  await callUntil(
    ctx,
    'browser_snapshot',
    {},
    (value) => !(value as { tree: string }).tree.includes('Mechanical Keyboard'),
    'filtered grid',
  )

  // Per-snapshot ref nonces make the stale ref match nothing: the tool fails
  // fast with a REF_NOT_FOUND explanation instead of clicking the wrong
  // element, and the model can recover from the error text alone.
  const stale = await call(ctx, 'browser_click', { ref: keyboardRef })
  assert.equal(stale.isError, true)
  assert.ok(textBlock(stale).includes('no longer matches'), 'the failure must explain that refs went stale')

  // Recovery: fresh snapshot, fresh ref.
  const fresh = await call(ctx, 'browser_snapshot', {})
  const grinderRef = refInTree(treeOf(fresh), 'link', 'Burr Coffee Grinder')
  assert.ok(grinderRef !== null)
  await call(ctx, 'browser_click', { ref: grinderRef })
  await callUntil(
    ctx,
    'browser_snapshot',
    {},
    (value) => (value as { url: string }).url.includes('/product/grinder'),
    'grinder page',
  )
})

// ---------------------------------------------------------------------------
// Scenario: the extract input budget is a live cap, not a dead config knob
// ---------------------------------------------------------------------------

test('extract tool: maxInputChars bounds the page data handed to the auxiliary model', async () => {
  const ctx = await assemble({
    extract: { provider: 'fake-provider', model: 'fake-model', maxInputChars: 300, maxOutputTokens: 2000 },
  })

  let promptSeen = ''
  ctx.provide('llm', {
    async *stream(options: { messages: { content: { type: string; text?: string }[] }[] }) {
      promptSeen = options.messages
        .flatMap((m) => m.content)
        .map((c) => c.text ?? '')
        .join('\n')
      yield { type: 'block-start', index: 0, blockType: 'text' } satisfies StreamChunk
      yield { type: 'text-delta', index: 0, text: '[]' } satisfies StreamChunk
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '[]' } } satisfies StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } } satisfies StreamChunk
    },
  })

  const agentId = 'extract-budget-agent'
  await call(ctx, 'browser_navigate', { url: store.base + '/search?q=book' }, agentId)
  const extracted = await call(ctx, 'browser_extract', { instruction: 'all book titles' }, agentId)
  assert.equal(extracted.isError, false)

  // The configured cap must actually reach the auxiliary model's prompt: a page
  // that is larger than the cap arrives truncated with the cap named.
  assert.ok(
    promptSeen.includes('[page data truncated at 300 characters]'),
    'the configured maxInputChars must bound the prompt',
  )
  const marker = 'Page data (JSON):'
  const pageData = promptSeen.slice(promptSeen.indexOf(marker) + marker.length).trim()
  assert.ok(pageData.length < 400, 'page data must be bounded: got ' + String(pageData.length) + ' characters')
  assert.ok(promptSeen.includes('all book titles'), 'bounded input must still carry the instruction')
})

// ---------------------------------------------------------------------------
// Scenario: browser_cdp against the live session (bound CDPSession method)
// ---------------------------------------------------------------------------

test('cdp tool: an allowed method round-trips on the live page', async () => {
  const ctx = await assemble({ allowCdp: true })
  const agentId = 'cdp-agent'
  await call(ctx, 'browser_navigate', { url: store.base + '/dialog' }, agentId)

  // DOM.getDocument is the cheapest read-only call whose reply shape is stable.
  // It fails outright when CDPSession.send is called without its receiver.
  const doc = await call(ctx, 'browser_cdp', { method: 'DOM.getDocument', params: { depth: 1 } }, agentId)
  assert.equal(doc.isError, false, textBlock(doc))
  const root = (doc.value as { root?: { nodeName?: string } }).root
  assert.equal(root?.nodeName, '#document')
})

test('cdp tool: the allow-list rejects a method before the session is touched', async () => {
  const ctx = await assemble({ allowCdp: true })
  const denied = await call(ctx, 'browser_cdp', { method: 'Network.enable' }, 'cdp-deny-agent')
  assert.equal(denied.isError, true)
  assert.ok(textBlock(denied).includes('not in the allow-list'), textBlock(denied))
  assert.ok(textBlock(denied).includes('Network.enable'), textBlock(denied))
})

// ---------------------------------------------------------------------------
// Scenario: a native dialog is parked, blocks other tools, and never answers itself
// ---------------------------------------------------------------------------

test('native dialog: parked on the page, blocking other tools, answered only explicitly', async () => {
  const ctx = await assemble({})
  const agentId = 'dialog-agent'
  await call(ctx, 'browser_navigate', { url: store.base + '/dialog' }, agentId)
  const before = await call(ctx, 'browser_snapshot', {}, agentId)
  const ref = refInTree(treeOf(before), 'button', 'Delete record')
  assert.ok(ref !== null, 'the fixture button must be in the snapshot')

  // The click raises confirm(): the call returns the parked-dialog stand-in
  // instead of hanging, and nothing has been accepted or cancelled.
  const raised = await call(ctx, 'browser_click', { ref }, agentId)
  const raisedTree = treeOf(raised)
  assert.match(raisedTree, /\[dialog\] confirm "Delete this record\?"/)
  assert.match(raisedTree, /PENDING/)
  assert.match(raisedTree, /Nothing has been accepted or cancelled yet/)

  // While it is parked, every other tool refuses to act on the page.
  const blocked = await call(ctx, 'browser_tabs', {}, agentId)
  assert.equal(blocked.isError, true)
  assert.ok(textBlock(blocked).includes('is PENDING and the page is blocked'), textBlock(blocked))

  // Another owner cannot answer it: each owner has its own page here.
  const stranger = await call(ctx, 'browser_dialog', { accept: true }, 'dialog-stranger')
  assert.equal(stranger.isError, true)
  assert.ok(textBlock(stranger).includes('nothing to accept or dismiss'), textBlock(stranger))

  // Cancelling unblocks the page, and the page saw the cancel, not an accept.
  const cancelled = await call(ctx, 'browser_dialog', { accept: false }, agentId)
  assert.equal(cancelled.isError, false, textBlock(cancelled))
  const after = await call(ctx, 'browser_snapshot', {}, agentId)
  assert.match(treeOf(after), /kept/)
})

// ---------------------------------------------------------------------------
// Link and tab policy: EVERY path that could reach another host enforces
// allowedDomains. Two regressions this pins:
//   * browser_click_at resolved an element (or a point) and clicked it without
//     ever asking the policy, so a disallowed host was one click_at away while
//     browser_click refused it;
//   * a tab a page opened itself (window.open / target="_blank") bypassed the
//     policy entirely, so switch_tab could drive a host the agent may not visit.
// The fixture puts the links at fixed viewport positions so raw mode can be
// aimed at one without measuring first, and offers a window.open button.
// ---------------------------------------------------------------------------

/**
 * A provider whose allow-list admits the fixture's 127.0.0.1 host only.
 * Non-persistent: these tests want their own context, not the shared profile
 * window the other tool scenarios run on.
 */
function policyProvider(): PlaywrightProvider {
  return new PlaywrightProvider({
    ...pwConfig,
    launch: { ...pwConfig.launch, persistent: false },
    allowedDomains: ['127.0.0.1'],
  })
}

/** assemble() against a specific provider (the shared one has no allow-list). */
async function assembleWith(p: PlaywrightProvider, overrides: Partial<ToolConfig> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(BrowserRuntime)
  ctx.browser.registerProvider(p)
  browserTool.apply(ctx, { ...toolConfig, ...overrides })
  return ctx
}

/** Assert a click was refused by the policy and that the page did not move. */
async function assertRefused(result: ToolExecutionResult, label: string): Promise<void> {
  assert.equal(result.isError, true, label + ' must be refused, but it was delivered')
  const message = textBlock(result)
  // contract.ts keeps the stable code as an API for tests and tools, not as
  // model-facing text, so accept either the code or the rendered reason.
  assert.ok(
    message.includes('URL_NOT_ALLOWED') || message.includes('not in allowedDomains'),
    label + ' must fail on the URL policy: ' + message,
  )
  assert.ok(message.includes('localhost'), label + ' must name the refused host: ' + message)
}

test('click policy: ref, geometric-ref and raw clicks all refuse a disallowed host', async () => {
  const provider = policyProvider()
  try {
    const ctx = await assembleWith(provider)
    const agentId = 'policy-agent'
    const opened = await call(ctx, 'browser_navigate', { url: store.base + '/policy' }, agentId)
    assert.equal(opened.isError, false, textBlock(opened))
    const tree = treeOf(opened)
    const externalRef = refInTree(tree, 'link', 'External docs')
    assert.ok(externalRef, 'the external link must be in the snapshot: ' + tree)

    const viaClick = await call(ctx, 'browser_click', { ref: externalRef }, agentId)
    await assertRefused(viaClick, 'browser_click')

    const viaGeometricRef = await call(ctx, 'browser_click_at', { ref: externalRef }, agentId)
    await assertRefused(viaGeometricRef, 'browser_click_at (ref mode)')

    // #external occupies y=0..40 of the viewport, above everything else.
    const viaRaw = await call(ctx, 'browser_click_at', { x: 10, y: 20 }, agentId)
    await assertRefused(viaRaw, 'browser_click_at (raw mode)')

    // The page never left the allowed host.
    const after = await call(ctx, 'browser_snapshot', {}, agentId)
    assert.match(treeOf(after), /Link policy/)
  } finally {
    await provider.dispose()
  }
})

test('click policy: an in-page javascript: link is clickable and stays on the page', async () => {
  const provider = policyProvider()
  try {
    const ctx = await assembleWith(provider)
    const agentId = 'policy-js-agent'
    const opened = await call(ctx, 'browser_navigate', { url: store.base + '/policy' }, agentId)
    const jsRef = refInTree(treeOf(opened), 'link', 'In-page JS link')
    assert.ok(jsRef, 'the in-page link must be in the snapshot')

    // It runs the page's own code and navigates nowhere, so the host policy has
    // nothing to say about it — refusing it (as the old check did, because
    // `javascript:` is not http(s)) made ordinary JS links unclickable.
    const clicked = await call(ctx, 'browser_click', { ref: jsRef }, agentId)
    assert.equal(clicked.isError, false, textBlock(clicked))

    // The same link by raw coordinates (y=40..80).
    const rawClicked = await call(ctx, 'browser_click_at', { x: 10, y: 60 }, agentId)
    assert.equal(rawClicked.isError, false, textBlock(rawClicked))
  } finally {
    await provider.dispose()
  }
})

test('tab policy: switch_tab refuses a tab a page opened outside the allow-list', async () => {
  const provider = policyProvider()
  try {
    const ctx = await assembleWith(provider)
    const agentId = 'policy-tab-agent'
    const opened = await call(ctx, 'browser_navigate', { url: store.base + '/policy' }, agentId)
    assert.equal(opened.isError, false, textBlock(opened))

    // window.open is the one navigation the plugin never sees, so this is how a
    // tab outside the allow-list comes into existence in the first place.
    const openRef = refInTree(treeOf(opened), 'button', 'Open external tab')
    assert.ok(openRef, 'the popup button must be in the snapshot')
    const popup = await call(ctx, 'browser_click', { ref: openRef }, agentId)
    assert.equal(popup.isError, false, textBlock(popup))

    const listed = await callUntil(
      ctx,
      'browser_tabs',
      {},
      (value) => ((value as { tabs?: unknown[] }).tabs ?? []).length >= 2,
      'the page-opened tab is listed',
      agentId,
    )
    const tabs = (listed.value as { tabs: Array<{ index: number; url: string }> }).tabs
    const outside = tabs.find((tab) => tab.url.includes('localhost'))
    assert.ok(outside, 'the popup tab must be listed with its URL: ' + JSON.stringify(tabs))

    const denied = await call(ctx, 'browser_switch_tab', { index: outside.index }, agentId)
    assert.equal(denied.isError, true, 'switching to a disallowed tab must be refused')
    assert.ok(textBlock(denied).includes('not in allowedDomains'), textBlock(denied))

    // The refusal left the session on the tab it was already driving.
    const still = await call(ctx, 'browser_snapshot', {}, agentId)
    assert.match(treeOf(still), /Link policy/)

    // Control: the allowed tab is still reachable.
    const back = await call(ctx, 'browser_switch_tab', { index: 0 }, agentId)
    assert.equal(back.isError, false, textBlock(back))
  } finally {
    await provider.dispose()
  }
})
