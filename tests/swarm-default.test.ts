/**
 * 进场特效的默认值方向（0.8.2）。
 *
 * 为什么单独一条：`config.ts` 的 schema 写着 `enabled` 默认 `false`，而 `swarm-intro.ts`
 * 的三个入口曾经写成 `config?.swarm?.enabled ?? true` —— 方向反了。结果是**配置整体缺失时
 * 会播**：schema 说关，代码说开。配置没给的部署（手写 patch、测试、旧部署）正好走这条路。
 *
 * 这条测试钉住"没表态就是不播"：`config` 整个为 `undefined`、`{}`、`{ swarm: {} }` 三种
 * 形状都必须返回 false。最后再用一条显式 `enabled: true` 做对照，证明 false 不是来自
 * 别的守卫（否则删掉实现照样绿，测试就没有牙齿）。
 * @module dsh-browser-playwright-codex/tests/swarm-default
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 账本与运行态都落到临时文件：真实用户的状态不能被读到，也不能被这条测试改写。
const dir = mkdtempSync(join(tmpdir(), 'dsh-swarm-default-'))
process.env.DSH_BROWSER_SWARM_FILE = join(dir, 'played.json')
process.env.DSH_BROWSER_STATE_FILE = join(dir, 'state.json')

const { willPlaySwarm } = await import('../src/swarm-intro.ts')
const runtimeState = await import('../src/runtime-state.ts')

const URL_UNDER_TEST = 'https://example.com/demo'

test('no config at all means no intro effect (schema default is false)', () => {
  // 用户没表态（getSwarm 为 undefined），配置也没给。
  assert.equal(runtimeState.getSwarm(), undefined, 'this test needs the unset state as its starting point')
  assert.equal(
    willPlaySwarm(URL_UNDER_TEST, undefined, false),
    false,
    'config === undefined must mean "do not play" — the schema default is enabled: false',
  )
  assert.equal(willPlaySwarm(URL_UNDER_TEST, {}, false), false, 'an empty config must mean "do not play"')
  assert.equal(
    willPlaySwarm(URL_UNDER_TEST, { swarm: {} }, false),
    false,
    'an empty swarm block must mean "do not play"',
  )
})

test('the same call plays when the config says enabled: true (teeth check)', () => {
  // 对照：同样的 URL、同样的 headless、同样的账本，只把 enabled 打开就必须播。
  // 没有这一条，上面那三条在"整段实现被删掉"的情况下也会绿。
  assert.equal(
    willPlaySwarm(URL_UNDER_TEST, { swarm: { enabled: true } }, false),
    true,
    'enabled: true must play, otherwise the assertion above proves nothing',
  )
})
