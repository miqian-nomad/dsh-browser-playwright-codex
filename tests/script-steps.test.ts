/**
 * Script step parsing: the rules that stop a half-formed script from reaching
 * the browser. A malformed step must fail here, with the step number, rather
 * than halfway through a run on a live page.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_SCRIPT_STEPS, ScriptStepError, describeStep, parseScriptSteps } from '../src/script-steps.ts'

test('合法脚本：常见动作都能通过，并归一化成固定形状', () => {
  const steps = parseScriptSteps(
    [
      { action: 'navigate', url: 'https://example.com' },
      { action: 'snapshot' },
      { action: 'click', text: '登录' },
      { action: 'fill', ref: 'e12', value: 'hi' },
      { action: 'wait', text: '订单' },
    ],
    MAX_SCRIPT_STEPS,
  )
  assert.equal(steps.length, 5)
  assert.deepEqual(steps[0], { action: 'navigate', url: 'https://example.com' })
  assert.deepEqual(steps[2], { action: 'click', target: { text: '登录' } })
  assert.deepEqual(steps[3], { action: 'fill', target: { ref: 'e12' }, value: 'hi' })
})

test('纯字符串 targets 当成可见文字', () => {
  const [step] = parseScriptSteps([{ action: 'click', target: '搜索' }], MAX_SCRIPT_STEPS)
  assert.deepEqual(step, { action: 'click', target: { text: '搜索' } })
})

test('不认识的 action 会指名报错，并列出支持的动作', () => {
  assert.throws(
    () => parseScriptSteps([{ action: 'submit' }], MAX_SCRIPT_STEPS),
    (error: unknown) =>
      error instanceof ScriptStepError &&
      error.step === 1 &&
      /unknown action "submit"/.test(error.message) &&
      /navigate, snapshot, click, fill, press, hover, scroll, back, forward, wait/.test(error.message),
  )
})

test('新增的动作：press / hover / scroll / back / forward 都能解析成固定形状', () => {
  const steps = parseScriptSteps(
    [
      { action: 'press', text: '搜索', key: 'Enter' },
      { action: 'hover', ref: 'e7' },
      { action: 'scroll', direction: 'down' },
      { action: 'scroll', direction: 'up', amount: 300, text: '列表' },
      { action: 'back' },
      { action: 'forward' },
    ],
    MAX_SCRIPT_STEPS,
  )
  assert.deepEqual(steps[0], { action: 'press', target: { text: '搜索' }, key: 'Enter' })
  assert.deepEqual(steps[1], { action: 'hover', target: { ref: 'e7' } })
  // 不给 amount 时用默认值，且不带 target（整页滚动）
  assert.deepEqual(steps[2], { action: 'scroll', direction: 'down', amount: 600 })
  assert.deepEqual(steps[3], { action: 'scroll', direction: 'up', amount: 300, target: { text: '列表' } })
  assert.deepEqual(steps[4], { action: 'back' })
  assert.deepEqual(steps[5], { action: 'forward' })
})

test('新动作的参数照样校验：key 必须有、direction 只能上下、amount 必须正数且不超上限', () => {
  assert.throws(() => parseScriptSteps([{ action: 'press', ref: 'e1' }], MAX_SCRIPT_STEPS), /press needs a key/)
  assert.throws(
    () => parseScriptSteps([{ action: 'press', ref: 'e1', key: '  ' }], MAX_SCRIPT_STEPS),
    /press needs a key/,
  )
  assert.throws(() => parseScriptSteps([{ action: 'scroll' }], MAX_SCRIPT_STEPS), /direction "up" or "down"/)
  assert.throws(
    () => parseScriptSteps([{ action: 'scroll', direction: 'left' }], MAX_SCRIPT_STEPS),
    /direction "up" or "down"/,
  )
  assert.throws(
    () => parseScriptSteps([{ action: 'scroll', direction: 'down', amount: 0 }], MAX_SCRIPT_STEPS),
    /positive number/,
  )
  assert.throws(
    () => parseScriptSteps([{ action: 'scroll', direction: 'down', amount: -5 }], MAX_SCRIPT_STEPS),
    /positive number/,
  )
  assert.throws(
    () => parseScriptSteps([{ action: 'scroll', direction: 'down', amount: 99999 }], MAX_SCRIPT_STEPS),
    /capped at 20000/,
  )
})

test('空脚本 / 非数组 / 超长脚本都被拒绝', () => {
  assert.throws(() => parseScriptSteps([], MAX_SCRIPT_STEPS), /steps is empty/)
  assert.throws(() => parseScriptSteps('nope', MAX_SCRIPT_STEPS), /steps must be an array/)
  const tooMany = Array.from({ length: MAX_SCRIPT_STEPS + 1 }, () => ({ action: 'snapshot' }))
  assert.throws(() => parseScriptSteps(tooMany, MAX_SCRIPT_STEPS), /the cap is 40/)
})

test('报错带上是第几步（1 起算）', () => {
  assert.throws(
    () => parseScriptSteps([{ action: 'snapshot' }, { action: 'click' }], MAX_SCRIPT_STEPS),
    (error: unknown) => error instanceof ScriptStepError && error.step === 2 && /^step 2:/.test(error.message),
  )
})

test('target 必须二选一：ref 或 text，不能都给也不能都空', () => {
  assert.throws(
    () => parseScriptSteps([{ action: 'click', target: {} }], MAX_SCRIPT_STEPS),
    /needs a ref or a text label/,
  )
  assert.throws(
    () => parseScriptSteps([{ action: 'click', target: { ref: 'e1', text: 'x' } }], MAX_SCRIPT_STEPS),
    /not both/,
  )
  assert.throws(() => parseScriptSteps([{ action: 'click', target: '   ' }], MAX_SCRIPT_STEPS), /empty label/)
})

test('fill 必须有 value（哪怕是空串）', () => {
  assert.throws(() => parseScriptSteps([{ action: 'fill', ref: 'e1' }], MAX_SCRIPT_STEPS), /fill needs a value/)
  const [ok] = parseScriptSteps([{ action: 'fill', ref: 'e1', value: '' }], MAX_SCRIPT_STEPS)
  assert.deepEqual(ok, { action: 'fill', target: { ref: 'e1' }, value: '' })
})

test('wait 只收一个条件，和 browser_wait 的规矩一致', () => {
  assert.throws(() => parseScriptSteps([{ action: 'wait' }], MAX_SCRIPT_STEPS), /exactly one of/)
  assert.throws(
    () => parseScriptSteps([{ action: 'wait', ms: 10, text: 'x' }], MAX_SCRIPT_STEPS),
    /exactly one condition, got 2/,
  )
  const [netIdle] = parseScriptSteps([{ action: 'wait', networkIdle: true }], MAX_SCRIPT_STEPS)
  assert.deepEqual(netIdle, { action: 'wait', networkIdle: true })
  // networkIdle: false does not count as a condition.
  assert.throws(() => parseScriptSteps([{ action: 'wait', networkIdle: false }], MAX_SCRIPT_STEPS), /exactly one of/)
})

test('navigate 的 waitFor 只认三个 load 状态', () => {
  assert.throws(
    () => parseScriptSteps([{ action: 'navigate', url: 'https://a.test', waitFor: 'idle' }], MAX_SCRIPT_STEPS),
    /waitFor must be/,
  )
})

test('describeStep 一行说清每步在做什么', () => {
  assert.equal(describeStep({ action: 'navigate', url: 'https://a.test' }), 'navigate https://a.test')
  assert.equal(describeStep({ action: 'click', target: { text: '登录' } }), 'click "登录"')
  assert.equal(describeStep({ action: 'click', target: { ref: 'e7' } }), 'click e7')
  assert.equal(describeStep({ action: 'wait', ms: 500 }), 'wait 500ms')
  assert.equal(describeStep({ action: 'wait', networkIdle: true }), 'wait for network idle')
  assert.equal(describeStep({ action: 'press', target: { text: '搜索' }, key: 'Enter' }), 'press Enter on "搜索"')
  assert.equal(describeStep({ action: 'hover', target: { ref: 'e3' } }), 'hover e3')
  assert.equal(describeStep({ action: 'scroll', direction: 'down', amount: 600 }), 'scroll down 600px')
  assert.equal(
    describeStep({ action: 'scroll', direction: 'up', amount: 300, target: { text: '列表' } }),
    'scroll up 300px in "列表"',
  )
  assert.equal(describeStep({ action: 'back' }), 'back')
  assert.equal(describeStep({ action: 'forward' }), 'forward')
})

test('wait 支持 urlContains，并和其它条件互斥', () => {
  const [ok] = parseScriptSteps([{ action: 'wait', urlContains: '/search?q=' }], MAX_SCRIPT_STEPS)
  assert.deepEqual(ok, { action: 'wait', urlContains: '/search?q=' })
  assert.throws(
    () => parseScriptSteps([{ action: 'wait', urlContains: '/a', text: 'x' }], MAX_SCRIPT_STEPS),
    /exactly one condition, got 2/,
  )
  assert.equal(describeStep({ action: 'wait', urlContains: '/search?q=' }), 'wait for url containing /search?q=')
})
