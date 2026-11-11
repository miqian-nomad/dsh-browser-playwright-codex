/**
 * Tests for normalizeEvaluateResult: browser_evaluate's return values must
 * survive the harness's lossless-JSON output boundary. Arrays, undefined and
 * functions are wrapped into a JSON string with a marker note; objects,
 * strings, numbers, booleans and null pass through untouched.
 * @module dsh-browser-playwright-codex/tests/normalize-evaluate
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEvaluateResult } from '../src/errors.ts'

test('a top-level array is converted to a JSON string with a note', () => {
  const out = normalizeEvaluateResult([1, 2, 3]) as { note: string; value: string }
  assert.equal(typeof out.value, 'string')
  assert.equal(out.value, '[1,2,3]')
  assert.match(out.note, /array/i)
  assert.match(out.note, /converted/i)
})

test('a top-level array of objects is stringified, not passed through', () => {
  const out = normalizeEvaluateResult([{ a: 1 }, { b: 2 }]) as { note: string; value: string }
  assert.equal(typeof out.value, 'string')
  assert.equal(JSON.parse(out.value).length, 2)
  assert.match(out.note, /converted/i)
})

test('an object is returned as-is, not stringified', () => {
  const value = { reward: 1, done: true }
  const out = normalizeEvaluateResult(value)
  assert.equal(out, value)
  assert.equal((out as typeof value).reward, 1)
})

test('a string is returned as-is', () => {
  assert.equal(normalizeEvaluateResult('hello'), 'hello')
})

test('a number is returned as-is', () => {
  assert.equal(normalizeEvaluateResult(42), 42)
})

test('a boolean is returned as-is', () => {
  assert.equal(normalizeEvaluateResult(false), false)
})

test('null is returned as-is (it is valid lossless JSON)', () => {
  assert.equal(normalizeEvaluateResult(null), null)
})

test('undefined does not throw and is reported, not passed through', () => {
  const out = normalizeEvaluateResult(undefined) as { note: string }
  assert.equal(typeof out.note, 'string')
  assert.match(out.note, /undefined/i)
  assert.equal((out as unknown as { value?: unknown }).value, undefined)
})
