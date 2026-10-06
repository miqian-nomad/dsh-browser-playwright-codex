/**
 * The page-side probes are serialized into the browser, so they have one rule the rest of the
 * codebase does not: **no named inner function bindings**.
 *
 * Why it is a test and not a comment: a transpiler that keeps function names (esbuild, through its
 * `__name` helper) rewrites `const describe = (…) => …` inside a serialized function into a call to
 * a helper that only exists in module scope. The page has no such helper, so the probe throws
 * ReferenceError on every call — and because those call sites swallow errors, the whole
 * click-geometry pipeline was silently disabled for weeks while the test suite stayed green
 * (found 2026-10-05). Safe shapes: an array literal (`const [a, b] = [() => …, () => …]`, which also
 * allows the two to call each other) or an immediately-invoked arrow.
 *
 * This checks the *serialized source* (`String(fn)`), so it works under the native type-stripping
 * runner and under a name-preserving transpiler alike.
 * @module dsh-browser-playwright-codex/tests/page-probes
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as probes from '../src/page-probes.ts'

/**
 * Every function this module exports, whatever it happens to be named. Enumerating the module
 * instead of a hand-written list is deliberate: `hitTest` lived as a named inner function inside
 * the session's click code until a reviewer caught it, and a hand list would not have noticed the
 * next one either (page-actions.ts imports it from here now).
 */
function exportedProbes(): Array<[string, (...args: never[]) => unknown]> {
  return Object.entries(probes).filter(
    (entry): entry is [string, (...args: never[]) => unknown] => typeof entry[1] === 'function',
  )
}

/** Named function bindings inside a function body — the shape a name-preserving transpiler rewrites. */
function namedInnerBindings(source: string): string[] {
  const pattern =
    /(?:^|[;{}\s])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function\b|async\s+function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g
  return [...source.matchAll(pattern)].map((match) => match[1])
}

test('the self-containment rule catches a named inner arrow (this test has teeth)', () => {
  const bad = (x: number) => {
    const twice = (n: number) => n * 2
    return twice(x)
  }
  const found = namedInnerBindings(String(bad))
  assert.deepEqual(found, ['twice'], 'the rule must flag `const twice = (…) => …`: ' + String(bad))
  // The safe shapes must not be flagged.
  const good = (x: number) => {
    const [twice] = [(n: number): number => n * 2]
    return twice(x)
  }
  assert.deepEqual(namedInnerBindings(String(good)), [], 'an array literal is safe: ' + String(good))
})

test('every function this module exports is self-contained', () => {
  const exported = exportedProbes()
  // A vacuous pass (nothing exported / renamed away) must not look like coverage.
  assert.ok(
    exported.length >= 5,
    'expected the page-side probes to be exported from this module: ' + exported.map((p) => p[0]).join(', '),
  )
  for (const [name, fn] of exported) {
    const source = String(fn)
    assert.deepEqual(
      namedInnerBindings(source),
      [],
      `${name} has named inner function bindings — a name-preserving transpiler turns those into a ` +
        `call to a module-scope helper the page does not have: ${source.slice(0, 160)}`,
    )
    assert.ok(
      !source.includes('__name('),
      `${name} carries a transpiler name helper, so it was serialized after being rewritten: ${source.slice(0, 160)}`,
    )
  }
})
