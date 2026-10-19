import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isCredentialField } from '../src/page-actions.ts'

test('password inputs are credential fields', () => {
  assert.equal(isCredentialField({ tag: 'input', type: 'password', autocomplete: '' }), true)
})

test('secret autocomplete tokens are credential fields, with or without a section prefix', () => {
  for (const autocomplete of [
    'current-password',
    'new-password',
    'one-time-code',
    'cc-number',
    'cc-csc',
    'cc-exp',
    'section-red shipping cc-number',
  ]) {
    assert.equal(isCredentialField({ tag: 'input', type: 'text', autocomplete }), true, autocomplete)
  }
})

test('ordinary fields are not credential fields', () => {
  for (const spec of [
    { tag: 'input', type: 'text', autocomplete: '' },
    { tag: 'input', type: 'email', autocomplete: 'email' },
    { tag: 'input', type: 'text', autocomplete: 'username' },
    { tag: 'textarea', type: '', autocomplete: '' },
    { tag: 'select', type: '', autocomplete: '' },
    { tag: 'div', type: '', autocomplete: 'one-time-code' },
  ]) {
    assert.equal(isCredentialField(spec), false, JSON.stringify(spec))
  }
})
