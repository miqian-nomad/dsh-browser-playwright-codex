import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderSnapshot, renderSnapshotTree, renderSnapshotDiff, trimUrlForDisplay } from '../src/snapshot-render.ts'
import type { BrowserNode, BrowserSnapshot, SnapshotDiff } from '../src/types.ts'

test('renderSnapshotTree prints roles, names, flags, and refs', () => {
  const nodes: BrowserNode[] = [
    {
      role: 'navigation',
      name: 'Main',
      children: [
        { role: 'link', name: 'Home', ref: 'e1', href: '/', children: [] },
        { role: 'button', name: 'Go', ref: 'e2', disabled: true, children: [] },
      ],
    },
    { role: 'heading', name: 'Title', level: 1, children: [] },
    { role: 'checkbox', name: 'Agree', ref: 'e3', checked: true, children: [] },
  ]
  const text = renderSnapshotTree(nodes)
  assert.equal(
    text,
    [
      '- navigation "Main"',
      '  - link "Home" [ref=e1] -> /',
      '  - button "Go" [disabled, ref=e2]',
      '- heading "Title" [level=1]',
      '- checkbox "Agree" [checked, ref=e3]',
    ].join('\n'),
  )
})

test('renderSnapshot includes the header facts and an empty marker', () => {
  const snap: BrowserSnapshot = { url: 'https://x.test/', title: 'X', nodes: [], totalRefs: 0, truncated: false }
  assert.equal(renderSnapshot(snap), 'URL: https://x.test/\nTitle: X\nRefs: 0\n\n(no visible elements)')
})

test('renderSnapshot marks truncation', () => {
  const snap: BrowserSnapshot = { url: 'u', title: 't', nodes: [], totalRefs: 7, truncated: true }
  assert.match(renderSnapshot(snap), /Refs: 7 \(truncated\)/)
})

test('renderSnapshotDiff renders +, -, and ~ lines with parent chains', () => {
  const diff: SnapshotDiff = {
    added: [{ ref: 'e2', role: 'link', name: 'Docs', flags: ['href=/docs'], parentRef: 'e1' }],
    removed: ['e3'],
    changed: [{ ref: 'e4', role: 'checkbox', name: 'Agree', flagsDelta: ['checked'], parentRef: 'e1' }],
    same: 5,
    navigationReset: false,
  }
  const text = renderSnapshotDiff(diff)
  assert.equal(
    text,
    [
      '+ link "Docs" [href=/docs] ref=e2 parent=e1',
      '- e3',
      '~ checkbox "Agree" [delta: checked] ref=e4 parent=e1',
      'same: 5',
    ].join('\n'),
  )
})

test('renderSnapshotDiff marks a navigation reset', () => {
  const diff: SnapshotDiff = { added: [], removed: [], changed: [], same: 0, navigationReset: true }
  const text = renderSnapshotDiff(diff)
  assert.match(text, /navigation reset/)
  assert.match(text, /same: 0/)
})

test('anonymous generic wrappers collapse instead of nesting one level each', () => {
  // Real pages wrap every link in several nameless <div>s; rendering each one as
  // "- generic" both repeats the word and inflates the indentation.
  const wrapper = (child: BrowserNode): BrowserNode => ({ role: 'generic', name: '', children: [child] })
  const nodes: BrowserNode[] = [
    wrapper(wrapper(wrapper({ role: 'link', name: 'Home', ref: 'e1', href: '/', children: [] }))),
  ]
  assert.equal(renderSnapshotTree(nodes), '- link "Home" [ref=e1] -> /')
})

test('a named or ref-bearing generic keeps its own line and its depth', () => {
  const nodes: BrowserNode[] = [
    { role: 'generic', name: 'Panel', children: [{ role: 'button', name: 'Go', ref: 'e2', children: [] }] },
  ]
  assert.equal(renderSnapshotTree(nodes), ['- generic "Panel"', '  - button "Go" [ref=e2]'].join('\n'))
})

test('displayed hrefs drop tracking parameters but keep meaningful ones', () => {
  const nodes: BrowserNode[] = [
    {
      role: 'link',
      name: 'Search',
      ref: 'e1',
      href: '/s?wd=%E9%93%B6%E8%A1%8C&rsv_idx=2&rsv_pq=abc&utm_source=x&gclid=y',
      children: [],
    },
  ]
  assert.equal(renderSnapshotTree(nodes), '- link "Search" [ref=e1] -> /s?wd=%E9%93%B6%E8%A1%8C')
})

test('a very long href is clipped and marked', () => {
  const href = '/search?q=' + 'a'.repeat(400)
  const nodes: BrowserNode[] = [{ role: 'link', name: 'Long', ref: 'e1', href, children: [] }]
  const line = renderSnapshotTree(nodes)
  assert.ok(line.length < 200, 'clipped line should stay short: ' + String(line.length))
  assert.match(line, /…$/)
})

test('a redirect-wrapping href renders as a short marker, not the wrapped URL', () => {
  // Bing wraps every organic result in /ck/a?... with a long base64 destination
  const bing =
    'https://www.bing.com/ck/a?!&p=3f8a2c1d9e0b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1JmltdHM9MTc5NDM1NTIwMA&ptn=3&ver=2&hsh=4'
  assert.equal(trimUrlForDisplay(bing), '→ (redirect wrapper)')
})

test('google and facebook redirect wrappers are recognised too', () => {
  assert.equal(trimUrlForDisplay('https://www.google.com/url?q=https://example.com&sa=D'), '→ (redirect wrapper)')
  assert.equal(trimUrlForDisplay('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com'), '→ (redirect wrapper)')
})

test('a normal href is not treated as a redirect wrapper', () => {
  assert.equal(trimUrlForDisplay('https://playwright.nodejs.cn/docs/intro'), 'https://playwright.nodejs.cn/docs/intro')
  assert.equal(trimUrlForDisplay('/docs/intro'), '/docs/intro')
  // A legitimate path that merely contains "/r/?" is NOT a known redirect
  // endpoint — dropping the real address here would hide where the link goes.
  assert.equal(trimUrlForDisplay('https://example.com/r/?id=5'), 'https://example.com/r/?id=5')
})

test('a redirect wrapper saves the encoded-destination characters in the rendered tree', () => {
  const wrapped =
    'https://www.bing.com/ck/a?!&p=3f8a2c1d9e0b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1JmltdHM9MTc5NDM1NTIwMA&ptn=3&ver=2&hsh=4'
  const line = renderSnapshotTree([{ role: 'link', name: 'Docs', ref: 'e1', href: wrapped, children: [] }])
  // The encoded destination must not reach the model: the line stays short...
  assert.ok(line.length < 60, 'marker line stays short: ' + String(line.length))
  assert.match(line, /redirect wrapper/)
  // ...and the ref survives, so the click still has its handle.
  assert.match(line, /ref=e1/)
})

test('the same href second and later renders as a pointer, keeping every ref', () => {
  // Baidu shape: one result rendered as several refs sharing one redirect href.
  const sameHref = 'https://www.baidu.com/link?url=jB8avg-2O9tO273HFPmwUR7'
  const nodes: BrowserNode[] = [
    { role: 'link', name: 'Playwright 教程 | 菜鸟教程', ref: 'e1', href: sameHref, children: [] },
    { role: 'link', name: '', ref: 'e2', href: sameHref, children: [] },
    { role: 'link', name: '', ref: 'e3', href: sameHref, children: [] },
    { role: 'link', name: 'www.runoob.com/playwright', ref: 'e4', href: sameHref, children: [] },
  ]
  const text = renderSnapshotTree(nodes)
  // Every ref survives — dedup trims bytes, never click targets.
  for (const ref of ['e1', 'e2', 'e3', 'e4']) assert.match(text, new RegExp('ref=' + ref))
  // The URL is printed once at its first occurrence...
  assert.equal((text.match(/baidu\.com\/link/g) || []).length, 1)
  // ...and later occurrences point back at the first ref.
  assert.match(text, /same as e1/)
  assert.equal((text.match(/same as e1/g) || []).length, 3)
})

test('href dedup is scoped to one snapshot: a fresh tree re-prints the URL', () => {
  const href = 'https://www.baidu.com/link?url=jB8avg-2O9tO273HFPmwUR7'
  const first = renderSnapshotTree([{ role: 'link', name: 'A', ref: 'e1', href, children: [] }])
  const second = renderSnapshotTree([{ role: 'link', name: 'B', ref: 'e2', href, children: [] }])
  // A separate renderSnapshotTree call starts a fresh seen-set, so the URL is
  // printed again rather than pointing at a ref from a previous snapshot.
  assert.match(first, /baidu\.com\/link/)
  assert.match(second, /baidu\.com\/link/)
  assert.doesNotMatch(second, /same as/)
})
