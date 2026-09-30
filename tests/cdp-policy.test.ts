/**
 * CDP allow-list policy: the guard is a security boundary, so it gets its own
 * adversarial cases. Every method in DENIED below would reach cookies, storage,
 * request interception, TLS settings or arbitrary page JavaScript if the prefix
 * list ever widened — the widening guard is the last test.
 * @module dsh-browser-playwright-codex/tests/cdp-policy
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CDP_ALLOW_PREFIXES, cdpDenialMessage, isCdpMethodAllowed } from '../src/cdp-policy.ts'

/** Read-only inspection and trusted input simulation: the whole point of the tool. */
const ALLOWED = [
  'DOM.getDocument',
  'DOM.getBoxModel',
  'DOM.getNodeForLocation',
  'DOM.getContentQuads',
  'DOM.querySelector',
  'DOM.describeNode',
  'DOM.resolveNode',
  'DOM.focus',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Page.getLayoutMetrics',
  'Page.getNavigationHistory',
  'Page.getFrameTree',
  'CSS.getComputedStyleForNode',
]

/** State mutation, data exfiltration, protocol escape hatches. */
const DENIED = [
  'Network.enable',
  'Network.getCookies',
  'Network.setCookie',
  'Storage.getCookies',
  'Storage.setCookies',
  'Storage.clearDataForOrigin',
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.enable',
  'Security.setIgnoreCertificateErrors',
  'Security.enable',
  'Fetch.enable',
  'Fetch.continueRequest',
  'Target.attachToTarget',
  'Target.createTarget',
  'Target.closeTarget',
  'Browser.getVersion',
  'Browser.close',
  'Emulation.setDeviceMetricsOverride',
  'Page.navigate',
  'Page.captureScreenshot',
  'Page.addScriptToEvaluateOnNewDocument',
  'DOM.setFileInputFiles',
  'DOM.setAttributeValue',
  'DOM.removeNode',
  'DOM.highlightNode',
  'DOMSnapshot.captureSnapshot',
  'Overlay.highlightNode',
  'Input.setIgnoreInputEvents',
  'Input.synthesizeScrollGesture',
  'Input.synthesizePinchGesture',
  'Input.dispatchDragEvent',
  'Input.dispatchMouseEvent2',
  'Input.insertText.extra',
]

test('the allow-list accepts every inspection / input-simulation method', () => {
  for (const method of ALLOWED) assert.equal(isCdpMethodAllowed(method), true, method)
})

test('the allow-list denies every state-mutating or data-reading escape hatch', () => {
  for (const method of DENIED) assert.equal(isCdpMethodAllowed(method), false, method)
})

test('a denied method is rejected on shape alone (never evaluated)', () => {
  assert.equal(isCdpMethodAllowed(''), false)
  assert.equal(isCdpMethodAllowed(undefined), false)
  assert.equal(isCdpMethodAllowed(null), false)
  assert.equal(isCdpMethodAllowed(42), false)
  assert.equal(isCdpMethodAllowed({ toString: () => 'DOM.getDocument' }), false)
})

test('the denial message names the method and the allowed families', () => {
  const message = cdpDenialMessage('Network.enable')
  assert.ok(message.includes('"Network.enable"'), message)
  assert.ok(message.includes('not in the allow-list'), message)
  assert.ok(message.includes('DOM inspection'), message)
})

test('no family-wide prefix may be allow-listed (widening guard)', () => {
  // A family-wide prefix like 'Input.' or 'Network.' would silently open
  // everything behind it (Input.setIgnoreInputEvents, Input.synthesizeScroll
  // Gesture, a future Input.* mutation ...). The list must stay method-explicit:
  // nothing may end in a dot, not even Input.
  assert.deepEqual(
    CDP_ALLOW_PREFIXES.filter((prefix) => prefix.endsWith('.')),
    [],
  )
})
