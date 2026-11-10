/**
 * 「读页面内容不挂死」的回归（GitHub issue #5）。
 *
 * 报告人遇到的是：打开一个永远不返回的页面后，工具调用 12 分钟不回来、按取消
 * 也没用。复核发现真正没兜底的是**打开之后读内容**：`page.evaluate` 和
 * `ariaSnapshot` 都没有 timeout 参数，页面脚本占住主线程时它们会一直挂着。
 *
 * 这里不启动真浏览器：用永不 settle 的 Promise 模拟被卡住的页内调用，验证
 * 硬期限、取消信号、软降级三条路径都在毫秒级返回。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withDeadline, isReadTimeout } from '../src/read-deadline.ts'
import { Config } from '../src/config.ts'

const never = <T>(): Promise<T> => new Promise<T>(() => {})

test('硬期限：读内容卡住时按时抛 ACTION_TIMEOUT，而不是永远挂着', async () => {
  const started = Date.now()
  await assert.rejects(withDeadline(never(), 120, 'reading the page content'), (error: unknown) => {
    assert.ok(isReadTimeout(error), '必须是 ACTION_TIMEOUT')
    const e = error as { code: string; message: string }
    assert.equal(e.code, 'ACTION_TIMEOUT')
    assert.match(e.message, /reading the page content/)
    assert.match(e.message, /120ms/)
    assert.match(e.message, /next browser call reopens/)
    return true
  })
  assert.ok(Date.now() - started < 1000, '应该在期限附近返回，实测 ' + String(Date.now() - started) + 'ms')
})

test('取消信号：到点之前按取消，原样抛 AbortError', async () => {
  const ac = new AbortController()
  const started = Date.now()
  const pending = withDeadline(never(), 5000, 'reading', ac.signal)
  setTimeout(() => ac.abort(), 60)
  await assert.rejects(pending, (error: unknown) => {
    assert.equal((error as Error).name, 'AbortError')
    assert.equal(isReadTimeout(error), false, '取消不是读超时')
    return true
  })
  assert.ok(Date.now() - started < 1000)
})

test('已经 abort 的信号立即拒绝', async () => {
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(withDeadline(never(), 5000, 'reading', ac.signal), (error: unknown) => {
    assert.equal((error as Error).name, 'AbortError')
    return true
  })
})

test('正常返回不受影响，且期限到之前就结束', async () => {
  const value = await withDeadline(Promise.resolve('ok'), 5000, 'reading')
  assert.equal(value, 'ok')
})

test('原调用的迟到拒绝不会变成未捕获异常', async () => {
  let rejectLater: ((e: Error) => void) | undefined
  const late = new Promise<never>((_resolve, reject) => {
    rejectLater = reject
  })
  await assert.rejects(withDeadline(late, 60, 'reading'), /ACTION_TIMEOUT/)
  // 超时之后原始 Promise 才拒绝：withDeadline 已经给它挂了 catch，宿主不会崩。
  rejectLater?.(new Error('late failure'))
  await new Promise((r) => setTimeout(r, 20))
})

test('软超时（等页面稳定）：返回 undefined 而不是抛错', async () => {
  const value = await withDeadline(never(), 80, 'waiting for the page to settle', undefined, 'resolve-undefined')
  assert.equal(value, undefined)
})

test('配置下限：navigationTimeoutMs=0 被拒，默认仍是 30000', () => {
  const schema = Config as unknown as (input: unknown) => { launch: { navigationTimeoutMs: number } }
  const good = schema({})
  assert.equal(good.launch.navigationTimeoutMs, 30000)
  // 0 在 Playwright 里等于「永远等」，正是 issue #5 的放大器；必须挡住。
  assert.throws(() => schema({ launch: { navigationTimeoutMs: 0 } }), />= 1000/)
  assert.throws(() => schema({ launch: { navigationTimeoutMs: 500 } }), />= 1000/)
  assert.equal(schema({ launch: { navigationTimeoutMs: 1000 } }).launch.navigationTimeoutMs, 1000)
})
