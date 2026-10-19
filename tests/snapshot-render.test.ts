import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderSnapshot, renderSnapshotTree, renderSnapshotDiff } from '../src/snapshot-render.ts'
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
