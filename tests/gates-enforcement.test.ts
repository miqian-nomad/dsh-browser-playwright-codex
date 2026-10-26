/**
 * 门禁必须在代码层也成立。
 *
 * 2026-10-26 实测的漏洞：`allowEvaluate` / `allowCdp` 只在 `tool.ts` 里挡，绕过工具层
 * 直接拿 session 就能跑任意页面 JS，甚至能发白名单外的 CDP 命令（`Runtime.evaluate`）。
 * 现在 session 自己也判：**没发布过的门禁算关闭**（部署没说「可以」，就是「不可以」），
 * CDP 还要再过一道白名单。
 *
 * 这些用例不需要真浏览器：两道检查都排在 `session.run(...)` 之前，拒绝发生在碰页面之前。
 * @module dsh-browser-playwright-codex/tests/gates-enforcement
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import type { BrowserContext } from 'playwright-core'
import { PlaywrightProvider } from '../src/provider.ts'
import { PlaywrightSession } from '../src/session.ts'
import { getGates, publishGates } from '../src/runtime-state.ts'
import type { PlaywrightConfig } from '../src/config.ts'

// 隔离设置页的真实用户状态；本文件不发布门禁，就是要看默认拒绝。
process.env.DSH_BROWSER_STATE_FILE = path.join(os.tmpdir(), 'dsh-browser-tests-state-gates.json')

const config: PlaywrightConfig = {
  launch: {
    channel: 'chrome',
    headless: true,
    persistent: false,
    profileDir: path.join(os.tmpdir(), 'dsh-browser-gates-profile'),
    viewport: { width: 1280, height: 800 },
    navigationTimeoutMs: 15_000,
    ignoreHTTPSErrors: false,
  },
  idleTimeoutMs: 0,
  maxSessions: 4,
  snapshot: { engine: 'legacy', diff: false, maxNodes: 500, maxNameLength: 120, maxTextLength: 300 },
}

/** A session with no browser behind it: both denials land before any page access. */
const bareSession = () => new PlaywrightSession(new PlaywrightProvider(config), 'gate-probe', {} as BrowserContext)

/** assert.rejects matcher on the stable machine code (that is what tool callers branch on). */
const hasCode = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code, 'expected code ' + code + ', got: ' + String(error))
  return true
}

test('no published gates: a session refuses evaluate (the switch is not a tool-layer courtesy)', async () => {
  await assert.rejects(
    bareSession().evaluate('document.title'),
    hasCode('EVALUATE_DISABLED'),
    'session.evaluate must refuse while no deployment has said yes',
  )
})

test('no published gates: a session refuses cdp even for a method the allow-list likes', async () => {
  await assert.rejects(
    bareSession().cdp('DOM.getDocument', { depth: 1 }),
    hasCode('CDP_DISABLED'),
    'session.cdp must refuse before it looks at the method name',
  )
})

test('switch on: the CDP allow-list is enforced by the session, not just by the tool', async () => {
  publishGates({ allowEvaluate: false, allowCdp: true, diagnostics: false })
  // The exact hole: Runtime.evaluate is arbitrary page JavaScript with the
  // user's logins. It is not in the allow-list, so the session must refuse it
  // even though the CDP capability itself is on.
  await assert.rejects(
    bareSession().cdp('Runtime.evaluate', { expression: 'document.cookie', returnByValue: true }),
    hasCode('CDP_DENIED'),
    'Runtime.evaluate must be refused at the session layer',
  )
  await assert.rejects(
    bareSession().cdp('Network.getAllCookies', {}),
    hasCode('CDP_DENIED'),
    'a network/storage command must stay refused at the session layer',
  )
})

test('switch off: turning evaluate on or off stays authoritative for the session', async () => {
  publishGates({ allowEvaluate: false, allowCdp: true, diagnostics: false })
  await assert.rejects(bareSession().evaluate('1 + 1'), hasCode('EVALUATE_DISABLED'))
})

test('the published gates are what the settings card shows, so they must not fall back to registration', () => {
  publishGates({ allowEvaluate: true, allowCdp: false, diagnostics: true })
  assert.deepEqual(getGates(), { allowEvaluate: true, allowCdp: false, diagnostics: true })
})
