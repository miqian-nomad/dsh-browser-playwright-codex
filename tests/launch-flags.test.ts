/**
 * Launch flags: the two things that decide what Chrome draws across the top of
 * every window.
 *
 * `--no-sandbox` makes Chrome print a yellow "unsupported command-line flag"
 * bar on every tab; Playwright adds it unless `chromiumSandbox` is exactly
 * `true`. Dropping the flag is not enough on its own — Chrome then names the
 * next flag it dislikes — so `--test-type` has to be there too. These tests pin
 * both halves and the step-down that keeps a host which REFUSES the sandbox
 * from turning into "the browser will not start at all".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { HUMANIZED_LAUNCH } from '../src/config.ts'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('--test-type 在人性化启动参数里（这条管住 Chrome 顶部那条黄色警告条）', () => {
  assert.ok(HUMANIZED_LAUNCH.args.includes('--test-type'), 'without --test-type Chrome prints the bad-flags bar')
  assert.ok(HUMANIZED_LAUNCH.args.includes('--disable-blink-features=AutomationControlled'))
  assert.deepEqual(HUMANIZED_LAUNCH.ignoreDefaultArgs, ['--enable-automation'])
})

test('我们自己不加 --no-sandbox：它本身就足以让 Chrome 弹警告条', () => {
  assert.equal(HUMANIZED_LAUNCH.args.includes('--no-sandbox'), false)
})

test('每条启动路径都要求开沙箱（静态守卫）', () => {
  // 配置对不算数：某条启动调用忘了带 chromiumSandbox，那条路径的窗口就会
  // 重新长出黄色警告条。三条路径：持久化 context、executablePath、channel 轮询。
  const lifecycle = read('../src/browser-lifecycle.ts')
  const marker = 'chromium.launchPersistentContext('
  const persistentCalls: string[] = []
  for (let at = lifecycle.indexOf(marker); at !== -1; at = lifecycle.indexOf(marker, at + 1)) {
    const end = lifecycle.indexOf('})', at)
    persistentCalls.push(lifecycle.slice(at, end === -1 ? at + 300 : end + 2))
  }
  assert.ok(persistentCalls.length >= 1, 'expected the persistent launch call')
  assert.ok(
    lifecycle.includes('chromiumSandbox: true'),
    'no launch path asks for the renderer sandbox, so Chrome will get --no-sandbox again',
  )
  assert.ok(
    lifecycle.includes('chromiumSandbox: false'),
    'the sandbox step-down is missing: a host that refuses the sandbox would fail to launch at all',
  )
})

test('沙箱被宿主拒绝时退回一次，并把这件事记在 provider 上', () => {
  const lifecycle = read('../src/browser-lifecycle.ts')
  const provider = read('../src/provider.ts')
  // 兜底必须在：否则「宿主不认沙箱」= 「浏览器完全打不开」。
  assert.ok(/sandboxMayBeTheCause/.test(lifecycle), 'the sandbox-failure detector is missing')
  assert.ok(/provider\.sandboxFallback = true/.test(lifecycle), 'the fallback must record that it happened')
  assert.ok(/sandboxFallback/.test(provider), 'PlaywrightProvider must expose sandboxFallback')
})

test('错误分类不越界：找不到可执行文件这类错误不该触发沙箱重试', () => {
  const lifecycle = read('../src/browser-lifecycle.ts')
  const body = lifecycle.slice(
    lifecycle.indexOf('function sandboxMayBeTheCause'),
    lifecycle.indexOf('export async function ensureContext'),
  )
  assert.ok(body.length > 0, 'sandboxMayBeTheCause must exist before ensureContext')
  // 越界匹配会把一次配置错误拖成两次 30 秒超时。
  assert.equal(/does not exist|ENOENT/.test(body), false, 'the detector must not swallow missing-executable errors')
})
