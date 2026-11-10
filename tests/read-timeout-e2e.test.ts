/**
 * issue #5：真的让一次「读页面内容」超时，走完**整条链路**再断言。
 *
 * 为什么单开一个文件：0.7.9 补的三条用例都是把假页面塞进 `discardStuckPage()`、
 * 或者拿正则去读源码文本。把 `capture()` 里那行 `await this.discardStuckPage(page)`
 * 删掉，那三条照样是绿的——它们验证的是「方法本身能关页」，不是「超时之后真的关页」。
 * 这里反过来：用真浏览器打开一页，让它的主线程真死循环，读内容真超时，然后断言
 *   1. 报错是 ACTION_TIMEOUT，且文案说的是真发生的事（页被关、未提交内容丢失）；
 *   2. 那张卡的页真的被关掉（`isClosed()`）；
 *   3. 下一次 acquire 拿到的是一张**活页**，不是又一张卡死的页。
 * 第 3 条正是 issue 原报告的「自愈是假的」——删掉那行关页代码，它必红。
 *
 * @module dsh-browser-playwright-codex/tests/read-timeout-e2e
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { Page } from 'playwright-core'
import { BrowserError } from '../src/errors.ts'
import { PlaywrightProvider } from '../src/provider.ts'
import type { PlaywrightConfig } from '../src/config.ts'
import { publishGates } from '../src/runtime-state.ts'

process.env.DSH_BROWSER_STATE_FILE = path.join(os.tmpdir(), 'dsh-browser-tests-state-read-timeout-e2e.json')
publishGates({ allowEvaluate: true, allowCdp: true, diagnostics: true })

function configFor(): PlaywrightConfig {
  return {
    launch: {
      channel: 'chrome',
      headless: true,
      persistent: true,
      profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-browser-e2e-stuck-')),
      viewport: { width: 1280, height: 800 },
      // 1 秒硬期限：这是配置允许的最小值，测试只要跑得够快就不用等 30 秒。
      navigationTimeoutMs: 1_000,
      ignoreHTTPSErrors: false,
    },
    idleTimeoutMs: 0,
    maxSessions: 4,
    snapshot: { engine: 'legacy', diff: false, maxNodes: 500, maxNameLength: 120, maxTextLength: 300 },
  }
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 等渲染进程真的被死循环占住。evaluate 一旦不返回就是卡住了——
 * 160 毫秒没答案就当它走了，比盲等固定时长稳。
 */
async function waitUntilWedged(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = page
      .evaluate(() => 1)
      .then(
        () => 'answered',
        () => 'answered',
      )
    const winner = await Promise.race([probe, sleep(160).then(() => 'wedged')])
    if (winner === 'wedged') return true
    await sleep(50)
  }
  return false
}

test(
  'issue5 end-to-end: a wedged read times out, the page is closed, the next call gets a live one',
  { timeout: 120_000 },
  async () => {
    const provider = new PlaywrightProvider(configFor())
    const owner = 'e2e-stuck-read'
    let stuck: Page | undefined
    try {
      const first = await provider.acquire(owner)
      stuck = await first.ensurePage()

      // 真的把主线程占住：evaluate / ariaSnapshot 都没有 timeout 参数，
      // 这就是 issue #5 里「读内容 8.5 秒不返回」的成因。循环有界，关页会带走 renderer。
      void stuck
        .evaluate(() => {
          const end = Date.now() + 20_000
          while (Date.now() < end) {
            /* occupy the main thread */
          }
        })
        .catch(() => {})
      assert.equal(await waitUntilWedged(stuck), true, 'the test page never wedged; the scenario was not reproduced')

      // --- 完整链路：超时 ---------------------------------------------------
      const started = Date.now()
      await assert.rejects(
        first.snapshot({}),
        (error: unknown) => {
          assert.ok(error instanceof BrowserError, 'a stuck read must surface as BrowserError, got: ' + String(error))
          assert.equal(error.code, 'ACTION_TIMEOUT')
          // 文案必须说真发生的事，而不是「下次会重开会话」这种和实际相反的承诺。
          assert.match(error.message, /has been closed/i, 'the message must say the page was closed')
          assert.match(error.message, /not submitted is lost/i, 'the message must warn that unsaved input is gone')
          assert.doesNotMatch(error.message, /reopens the session/i, 'the old "reopens the session" promise is back')
          return true
        },
        'reading a wedged page must not hang',
      )
      const spent = Date.now() - started
      assert.ok(
        spent < 6_000,
        'the timeout path took ' + String(spent) + 'ms (deadline + 2s close cap should fit in 6s)',
      )

      // --- 句柄作废 ---------------------------------------------------------
      assert.equal(provider.entries.has(owner), false, 'the owner handle must be dropped so the next call rebuilds it')

      // --- 那一页真的被关了 --------------------------------------------------
      assert.equal(stuck.isClosed(), true, 'the wedged page must actually be closed, not just forgotten')

      // --- 下一次调用拿到活页，能正常读（这就是「自愈」真的成立） --------------
      const second = await provider.acquire(owner)
      const revived = await second.ensurePage()
      assert.notEqual(revived, stuck, 'the next acquire handed back the very page that timed out (fake self-heal)')
      const readBack = Date.now()
      await second.snapshot({})
      const readSpent = Date.now() - readBack
      assert.ok(readSpent < 1_000, 'the revived page still took ' + String(readSpent) + 'ms to read: it is not live')
    } finally {
      if (stuck !== undefined) {
        await Promise.race([stuck.close({ runBeforeUnload: false }).catch(() => {}), sleep(2_000)])
      }
      const dir = provider.profileDir
      await Promise.race([provider.dispose(), sleep(15_000)])
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* a locked profile directory is not a test failure */
      }
    }
  },
)
