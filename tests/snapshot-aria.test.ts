import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAriaSnapshot, parseAriaSnapshotWithStats, ariaTreeToBrowserNodes } from '../src/snapshot-aria.ts'
import type { BrowserNode } from '../src/types.ts'

/**
 * REAL output, not a hand-written dialect: this YAML was captured from
 * playwright-core 1.62 on a live page (`page.locator('body').ariaSnapshot({
 * mode: 'ai' })`) on 2026-09-30. The previous fixture was written in a dialect
 * the parser happened to accept (`- role "name" -> href`, no trailing ':'),
 * which is why the suite stayed green while the engine dropped every container
 * line — and every link — on real pages. Never edit this by hand: re-capture it.
 *
 * What the real format exercises that the old fixture did not:
 *   - container lines end in ':'   (`- generic [active] [ref=e1]:`)
 *   - hrefs ride a deeper child    (`- /url: /one`)
 *   - text content is `text: <v>`  (`- text: Name`)
 *   - non-actionable roles carry refs too (`navigation`, `list`, `listitem`)
 */
const REAL_YAML = [
  '- generic [active] [ref=e1]:',
  '  - heading "Probe page" [level=1] [ref=e2]',
  '  - navigation [ref=e3]:',
  '    - list [ref=e4]:',
  '      - listitem [ref=e5]:',
  '        - link "One" [ref=e6] [cursor=pointer]:',
  '          - /url: /one',
  '      - listitem [ref=e7]:',
  '        - link "Two" [ref=e8] [cursor=pointer]:',
  '          - /url: /two',
  '  - generic [ref=e9]:',
  '    - generic [ref=e10]:',
  '      - text: Name',
  '      - textbox "Full name" [ref=e11]',
  '    - checkbox "Agree" [checked] [ref=e12]',
  '    - combobox "Pick" [ref=e13]:',
  '      - option "Alpha" [selected]',
  '      - option "Beta"',
  '    - button "Send" [ref=e14]',
  '  - dialog "Dlg" [ref=e15]:',
  '    - button "Inside dialog" [ref=e16]',
].join('\n')

const OPTS = { maxNodes: 500, maxNameLength: 120, maxTextLength: 300 }

test('parseAriaSnapshot reads the real Playwright format: nesting, hrefs, text, flags', () => {
  const roots = parseAriaSnapshot(REAL_YAML)
  assert.equal(roots.length, 1)
  const root = roots[0]
  assert.equal(root.role, 'generic')
  assert.equal(root.ariaRef, 'e1')
  // Structure survives: generic -> navigation -> list -> listitem -> link.
  const nav = root.children[1]
  assert.equal(nav.role, 'navigation')
  const list = nav.children[0]
  assert.equal(list.role, 'list')
  const firstItem = list.children[0]
  assert.equal(firstItem.role, 'listitem')
  const one = firstItem.children[0]
  assert.equal(one.role, 'link')
  assert.equal(one.name, 'One')
  assert.equal(one.href, '/one') // from the '- /url: /one' child line
  assert.equal(one.ariaRef, 'e6')
  // A trailing ':' means "has children", not part of the role or name.
  assert.notEqual(one.role, 'link:')
  // Non-actionable nodes keep their refs too (the tree is the whole a11y tree).
  assert.equal(nav.ariaRef, 'e3')
  // Flags: heading level, checkbox checked, option selected.
  assert.equal(root.children[0].level, 1)
  const checkbox = root.children[2].children[1]
  assert.equal(checkbox.role, 'checkbox')
  assert.equal(checkbox.checked, true)
  assert.equal(root.children[2].children[2].children[0].selected, true)
})

test('parseAriaSnapshot reads text-content lines as text nodes', () => {
  const roots = parseAriaSnapshot(REAL_YAML)
  const textNode = roots[0].children[2].children[0].children[0]
  assert.equal(textNode.role, 'text')
  assert.equal(textNode.name, 'Name')
})

test('parseAriaSnapshot reports lines it cannot read (format-drift guard)', () => {
  const stats = parseAriaSnapshotWithStats(REAL_YAML)
  assert.deepEqual(stats.unparsed, [])
  // A future Playwright format change must surface, not be silently dropped.
  const drifted = parseAriaSnapshotWithStats('- button "Go" [ref=e1]\n  ???? unknown\n')
  assert.equal(drifted.unparsed.length, 1)
  assert.match(drifted.unparsed[0] ?? '', /\?\?\?\?/)
})

test('parseAriaSnapshot ignores comments and blank lines', () => {
  const roots = parseAriaSnapshot('# comment\n\n- button "Go" [ref=e1]\n')
  assert.equal(roots.length, 1)
  assert.equal(roots[0].role, 'button')
  assert.equal(roots[0].name, 'Go')
})

test('parseAriaSnapshot does not expose javascript: hrefs', () => {
  const roots = parseAriaSnapshot('- link "JS" [ref=e1]:\n  - /url: javascript:alert(1)\n')
  assert.equal(roots[0].role, 'link')
  assert.equal(roots[0].href, undefined)
})

test('ariaTreeToBrowserNodes aligns DOM refs onto actionable nodes in document order', () => {
  // The DOM-side walker mints refs for actionable elements only, in document
  // order: link, link, textbox, checkbox, combobox, option, option, button,
  // button. The tree side must consume them in the same depth-first order.
  const refs = Array.from({ length: 9 }, (_, i) => 'e71207380' + String(41 + i))
  const { nodes, totalRefs, truncated } = ariaTreeToBrowserNodes(parseAriaSnapshot(REAL_YAML), OPTS, refs)
  assert.equal(truncated, false)
  assert.equal(totalRefs, 9)
  const linked: string[] = []
  const walk = (list: readonly BrowserNode[]) => {
    for (const node of list) {
      if (node.ref !== undefined) linked.push(node.role)
      walk(node.children)
    }
  }
  walk(nodes)
  assert.deepEqual(linked, ['link', 'link', 'textbox', 'checkbox', 'combobox', 'option', 'option', 'button', 'button'])
  // Non-actionable nodes stay in the tree without consuming a ref.
  const nav = nodes[0].children[1]
  assert.equal(nav.role, 'navigation')
  assert.equal(nav.ref, undefined)
})

test('ariaTreeToBrowserNodes honors maxNodes truncation', () => {
  const refs = ['e1', 'e2', 'e3']
  const { truncated } = ariaTreeToBrowserNodes(parseAriaSnapshot(REAL_YAML), { ...OPTS, maxNodes: 2 }, refs)
  assert.equal(truncated, true)
})

test('ariaTreeToBrowserNodes with interactiveOnly keeps only actionable refs', () => {
  const refs = ['e1', 'e2']
  const { nodes } = ariaTreeToBrowserNodes(parseAriaSnapshot(REAL_YAML), { ...OPTS, interactiveOnly: true }, refs)
  const roles: string[] = []
  const walk = (list: readonly BrowserNode[]) => {
    for (const node of list) {
      roles.push(node.role)
      walk(node.children)
    }
  }
  walk(nodes)
  assert.ok(roles.includes('button'))
  assert.ok(!roles.includes('heading'))
})
