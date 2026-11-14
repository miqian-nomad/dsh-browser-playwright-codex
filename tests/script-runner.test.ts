/**
 * Script runner: a step list executes in order, stops at the first failure,
 * and reports where it stopped. These tests drive a fake session, so they pin
 * the dispatch and the failure reporting without a browser.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runScript } from '../src/script-runner.ts'
import { BrowserError } from '../src/errors.ts'
import type { BrowserSession, BrowserSnapshot, WaitCondition } from '../src/types.ts'

/** A snapshot with the given labelled, actionable nodes. */
function snap(entries: Array<{ name: string; ref: string; role?: string }>, url = 'https://a.test/'): BrowserSnapshot {
  return {
    url,
    title: 'Test page',
    nodes: entries.map((entry) => ({ role: entry.role ?? 'button', name: entry.name, ref: entry.ref, children: [] })),
    totalRefs: entries.length,
    truncated: false,
  }
}

interface Trace {
  readonly calls: string[]
}

/** Fake session: records every call, answers from a scripted table. */
function fakeSession(options: { pages?: BrowserSnapshot[]; failOn?: { method: string; error: Error } }): {
  session: BrowserSession
  trace: Trace
} {
  const calls: string[] = []
  let page =
    options.pages?.[0] ??
    snap([
      { name: '登录', ref: 'e1' },
      { name: '搜索', ref: 'e2' },
    ])
  let pageIndex = 0
  const maybeFail = (method: string): void => {
    if (options.failOn?.method === method) throw options.failOn.error
  }
  const session = {
    owner: 'test',
    async snapshot() {
      calls.push('snapshot')
      maybeFail('snapshot')
      return page
    },
    async navigate(url: string) {
      calls.push('navigate ' + url)
      maybeFail('navigate')
      pageIndex += 1
      page = options.pages?.[pageIndex] ?? page
      return page
    },
    async click(ref: string) {
      calls.push('click ' + ref)
      maybeFail('click')
      return page
    },
    async fill(ref: string, text: string) {
      calls.push('fill ' + ref + '=' + text)
      maybeFail('fill')
      return page
    },
    async press(ref: string, key: string) {
      calls.push('press ' + ref + ' ' + key)
      maybeFail('press')
      return page
    },
    async hover(ref: string) {
      calls.push('hover ' + ref)
      maybeFail('hover')
      return page
    },
    async scroll(direction: string, amount: number, ref?: string) {
      calls.push('scroll ' + direction + ' ' + String(amount) + (ref === undefined ? '' : ' ' + ref))
      maybeFail('scroll')
      return page
    },
    async back() {
      calls.push('back')
      maybeFail('back')
      return { ...page, url: 'https://a.test/back' }
    },
    async forward() {
      calls.push('forward')
      maybeFail('forward')
      return { ...page, url: 'https://a.test/forward' }
    },
    async wait(ms: number) {
      calls.push('wait ' + String(ms))
      maybeFail('wait')
    },
    async waitForCondition(condition: WaitCondition) {
      calls.push('waitFor ' + JSON.stringify(condition))
      return { kind: 'satisfied' } as never
    },
  } as unknown as BrowserSession
  return { session, trace: { calls } }
}

test('全跑完：每步都成功，结果不带失败字段', async () => {
  const { session, trace } = fakeSession({})
  const outcome = await runScript(session, [
    { action: 'navigate', url: 'https://a.test/' },
    { action: 'click', target: { text: '登录' } },
    { action: 'fill', target: { ref: 'e2' }, value: 'hi' },
    { action: 'wait', ms: 20 },
  ])
  assert.equal(outcome.ran, 4)
  assert.equal(outcome.total, 4)
  assert.equal(outcome.failedAt, undefined)
  assert.ok(outcome.outcomes.every((entry) => entry.ok))
  // 开场一次快照（给文字定位用），之后每步各自推进
  // 开场一次快照（给文字定位用）、每步各自推进，等完再拍一次（刷新 ref）
  // navigate 开头就不必先拍一次快照（那页马上要被换掉）；wait 之后补拍一次刷新 ref
  assert.deepEqual(trace.calls, ['navigate https://a.test/', 'click e1', 'fill e2=hi', 'wait 20', 'snapshot'])
})

test('文字定位：目标嵌在深层 children 里也能找到（真实站点就是这种结构）', async () => {
  const nested: BrowserSnapshot = {
    url: 'https://a.test/form',
    title: 'Form',
    nodes: [
      {
        role: 'paragraph',
        name: '',
        children: [
          {
            role: 'paragraph',
            name: '',
            children: [{ role: 'textbox', name: 'Customer name:', ref: 'e5', children: [] }],
          },
        ],
      } as never,
    ],
    totalRefs: 1,
    truncated: false,
  }
  const { session, trace } = fakeSession({ pages: [nested] })
  await runScript(session, [{ action: 'fill', target: { text: 'Customer name:' }, value: 'x' }])
  assert.ok(trace.calls.includes('fill e5=x'), '深层节点必须能被文字定位找到：' + trace.calls.join(' | '))
})

test('文字定位：按可见名精确命中，用的是最新快照里的 ref', async () => {
  const { session, trace } = fakeSession({})
  await runScript(session, [{ action: 'click', target: { text: '登录' } }])
  assert.ok(trace.calls.includes('click e1'))
})

test('文字定位：同名多个元素时拒绝猜，停在第一步并说清有几个', async () => {
  const { session } = fakeSession({
    pages: [
      snap([
        { name: '删除', ref: 'e1' },
        { name: '删除', ref: 'e2' },
      ]),
    ],
  })
  const outcome = await runScript(session, [{ action: 'click', target: { text: '删除' } }])
  assert.equal(outcome.failedAt, 1)
  assert.match(String(outcome.failure), /2 elements are labelled "删除"/)
  assert.match(String(outcome.failure), /use a ref instead/)
})

test('文字定位：找不到就停，不点第一个像的', async () => {
  const { session, trace } = fakeSession({ pages: [snap([{ name: '注册', ref: 'e1' }])] })
  const outcome = await runScript(session, [{ action: 'click', target: { text: '登录' } }])
  assert.equal(outcome.failedAt, 1)
  assert.match(String(outcome.failure), /nothing on the page is labelled "登录"/)
  assert.equal(
    trace.calls.some((call) => call.startsWith('click')),
    false,
  )
})

test('ref 直达：不经过文字匹配，也不额外拍快照', async () => {
  const { session, trace } = fakeSession({})
  await runScript(session, [{ action: 'click', target: { ref: 'e9' } }])
  assert.ok(trace.calls.includes('click e9'))
})

test('中途失败：停在那一步，带上索引、动作、错误码和最后的快照', async () => {
  const { session, trace } = fakeSession({
    failOn: { method: 'click', error: new BrowserError('REF_NOT_FOUND', 'ref e1 is gone') },
  })
  const outcome = await runScript(session, [
    { action: 'navigate', url: 'https://a.test/' },
    { action: 'click', target: { ref: 'e1' } },
    { action: 'fill', target: { ref: 'e2' }, value: 'never' },
  ])
  assert.equal(outcome.ran, 2)
  assert.equal(outcome.failedAt, 2)
  assert.equal(outcome.failedAction, 'click')
  assert.equal(outcome.failureCode, 'REF_NOT_FOUND')
  assert.match(String(outcome.failure), /ref e1 is gone/)
  assert.ok(outcome.snapshot !== undefined, '失败也要带回最后的页面状态，好让模型接手')
  // 第三步不该被执行
  assert.equal(
    trace.calls.some((call) => call.startsWith('fill')),
    false,
  )
  assert.equal(outcome.outcomes.at(-1)?.ok, false)
})

test('wait 走条件而不是睡死：text 交给 waitForCondition', async () => {
  const { session, trace } = fakeSession({})
  await runScript(session, [{ action: 'wait', text: '订单已提交' }])
  assert.ok(trace.calls.some((call) => call.startsWith('waitFor {"text":"订单已提交"}')))
  assert.equal(
    trace.calls.some((call) => call === 'wait 0'),
    false,
  )
})

test('取消信号：已经中断就不再往下跑', async () => {
  const { session, trace } = fakeSession({})
  const controller = new AbortController()
  controller.abort()
  const outcome = await runScript(session, [{ action: 'navigate', url: 'https://a.test/' }, { action: 'snapshot' }], {
    signal: controller.signal,
  })
  assert.equal(outcome.ran, 0)
  assert.equal(
    trace.calls.some((call) => call.startsWith('navigate')),
    false,
  )
})

test('urlContains：URL 变了才算等到了（点完没跳转就会被抓住）', async () => {
  // 前两次读还是旧地址（模拟点击后页面还没跳），第三次才变成结果页
  const urls = ['https://a.test/', 'https://a.test/', 'https://a.test/search?q=x']
  let reads = 0
  const slowSession = {
    owner: 'test',
    async snapshot() {
      const url = urls[Math.min(reads, urls.length - 1)] ?? 'https://a.test/'
      reads += 1
      return snap([{ name: '结果', ref: 'e7' }], url)
    },
    async wait() {},
  } as unknown as BrowserSession
  const outcome = await runScript(slowSession, [{ action: 'wait', urlContains: '/search?q=' }])
  assert.equal(outcome.failedAt, undefined)
  assert.equal(outcome.outcomes[0]?.ok, true)
  assert.ok(reads >= 3, '应当一直轮询到 URL 变过来')
})

test('urlContains：一直不跳转就超时报错，不能默默算成功', async () => {
  const { session } = fakeSession({ pages: [snap([], 'https://a.test/')] })
  const outcome = await runScript(session, [{ action: 'wait', urlContains: '/never-here' }])
  assert.equal(outcome.failedAt, 1)
  assert.equal(outcome.failureCode, 'ACTION_TIMEOUT')
  assert.match(String(outcome.failure), /URL never contained "\/never-here"/)
})

test('重渲染自愈：文字解析出的 ref 失效（REF_NOT_FOUND）就重拍快照再试一次', async () => {
  // 维基百科顶栏搜索框一获得焦点就被换成新节点：fill 返回的快照里的 ref，
  // 到下一步 press 时已经失效（云服务器 Linux 上第一次抓到，2026-11-14）。
  const calls: string[] = []
  const pages = [snap([{ name: 'Search Wikipedia', ref: 'e1' }]), snap([{ name: 'Search Wikipedia', ref: 'e2' }])]
  let reads = 0
  let presses = 0
  const session = {
    owner: 'test',
    async snapshot() {
      calls.push('snapshot')
      const page = pages[Math.min(reads, pages.length - 1)]
      reads += 1
      return page
    },
    async press(ref: string, key: string) {
      calls.push('press ' + ref + ' ' + key)
      presses += 1
      if (presses === 1) throw new BrowserError('REF_NOT_FOUND', 'ref ' + ref + ' no longer matches an element')
      return pages[1]
    },
  } as unknown as BrowserSession
  const outcome = await runScript(session, [{ action: 'press', target: { text: 'Search Wikipedia' }, key: 'Enter' }])
  assert.equal(outcome.failedAt, undefined, String(outcome.failure))
  assert.deepEqual(calls, ['snapshot', 'press e1 Enter', 'snapshot', 'press e2 Enter'])
  assert.equal(outcome.outcomes[0]?.note, 're-pointed after the page re-rendered')
})

test('重渲染自愈不碰显式 ref：给了 ref 就直说它失效，不替模型猜一个新元素', async () => {
  const { session, trace } = fakeSession({
    failOn: { method: 'click', error: new BrowserError('REF_NOT_FOUND', 'ref e5 no longer matches an element') },
  })
  const outcome = await runScript(session, [{ action: 'click', target: { ref: 'e5' } }])
  assert.equal(outcome.failedAt, 1)
  assert.deepEqual(trace.calls, ['snapshot', 'click e5'])
})

test('重渲染自愈只认 REF_NOT_FOUND：动作超时不重试（那一下点击可能已经生效）', async () => {
  const { session, trace } = fakeSession({
    failOn: { method: 'click', error: new BrowserError('ACTION_TIMEOUT', 'the click timed out') },
  })
  const outcome = await runScript(session, [{ action: 'click', target: { text: '登录' } }])
  assert.equal(outcome.failedAt, 1)
  assert.deepEqual(trace.calls, ['snapshot', 'click e1'])
})

test('新增动作落到 session 上：press / hover / scroll / back / forward', async () => {
  const { session, trace } = fakeSession({})
  const outcome = await runScript(session, [
    { action: 'press', target: { ref: 'e2' }, key: 'Enter' },
    { action: 'hover', target: { text: '搜索' } },
    { action: 'scroll', direction: 'down', amount: 400 },
    { action: 'scroll', direction: 'up', amount: 200, target: { ref: 'e1' } },
    { action: 'back' },
    { action: 'forward' },
  ])
  assert.equal(outcome.failedAt, undefined, String(outcome.failure))
  assert.deepEqual(trace.calls, [
    'snapshot',
    'press e2 Enter',
    'hover e2',
    'scroll down 400',
    'scroll up 200 e1',
    'back',
    'forward',
  ])
})

test('失败自愈：文字第一次没找到，重拍一次快照再找，找到就继续', async () => {
  const calls: string[] = []
  const pages = [snap([{ name: '首页', ref: 'e1' }]), snap([{ name: '登录', ref: 'e9' }])]
  let reads = 0
  const session = {
    owner: 'test',
    async snapshot() {
      calls.push('snapshot')
      const page = pages[Math.min(reads, pages.length - 1)]
      reads += 1
      return page
    },
    async click(ref: string) {
      calls.push('click ' + ref)
      return pages[1]
    },
  } as unknown as BrowserSession
  const outcome = await runScript(session, [{ action: 'click', target: { text: '登录' } }])
  assert.equal(outcome.failedAt, undefined, String(outcome.failure))
  // 第一次快照没找到 → 重拍一次 → 用新 ref 点
  assert.deepEqual(calls, ['snapshot', 'snapshot', 'click e9'])
})

test('失败自愈只重试一次：重拍后仍然找不到就失败，不会无限重试', async () => {
  const calls: string[] = []
  const session = {
    owner: 'test',
    async snapshot() {
      calls.push('snapshot')
      return snap([{ name: '首页', ref: 'e1' }])
    },
    async click(ref: string) {
      calls.push('click ' + ref)
      return snap([])
    },
  } as unknown as BrowserSession
  const outcome = await runScript(session, [{ action: 'click', target: { text: '登录' } }])
  assert.equal(outcome.failedAt, 1)
  assert.match(String(outcome.failure), /nothing on the page is labelled "登录"/)
  assert.equal(calls.filter((call) => call === 'snapshot').length, 2)
  assert.equal(
    calls.some((call) => call.startsWith('click')),
    false,
  )
})

test('失败自愈不碰 ref：给 ref 的步骤不重拍快照（ref 属于产出它的那份文档）', async () => {
  const { session, trace } = fakeSession({})
  const outcome = await runScript(session, [{ action: 'click', target: { ref: 'e5' } }])
  assert.equal(outcome.failedAt, undefined)
  assert.deepEqual(trace.calls, ['snapshot', 'click e5'])
})

test('失败自愈对 fill / press / hover 同样生效', async () => {
  const calls: string[] = []
  const pages = [snap([{ name: '别的', ref: 'e1' }]), snap([{ name: '账号', ref: 'e8' }])]
  let reads = 0
  const session = {
    owner: 'test',
    async snapshot() {
      calls.push('snapshot')
      const page = pages[Math.min(reads, pages.length - 1)]
      reads += 1
      return page
    },
    async fill(ref: string) {
      calls.push('fill ' + ref)
      return pages[1]
    },
    async press(ref: string, key: string) {
      calls.push('press ' + ref + ' ' + key)
      return pages[1]
    },
    async hover(ref: string) {
      calls.push('hover ' + ref)
      return pages[1]
    },
  } as unknown as BrowserSession
  const outcome = await runScript(session, [
    { action: 'fill', target: { text: '账号' }, value: 'u' },
    { action: 'press', target: { text: '账号' }, key: 'Tab' },
    { action: 'hover', target: { text: '账号' } },
  ])
  assert.equal(outcome.failedAt, undefined, String(outcome.failure))
  assert.ok(calls.includes('fill e8'))
  assert.ok(calls.includes('press e8 Tab'))
  assert.ok(calls.includes('hover e8'))
})
