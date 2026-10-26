/**
 * Goal-directed `browser_wait` (0.7.6).
 *
 * The tool used to accept only `ms`, which made every wait a guess: too short
 * and the next click lands on a half-rendered page, too long and every call
 * burns wall-clock. These tests pin the validation rules and the execution
 * paths without launching a browser, so a regression in the "too early / too
 * late" trade-off shows up here instead of in a flaky scenario run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWaitCondition, describeWait, waitForCondition } from '../src/wait-conditions.ts'
import type { PlaywrightSession } from '../src/session.ts'

test('a call with no condition is refused before anything runs', () => {
  assert.throws(() => normalizeWaitCondition({}, 60_000), /pass one of ms, selector, text or networkIdle/)
})

test('two conditions in one call are refused, naming both', () => {
  assert.throws(
    () => normalizeWaitCondition({ selector: '#a', text: 'done' }, 60_000),
    /only one condition per call \(received selector, text\)/,
  )
})

test('the legacy ms path keeps its exact bounds', () => {
  assert.deepEqual(normalizeWaitCondition({ ms: 250 }, 60_000), { kind: 'ms', ms: 250 })
  assert.throws(() => normalizeWaitCondition({ ms: 0 }, 60_000), /positive integer no larger than 60000/)
  assert.throws(() => normalizeWaitCondition({ ms: 60_001 }, 60_000), /positive integer no larger than 60000/)
  assert.throws(() => normalizeWaitCondition({ ms: 1.5 }, 60_000), /positive integer/)
})

test('goal waits default to 15s and are capped by the deployment', () => {
  assert.deepEqual(normalizeWaitCondition({ selector: ' #done ' }, 60_000), {
    kind: 'selector',
    selector: '#done',
    timeoutMs: 15_000,
  })
  assert.deepEqual(normalizeWaitCondition({ text: 'saved', timeoutMs: 120_000 }, 60_000), {
    kind: 'text',
    text: 'saved',
    timeoutMs: 60_000,
  })
  assert.deepEqual(normalizeWaitCondition({ networkIdle: true, timeoutMs: 5_000 }, 60_000), {
    kind: 'networkIdle',
    timeoutMs: 5_000,
  })
  assert.throws(() => normalizeWaitCondition({ selector: '   ' }, 60_000), /selector must not be empty/)
})

test('describeWait names the real condition, not a duration', () => {
  assert.match(
    describeWait({ kind: 'selector', selector: '#done', timeoutMs: 1 }),
    /selector "#done" to become visible/,
  )
  assert.match(describeWait({ kind: 'text', text: '已保存', timeoutMs: 1 }), /text "已保存" to become visible/)
  assert.match(describeWait({ kind: 'networkIdle', timeoutMs: 1 }), /network to go idle/)
})

/** Minimal stand-ins: the wait only needs run(), touch(), ensurePage() and the page ops. */
function fakeSession(page: Record<string, unknown>): PlaywrightSession {
  return {
    owner: 'test-owner',
    provider: { touch: () => {} },
    run: <T>(operation: () => Promise<T>): Promise<T> => operation(),
    ensurePage: async () => page,
  } as unknown as PlaywrightSession
}

test('a visible selector resolves the wait and reports what it waited for', async () => {
  const seen: unknown[] = []
  const page = {
    waitForSelector: async (selector: string, options: unknown) => {
      seen.push([selector, options])
    },
  }
  const outcome = await waitForCondition(fakeSession(page), { kind: 'selector', selector: '#done', timeoutMs: 1234 })
  assert.deepEqual(seen, [['#done', { state: 'visible', timeout: 1234 }]])
  assert.match(outcome.waitedFor, /#done/)
  assert.ok(outcome.elapsedMs >= 0)
})

test('text waits on the first visible match', async () => {
  let got: unknown[] = []
  const page = {
    getByText: (text: string) => ({
      first: () => ({
        waitFor: async (options: unknown) => {
          got = [text, options]
        },
      }),
    }),
  }
  const outcome = await waitForCondition(fakeSession(page), { kind: 'text', text: '已保存', timeoutMs: 500 })
  assert.deepEqual(got, ['已保存', { state: 'visible', timeout: 500 }])
  assert.match(outcome.waitedFor, /已保存/)
})

test('networkIdle waits for the load state, not for a duration', async () => {
  const seen: unknown[] = []
  const page = {
    waitForLoadState: async (state: string, options: unknown) => {
      seen.push([state, options])
    },
  }
  await waitForCondition(fakeSession(page), { kind: 'networkIdle', timeoutMs: 900 })
  assert.deepEqual(seen, [['networkidle', { timeout: 900 }]])
})

test('a timeout names the condition and points at a snapshot, not a retry', async () => {
  const page = {
    waitForSelector: async () => {
      throw new Error('Timeout 5000ms exceeded')
    },
  }
  await assert.rejects(
    waitForCondition(fakeSession(page), { kind: 'selector', selector: '#never', timeoutMs: 5000 }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'ACTION_TIMEOUT')
      assert.match((error as Error).message, /wait timed out after 5000ms waiting for selector "#never"/)
      assert.match((error as Error).message, /take a snapshot/)
      return true
    },
  )
})
