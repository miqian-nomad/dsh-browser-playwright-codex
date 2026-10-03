/**
 * CDP allow-list policy: the guard is a security boundary, so it gets its own
 * adversarial cases. Every method in DENIED below would reach cookies, storage,
 * request interception, TLS settings or arbitrary page JavaScript if the list
 * ever widened.
 * @module dsh-browser-playwright-codex/tests/cdp-policy
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CDP_ALLOWED_METHODS, cdpDenialMessage, isCdpMethodAllowed } from '../src/cdp-policy.ts'

/**
 * Read-only inspection, one deliberate focus action and trusted input
 * simulation: the whole point of the tool.
 *
 * This list is written out independently of the source, and the first test
 * below asserts the two are equal. That is deliberate: entering or leaving the
 * policy therefore requires editing this list too, so a widening can never be a
 * one-line change to the source that nothing else notices.
 */
const ALLOWED = [
  // DOM reads.
  'DOM.getDocument',
  'DOM.getBoxModel',
  'DOM.getNodeForLocation',
  'DOM.getContentQuads',
  'DOM.getOuterHTML',
  'DOM.getAttributes',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.describeNode',
  'DOM.resolveNode',
  // The one allowed DOM action: moves focus, the same class of effect as the
  // input events below (it is not a read).
  'DOM.focus',
  // Input simulation: the four trusted CDP-native events, no family prefix.
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.dispatchTouchEvent',
  'Input.insertText',
  // Read-only Page helpers and computed-style reads.
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
  // Deliberately not granted. The first nine arrived through the removed
  // DOM.get / DOM.query families; the second nine were hand-listed earlier and
  // were reviewed out (debugger- and UA-internal features an agent has no
  // business using). Reintroducing one is a policy decision, not a bug fix.
  'DOM.getAnchorElement',
  'DOM.getDetachedDomNodes',
  'DOM.getElementByRelation',
  'DOM.getFileInfo',
  'DOM.getFlattenedDocument',
  'DOM.getImplicitAnchorCandidates',
  'DOM.getNodeStackTraces',
  'DOM.getSearchResults',
  'DOM.getTopLayerElements',
  'DOM.collectClassNamesFromSubtree',
  'DOM.getContainerForNode',
  'DOM.getFrameOwner',
  'DOM.getNodesForSubtreeByStyle',
  'DOM.getQueryingDescendantsForContainer',
  'DOM.getRelayoutBoundary',
  'DOM.performSearch',
  'DOM.requestChildNodes',
  'DOM.requestNode',
]

test('the allow-list accepts every inspection / input-simulation method', () => {
  for (const method of ALLOWED) assert.equal(isCdpMethodAllowed(method), true, method)
})

test('the allow-list denies every state-mutating or data-reading escape hatch', () => {
  for (const method of DENIED) assert.equal(isCdpMethodAllowed(method), false, method)
})

test('the policy is exactly the reviewed list, both directions', () => {
  // Widening and narrowing both show up here, so neither can happen silently in
  // the source without this file changing too.
  assert.deepEqual(
    [...CDP_ALLOWED_METHODS].sort(),
    [...ALLOWED].sort(),
    'src/cdp-policy.ts and this reviewed list disagree',
  )
})

test('nothing but the exact allowed names is accepted', () => {
  // Each probe models one way a matcher can be written too loosely. The
  // assertion is on the accepted set, not on the probes: whatever the matcher
  // becomes (equality, prefix, regex, case-insensitive), the set of accepted
  // candidates must stay exactly the reviewed list.
  const probes: Array<[string, string]> = []
  for (const method of ALLOWED) {
    const domain = method.slice(0, method.indexOf('.') + 1)
    probes.push([method + 'Zzz', 'uppercase suffix (prefix matching)'])
    probes.push([method + 'zzz', 'lowercase suffix (case-insensitive matching)'])
    probes.push([method + '2', 'digit suffix'])
    probes.push([method + '.extra', 'dot suffix'])
    probes.push([method.toLowerCase(), 'normalisation'])
    probes.push([method.slice(0, -1), 'off-by-one truncation'])
    probes.push([method + ' ', 'trailing space'])
    probes.push([domain, 'whole-domain prefix'])
    probes.push([domain + 'SomethingNew', 'whole-domain prefix plus a new method'])
  }
  const pool = [...new Set([...ALLOWED, ...probes.map(([probe]) => probe)])]
  const accepted = pool.filter((method) => isCdpMethodAllowed(method)).sort()
  assert.deepEqual(
    accepted,
    [...ALLOWED].sort(),
    'these probes rode into the allow-list: ' +
      JSON.stringify(probes.filter(([probe]) => isCdpMethodAllowed(probe) && !ALLOWED.includes(probe))),
  )
  // The policy also has to be frozen: a mutable list can be widened at runtime.
  assert.ok(Object.isFrozen(CDP_ALLOWED_METHODS), 'the allow-list must be frozen')
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
    CDP_ALLOWED_METHODS.filter((method) => method.endsWith('.')),
    [],
  )
})
