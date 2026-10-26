/**
 * 同时唤醒不许开两个浏览器，会话上限在默认模式也要算数。
 *
 * 2026-10-26 实测的两个问题：
 *   1. 两个任务同时唤醒 → 两次 launch 抢同一个 profile：第二个死在 Chrome 的单例锁上，
 *      恢复流程把**正在运行**的浏览器锁文件删了（下一次启动就可能真开第二个），而调用方
 *      收到的错误是「你没装浏览器」。现在并发调用共享同一次启动。
 *   2. `maxSessions` 只在非持久化模式生效。默认是持久化模式（所有会话共用一个窗口），
 *      上限形同虚设。现在它按「句柄」生效：窗口不动，只回收最久没用的那个会话句柄。
 *
 * 这些用例真的会启动一个无头浏览器（每个约 1-2 秒），因为要验证的正是启动路径。
 * @module dsh-browser-playwright-codex/tests/concurrency
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { PlaywrightProvider } from '../src/provider.ts'
import type { PlaywrightConfig } from '../src/config.ts'
import { publishGates } from '../src/runtime-state.ts'

process.env.DSH_BROWSER_STATE_FILE = path.join(os.tmpdir(), 'dsh-browser-tests-state-concurrency.json')
publishGates({ allowEvaluate: true, allowCdp: true, diagnostics: true })

/** A throwaway profile directory per provider, so two runs cannot collide. */
function freshProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-browser-concurrency-'))
  return dir
}

function configFor(overrides: Partial<PlaywrightConfig> & { persistent?: boolean } = {}): PlaywrightConfig {
  const { persistent, ...rest } = overrides
  return {
    launch: {
      channel: 'chrome',
      headless: true,
      persistent: persistent ?? true,
      profileDir: freshProfile(),
      viewport: { width: 1280, height: 800 },
      navigationTimeoutMs: 15_000,
      ignoreHTTPSErrors: false,
    },
    idleTimeoutMs: 0,
    maxSessions: 8,
    snapshot: { engine: 'legacy', diff: false, maxNodes: 500, maxNameLength: 120, maxTextLength: 300 },
    ...rest,
  }
}

/** Dispose, then drop the profile directory (best-effort: Windows may hold handles). */
async function cleanup(provider: PlaywrightProvider) {
  const dir = provider.profileDir
  await provider.dispose()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* a locked profile directory is not a test failure */
  }
}

test('three sessions waking at once share ONE launch (persistent mode)', async () => {
  const provider = new PlaywrightProvider(configFor())
  try {
    const sessions = await Promise.all([
      provider.acquire('wake-a'),
      provider.acquire('wake-b'),
      provider.acquire('wake-c'),
    ])
    assert.equal(provider.entries.size, 3, 'each owner keeps its own handle')
    const contexts = new Set(sessions.map((session) => session.context))
    assert.equal(contexts.size, 1, 'all three must drive the same window, not three windows')
    assert.equal(provider.contextLaunch, undefined, 'the in-flight launch must be cleared once it settles')
  } finally {
    await cleanup(provider)
  }
})

test('two sessions waking at once share ONE browser (legacy mode)', async () => {
  const provider = new PlaywrightProvider(configFor({ persistent: false }))
  try {
    const [left, right] = await Promise.all([provider.acquire('wake-x'), provider.acquire('wake-y')])
    assert.ok(provider.browser !== undefined, 'one browser instance must exist')
    assert.equal(left.context.browser(), provider.browser, 'the first session must sit in that browser')
    assert.equal(right.context.browser(), provider.browser, 'the second session must sit in the same one')
    assert.equal(provider.browserLaunch, undefined, 'the in-flight launch must be cleared once it settles')
  } finally {
    await cleanup(provider)
  }
})

test('maxSessions caps owner handles in the default (persistent) mode, evicting the least recently used', async () => {
  const provider = new PlaywrightProvider(configFor({ maxSessions: 2 }))
  try {
    await provider.acquire('handle-a')
    await provider.acquire('handle-b')
    // Reuse b so the eviction order is not just insertion order.
    await provider.acquire('handle-b')
    await provider.acquire('handle-c')
    assert.deepEqual(
      [...provider.entries.keys()].sort(),
      ['handle-b', 'handle-c'],
      'the least recently used handle must be the one dropped',
    )
    const context = provider.context
    assert.ok(context !== undefined, 'dropping a handle must never close the shared window')
    const revived = await provider.acquire('handle-a')
    assert.equal(revived.context, context, 'a dropped owner gets a fresh handle on the same window')
  } finally {
    await cleanup(provider)
  }
})
