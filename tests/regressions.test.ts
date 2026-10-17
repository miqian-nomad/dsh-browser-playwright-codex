/**
 * Regression tests for the four review findings fixed in this round. Each test is written so
 * that reverting its fix makes it fail:
 *
 * 1. `allowedDomains` was bypassable by a control nested inside an off-domain `<a>`: ref and
 *    text clicks only checked the clicked element's own href, so a button/span without one was
 *    allowed through and the click bubbled into the ancestor link (audit B2 / neutral #1).
 * 2. `pageData()` exported password field values and `browser_extract` pasted them into an
 *    auxiliary model's prompt (audit B3 / neutral #7).
 * 3. `browser_fill` wrote contenteditable text and then claimed `VALUE_NOT_SET`, because the
 *    readback used `inputValue()` — which does not exist on a div (neutral #2).
 * 4. The readback accepted same-length different values (`ABCD`→`ZZZZ`, `John`→`Jane`) as
 *    success (audit B4 / neutral #3).
 *
 * The contenteditable and locked-field cases are driven through the provider against a local
 * fixture server; the policy case runs with `allowedDomains: ['127.0.0.1']` and reaches the same
 * server through the `localhost` hostname, the same trick the store fixture uses.
 * @module dsh-browser-playwright-codex/tests/regressions
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Locator } from 'playwright-core'
import { PlaywrightProvider } from '../src/provider.ts'
import type { PlaywrightConfig } from '../src/config.ts'
import { BrowserError } from '../src/errors.ts'
import { verifyFill } from '../src/page-actions.ts'
import { extractionPrompt } from '../src/extract.ts'
import type { PlaywrightSession } from '../src/session.ts'
import type { BrowserNode } from '../src/types.ts'

// The suite expects the legacy tree and must not inherit the user's settings-page choice.
process.env.DSH_BROWSER_STATE_FILE = path.join(os.tmpdir(), 'dsh-browser-tests-state-isolated.json')

const config: PlaywrightConfig = {
  launch: {
    channel: 'chrome',
    headless: true,
    persistent: false,
    profileDir: path.join(os.tmpdir(), 'dsh-browser-regressions-profile'),
    viewport: { width: 1280, height: 800 },
    navigationTimeoutMs: 15_000,
    ignoreHTTPSErrors: false,
  },
  idleTimeoutMs: 0,
  maxSessions: 4,
  snapshot: { engine: 'legacy', maxNodes: 500, maxNameLength: 120, maxTextLength: 300, diff: false },
}

let server: Server
let base: string
let provider: PlaywrightProvider
let policyProvider: PlaywrightProvider

/** Minimal HTML document wrapper for the inline fixture pages. */
function shell(title: string, body: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>' +
    title +
    '</title></head><body>' +
    body +
    '</body></html>'
  )
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const host = String(req.headers.host ?? '127.0.0.1')
  // The same server under the "localhost" hostname: a different host for policy purposes,
  // exactly like the store fixture's external link.
  const externalBase = 'http://' + host.replace(/^127\.0\.0\.1/, 'localhost')
  const url = req.url ?? '/'
  const send = (body: string) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(body)
  }
  if (url === '/policy') {
    send(
      shell(
        'Ancestor link policy',
        '<main><h1>Link policy</h1>' +
          '<a href="' +
          externalBase +
          '/victim-ref"><button>GoRef</button></a> ' +
          '<a href="' +
          externalBase +
          '/victim-text"><span>GoText</span></a> ' +
          '<a href="/allowed"><button>GoAllowed</button></a> ' +
          '<a href="' +
          externalBase +
          '/direct">External docs</a>' +
          '</main>',
      ),
    )
    return
  }
  if (url === '/allowed') {
    send(shell('Allowed page', '<main><h1>Allowed page</h1></main>'))
    return
  }
  if (url === '/form') {
    send(
      shell(
        'Credential form',
        '<main><h1>Credential form</h1><form>' +
          '<label for="password">Password</label><input id="password" name="password" type="password" value="hunter2">' +
          '<label for="recovery">Recovery code</label>' +
          '<input id="recovery" name="recovery" type="text" autocomplete="current-password" value="session-secret">' +
          '<label for="newpass">New password</label>' +
          '<input id="newpass" name="newpass" type="text" autocomplete="new-password" value="new-secret">' +
          '<label for="q">Search</label><input id="q" name="q" value="coffee">' +
          '</form></main>',
      ),
    )
    return
  }
  if (url === '/editor') {
    send(
      shell(
        'Rich text editor',
        '<main><h1>Rich text editor</h1>' +
          '<div id="editor" role="textbox" aria-label="Editor" contenteditable="true"></div>' +
          '</main>',
      ),
    )
    return
  }
  if (url === '/locked') {
    send(
      shell(
        'Locked field',
        '<main><h1>Locked field</h1>' +
          '<label for="locked">Locked field</label><input id="locked" name="locked" value="ABCD">' +
          '<script>document.getElementById("locked").addEventListener("input", function () { this.value = "ABCD" })</script>' +
          '</main>',
      ),
    )
    return
  }
  // Anything else (the victim pages, if a bypass leaks a click through) is a plain page.
  send(shell('Fixture page', '<main><h1>Fixture page</h1></main>'))
}

before(async () => {
  server = createServer(handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  base = 'http://127.0.0.1:' + String(address.port)
  provider = new PlaywrightProvider(config)
  policyProvider = new PlaywrightProvider({ ...config, allowedDomains: ['127.0.0.1'] })
})

after(async () => {
  await Promise.all([provider.dispose(), policyProvider.dispose()])
  await new Promise<void>((resolve, reject) => server.close((err) => (err === undefined ? resolve() : reject(err))))
})

/** Depth-first search for the first node matching the predicate. */
function findNode(nodes: readonly BrowserNode[], match: (node: BrowserNode) => boolean): BrowserNode | undefined {
  for (const node of nodes) {
    if (match(node)) return node
    const found = findNode(node.children, match)
    if (found !== undefined) return found
  }
  return undefined
}

function findRef(nodes: readonly BrowserNode[], match: (node: BrowserNode) => boolean): string | undefined {
  return findNode(nodes, (node) => node.ref !== undefined && match(node))?.ref
}

function urlNotAllowed(error: unknown): boolean {
  return error instanceof BrowserError && error.code === 'URL_NOT_ALLOWED'
}

function valueNotSet(error: unknown): boolean {
  return error instanceof BrowserError && error.code === 'VALUE_NOT_SET'
}

// ---------------------------------------------------------------------------
// 1. allowedDomains must cover the ancestor link a click navigates through
// ---------------------------------------------------------------------------

test('policy: ref, precise-ref and text clicks refuse a control nested in an off-domain link', async () => {
  const s = await policyProvider.acquire('t-ancestor-link')
  try {
    const opened = await s.navigate(base + '/policy', 'load')
    assert.equal(opened.url, base + '/policy')

    const buttonRef = findRef(opened.nodes, (node) => node.role === 'button' && node.name === 'GoRef')
    assert.ok(buttonRef !== undefined, 'the nested button must have a ref: ' + JSON.stringify(opened.nodes))

    // The button itself has no href; the click bubbles into <a href="http://localhost/...">.
    await assert.rejects(s.click(buttonRef), urlNotAllowed, 'a ref click on the nested button must be refused')
    await assert.rejects(
      s.clickAtRef(buttonRef),
      urlNotAllowed,
      'a precise ref click on the nested button must be refused',
    )
    // The span case: text mode picks the deepest label match, which has no href either.
    await assert.rejects(
      s.clickText('GoText'),
      urlNotAllowed,
      'a text click on the span inside an off-domain link must be refused',
    )

    // A refused click delivers nothing: the session is still on the allowed page.
    const still = await s.snapshot()
    assert.equal(still.url, base + '/policy', 'a refused click must not navigate anywhere')

    // Control: the same nesting with an allowed href still works.
    const allowedRef = findRef(still.nodes, (node) => node.role === 'button' && node.name === 'GoAllowed')
    assert.ok(allowedRef !== undefined, 'the allowed nested button must have a ref')
    const after = await s.click(allowedRef)
    assert.ok(after.url.endsWith('/allowed'), 'an allowed nested control must still be clickable: ' + after.url)
  } finally {
    await s.close()
  }
})

// ---------------------------------------------------------------------------
// 2. pageData() must not export credential values (browser_extract prompt)
// ---------------------------------------------------------------------------

test('pageData: password and password-autocomplete values never reach the extract prompt', async () => {
  const s = await provider.acquire('t-pagedata-credentials')
  try {
    await s.navigate(base + '/form', 'load')
    const data = await s.pageData()
    const serialized = JSON.stringify(data)
    for (const secret of ['hunter2', 'session-secret', 'new-secret']) {
      assert.ok(!serialized.includes(secret), 'pageData leaked ' + JSON.stringify(secret) + ': ' + serialized)
    }

    const inputs = (data as { inputs: Array<{ name: string; type: string; value: string }> }).inputs
    // The fields themselves stay: knowing a password box exists is useful page structure.
    const password = inputs.find((input) => input.name === 'password')
    assert.ok(password !== undefined, 'the password field itself must stay in pageData')
    assert.equal(password.type, 'password')
    assert.equal(password.value, '')
    const autocompleteCurrent = inputs.find((input) => input.name === 'recovery')
    assert.ok(autocompleteCurrent !== undefined, 'the autocomplete=current-password field must stay')
    assert.equal(autocompleteCurrent.value, '')
    const autocompleteNew = inputs.find((input) => input.name === 'newpass')
    assert.ok(autocompleteNew !== undefined, 'the autocomplete=new-password field must stay')
    assert.equal(autocompleteNew.value, '')
    // Ordinary values are untouched.
    const search = inputs.find((input) => input.name === 'q')
    assert.ok(search !== undefined)
    assert.equal(search.value, 'coffee')

    const prompt = extractionPrompt('list the form fields', data, 50_000)
    for (const secret of ['hunter2', 'session-secret', 'new-secret']) {
      assert.ok(!prompt.includes(secret), 'the extract prompt leaked ' + JSON.stringify(secret))
    }
  } finally {
    await s.close()
  }
})

// ---------------------------------------------------------------------------
// 3. Contenteditable fill: verify the text that is actually there
// ---------------------------------------------------------------------------

test('fill: a contenteditable field that received the text reports success', async () => {
  const s = await provider.acquire('t-contenteditable-fill')
  try {
    const opened = await s.navigate(base + '/editor', 'load')
    const editorRef = findRef(opened.nodes, (node) => node.name === 'Editor')
    assert.ok(editorRef !== undefined, 'the contenteditable textbox must have a ref: ' + JSON.stringify(opened.nodes))

    // Used to throw VALUE_NOT_SET after the text had already been written.
    await s.fill(editorRef, 'world')
    assert.equal(await s.evaluate('document.getElementById("editor").textContent'), 'world')
  } finally {
    await s.close()
  }
})

// ---------------------------------------------------------------------------
// 4. Strict readback: same-length different values are not "written"
// ---------------------------------------------------------------------------

test('fill: a value the page reverts to a same-length different one is a failure', async () => {
  const s = await provider.acquire('t-fill-locked')
  try {
    const opened = await s.navigate(base + '/locked', 'load')
    const fieldRef = findRef(opened.nodes, (node) => node.name === 'Locked field')
    assert.ok(fieldRef !== undefined, 'the locked input must have a ref: ' + JSON.stringify(opened.nodes))

    // The page's input handler keeps forcing the old value back: ABCD stays ABCD while the
    // fill typed ZZZZ. Same length, different value — the old length tolerance called it a
    // success; it must be VALUE_NOT_SET.
    await assert.rejects(s.fill(fieldRef, 'ZZZZ'), valueNotSet, 'ABCD -> ZZZZ must not be reported as written')
  } finally {
    await s.close()
  }
})

test('verifyFill: strict equality after whitespace normalization, nothing else', async () => {
  const session = undefined as unknown as PlaywrightSession
  const input = (value: string) => ({ inputValue: async () => value }) as unknown as Locator

  // The four cases the audit measured as false positives.
  assert.equal(await verifyFill(session, input('ABCD'), 'input', 'ZZZZ'), false)
  assert.equal(await verifyFill(session, input('0000'), 'input', '1234'), false)
  assert.equal(await verifyFill(session, input('John'), 'input', 'Jane'), false)
  assert.equal(await verifyFill(session, input('1234'), 'input', '12345'), false)

  // Trim and consecutive whitespace are the only normalization allowed.
  assert.equal(await verifyFill(session, input('  hello   world '), 'input', 'hello world'), true)
  assert.equal(await verifyFill(session, input('a\u00a0\u00a0b'), 'input', 'a b'), true)

  // Non-input elements are read back from their text, not inputValue().
  const editable = {
    inputValue: async () => {
      throw new Error('not an input')
    },
    evaluate: async () => ['world', 'world'],
  } as unknown as Locator
  assert.equal(await verifyFill(session, editable, 'div', 'world'), true)
  assert.equal(await verifyFill(session, editable, 'div', 'elsewhere'), false)
})
