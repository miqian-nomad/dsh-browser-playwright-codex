import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Locator } from 'playwright-core'
import { isCredentialField, readFieldSpec } from '../src/page-actions.ts'

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

test('a secret token is found wherever it sits in the token list, not only last', () => {
  // Regression: the check used to read the LAST token only, so a credential
  // token written before a webauthn/section token read as an ordinary field.
  for (const autocomplete of [
    'new-password webauthn',
    'current-password section-blue',
    'one-time-code shipping',
    'cc-number billing',
    'section-a new-password webauthn',
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
    // A plain field that merely mentions a secret token in a non-token position
    // must still read as ordinary: we compare whole tokens, not substrings.
    { tag: 'input', type: 'text', autocomplete: 'username' },
  ]) {
    assert.equal(isCredentialField(spec), false, JSON.stringify(spec))
  }
})

test('an unreadable field spec fails closed instead of assuming a plain text box', async () => {
  // Regression: the read used to fall back to {tag:'input',type:'',autocomplete:''},
  // which is indistinguishable from an ordinary field, so a page we could not
  // inspect got typed into.
  const unreadable = {
    evaluate: () => Promise.reject(new Error('element is not attached to the DOM')),
  } as unknown as Locator
  await assert.rejects(
    () => readFieldSpec(unreadable),
    (error: unknown) => {
      const code = (error as { code?: string }).code
      assert.equal(code, 'CREDENTIAL_FIELD')
      assert.match(String((error as Error).message), /typed nothing/)
      return true
    },
  )
})

test('a readable field spec comes back verbatim', async () => {
  const readable = {
    evaluate: (fn: (el: unknown) => unknown) =>
      Promise.resolve(
        fn({
          tagName: 'INPUT',
          type: 'PASSWORD',
          getAttribute: (name: string) => (name === 'autocomplete' ? 'current-password' : null),
        }),
      ),
  } as unknown as Locator
  const spec = await readFieldSpec(readable)
  assert.deepEqual(spec, { tag: 'input', type: 'password', autocomplete: 'current-password' })
})
