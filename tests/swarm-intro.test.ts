/**
 * 进场特效的门槛与账本（0.7.x）。
 *
 * 这些行为此前一条测试都没有：无头也真在播（把 scenarios 测试挡红过）、
 * 注入失败也占名额、keep-alive 下动作被覆盖层吃掉。它们都发生在"还没进
 * 浏览器动作"之前，所以可以用假 page 在毫秒级钉住，不需要真浏览器。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'

// 账本与运行态都必须落在临时文件里：真实用户的状态不能被测试读到或改写。
const dir = mkdtempSync(join(tmpdir(), 'dsh-swarm-test-'))
process.env.DSH_BROWSER_SWARM_FILE = join(dir, 'played.json')
process.env.DSH_BROWSER_STATE_FILE = join(dir, 'state.json')

const swarm = await import('../src/swarm-intro.ts')
const runtimeState = await import('../src/runtime-state.ts')

/** 一次 evaluate 调用的分类，方便断言"有没有真的去注入/去停"。 */
interface Recorded {
  readonly kind: string
  readonly arg?: unknown
}

/**
 * 假页面：按调用的形状回答，不执行任何真实脚本。
 * 形状判定的顺序很重要 —— 设置控制条那次调用既带对象参数、函数体里又出现
 * `__dshSwarmStop`，必须先按参数认出来。
 */
function fakePage() {
  const calls: Recorded[] = []
  const state = {
    poll: 'playing' as 'playing' | 'complete' | 'gone',
    hostGone: true,
    scrollY: 12,
    scrolled: [] as number[],
  }
  const page = {
    url: () => 'https://example.com/demo',
    isClosed: () => false,
    evaluate: async (target: unknown, arg?: unknown) => {
      if (typeof target === 'string') {
        calls.push({ kind: 'inject' })
        return undefined
      }
      if (arg !== undefined && arg !== null && typeof arg === 'object' && 'findRootSource' in arg) {
        calls.push({ kind: 'hud' })
        return true
      }
      const src = String(target)
      if (src.includes('backdropFilter')) {
        calls.push({ kind: 'veil' })
        return false
      }
      // 关闭指令要排在宿主轮询前面：stopSwarm 现在会顺手 `remove()` 掉
      // `swarm-rebuild` 宿主，函数体里也出现 "swarm-rebuild"，先判它会认错。
      if (src.includes('__dshSwarmStop')) {
        calls.push({ kind: 'stop' })
        return undefined
      }
      if (src.includes('swarm-rebuild')) {
        calls.push({ kind: 'host-poll' })
        return state.hostGone
      }
      if (src.includes('window.scrollY')) {
        calls.push({ kind: 'scroll-read' })
        return state.scrollY
      }
      if (src.includes('scrollTo')) {
        calls.push({ kind: 'scroll-write', arg })
        state.scrolled.push(Number(arg))
        return undefined
      }
      if (src.includes('__swarmRebuild')) {
        calls.push({ kind: 'poll' })
        return state.poll
      }
      calls.push({ kind: 'other' })
      return undefined
    },
  }
  return { page: page as unknown as Page, calls, state }
}

const count = (calls: Recorded[], kind: string): number => calls.filter((call) => call.kind === kind).length
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms))

/** 默认配置：开着、不限制站点记录，测试要看的不是"该不该播"的默认值。 */
const CONFIG = { swarm: { enabled: true, oncePerSite: false, speed: 3, maxMs: 15_000 } }

test('播放记录只落在临时文件里，记账/查询/清空互不干扰', () => {
  swarm.resetPlayed()
  const file = process.env.DSH_BROWSER_SWARM_FILE
  assert.ok(file !== undefined)
  assert.equal(swarm.hasPlayed('a.example'), false)

  swarm.markPlayed('a.example')
  swarm.markPlayed('b.example')
  assert.equal(swarm.hasPlayed('a.example'), true)
  assert.equal(swarm.hasPlayed('b.example'), true)
  assert.equal(swarm.hasPlayed('c.example'), false)

  const saved = JSON.parse(readFileSync(file, 'utf8')) as { hosts: Record<string, number> }
  assert.deepEqual(Object.keys(saved.hosts).sort(), ['a.example', 'b.example'])

  swarm.resetPlayed()
  assert.equal(swarm.hasPlayed('a.example'), false)
})

test('记过账的站点在 oncePerSite 下不再注入', async () => {
  swarm.resetPlayed()
  swarm.markPlayed('example.com')
  const { page, calls } = fakePage()
  swarm.maybePlaySwarm(page, { swarm: { ...CONFIG.swarm, oncePerSite: true } }, false)
  await settle()
  assert.equal(count(calls, 'inject'), 0, '已经播过的站点不该再注入一次')
})

test('无头模式一次都不注入', async () => {
  swarm.resetPlayed()
  const { page, calls } = fakePage()
  swarm.maybePlaySwarm(page, CONFIG, true)
  await settle()
  assert.deepEqual(calls, [], '无头下连遮罩检测都不该跑')
})

test('stopSwarm：auto-close 会去关，keep-alive 不碰它', async () => {
  // --- auto-close ---
  swarm.resetPlayed()
  runtimeState.setSwarmTuning({ whileAiWorks: 'auto-close' })
  const first = fakePage()
  swarm.maybePlaySwarm(first.page, CONFIG, false)
  await settle()
  assert.equal(count(first.calls, 'inject'), 1, 'auto-close 应该正常注入')
  const stopBefore = count(first.calls, 'stop')
  await swarm.stopSwarm(first.page)
  assert.equal(count(first.calls, 'stop'), stopBefore + 1, 'auto-close 下应发出关闭指令')
  first.state.poll = 'gone'
  await settle(400)

  // --- keep-alive ---
  swarm.resetPlayed()
  runtimeState.setSwarmTuning({ whileAiWorks: 'keep-alive' })
  const second = fakePage()
  swarm.maybePlaySwarm(second.page, CONFIG, false)
  await settle()
  assert.equal(count(second.calls, 'inject'), 1)
  const stopBefore2 = count(second.calls, 'stop')
  await swarm.stopSwarm(second.page)
  assert.equal(count(second.calls, 'stop'), stopBefore2, 'keep-alive 下不该去关它')
  second.state.poll = 'gone'
  await settle(400)
})

test('maxMs：0 表示完整播完，越界值被夹进 3000–30000', async () => {
  const realNow = Date.now
  // 假时钟：每次读 Date.now 前进 40 秒，用真实 350ms 的轮询间隔把"播多久"
  // 在毫秒内测出来。4 万 < 12 万（完整播完），但远大于 3 万（上限）。
  let clock = 0
  Date.now = () => (clock += 40_000)
  try {
    swarm.resetPlayed()
    const zero = fakePage()
    swarm.maybePlaySwarm(zero.page, { swarm: { ...CONFIG.swarm, maxMs: 0 } }, false)
    await settle(120)
    assert.ok(count(zero.calls, 'poll') >= 1, 'maxMs=0 应该还在播（上限 12 万），不该被夹成 3 秒')
    zero.state.poll = 'gone'
    await settle(400)

    swarm.resetPlayed()
    const over = fakePage()
    swarm.maybePlaySwarm(over.page, { swarm: { ...CONFIG.swarm, maxMs: 999_999 } }, false)
    await settle(120)
    assert.equal(count(over.calls, 'poll'), 0, 'maxMs 上限应是 3 万，假时钟一步 4 万就该直接结束')
    over.state.poll = 'gone'
    await settle(400)
  } finally {
    Date.now = realNow
  }
})
