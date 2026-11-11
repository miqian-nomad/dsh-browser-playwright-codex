import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BEGIN, END, mergeBrowserBlock, parseBrowserBlock } from '../src/gates-patch.ts'

/** A block the way a user who cares about their setup leaves it. */
const USER_BLOCK = [
  BEGIN,
  'plugins:',
  '  - id: browser',
  '    config:',
  "      profileDir: 'D:/dsh-profile'  # saved logins live here",
  '      channel: chrome',
  '      maxWaitMs: 45000',
  '      snapshot:',
  '        engine: dom',
  '      tool:',
  '        allowEvaluate: false',
  '        allowCdp: false',
  '        diagnostics: false',
  END,
].join('\n')

test('flipping a switch keeps every setting the template does not know about', () => {
  // Regression, measured 2026-11-10: saving the settings card re-rendered the
  // whole block from a fixed template, which dropped `profileDir` — and with it
  // every saved login. Only the three gate lines may move.
  const merged = mergeBrowserBlock(USER_BLOCK, true, false, true)
  assert.match(merged, /profileDir: 'D:\/dsh-profile'/)
  assert.match(merged, /channel: chrome/)
  assert.match(merged, /maxWaitMs: 45000/)
  assert.match(merged, /engine: dom/)
  assert.match(merged, /# saved logins live here/)
  assert.deepEqual(parseBrowserBlock(merged), { allowEvaluate: true, allowCdp: false, diagnostics: true })
})

test('a gate flip rewrites exactly the three gate lines', () => {
  const before = USER_BLOCK.split('\n')
  const after = mergeBrowserBlock(USER_BLOCK, true, true, true).split('\n')
  assert.equal(after.length, before.length)
  const changed = before
    .map((line, index) => (line === after[index] ? undefined : index))
    .filter((i) => i !== undefined)
  assert.equal(changed.length, 3)
  for (const index of changed) assert.match(before[index] ?? '', /^ {8}(allowEvaluate|allowCdp|diagnostics):/)
})

test('a block missing the gates gains them next to the ones present, keeping custom keys', () => {
  const partial = [
    BEGIN,
    'plugins:',
    '  - id: browser',
    '    config:',
    "      profileDir: 'D:/p'",
    '      tool:',
    '        allowEvaluate: false',
    END,
  ].join('\n')
  const merged = mergeBrowserBlock(partial, false, true, true)
  assert.match(merged, /profileDir: 'D:\/p'/)
  assert.deepEqual(parseBrowserBlock(merged), { allowEvaluate: false, allowCdp: true, diagnostics: true })
})

test('an un-editable block falls back to the template rather than writing a broken one', () => {
  // Flow-style `tool: { ... }` defeats line editing; the fallback is the old
  // whole-template render, which at least makes the switch the user flipped work.
  const flow = [
    BEGIN,
    'plugins:',
    '  - id: browser',
    '    config:',
    '      profileDir: 1',
    '      tool: { allowEvaluate: false }',
    END,
  ].join('\n')
  const merged = mergeBrowserBlock(flow, true, true, true)
  assert.deepEqual(parseBrowserBlock(merged), { allowEvaluate: true, allowCdp: true, diagnostics: true })
  assert.doesNotMatch(merged, /allowEvaluate: false/)
})

test('no managed block yet appends one and is idempotent', () => {
  const first = mergeBrowserBlock('plugins: []\n', true, false, false)
  assert.deepEqual(parseBrowserBlock(first), { allowEvaluate: true, allowCdp: false, diagnostics: false })
  const second = mergeBrowserBlock(first, true, false, false)
  assert.equal((second.match(/dsh-browser: 浏览器插件配置/g) ?? []).length, 1)
})
