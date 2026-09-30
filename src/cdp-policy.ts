/**
 * CDP allow-list policy for browser_cdp.
 *
 * Raw CDP is a kernel-level remote control: some commands are read-only
 * inspection / input simulation (safe), while others mutate browser or
 * network state (cookies, request interception, storage, security) — far
 * beyond what an agent should reach through a web tool. This module answers
 * one question: may an agent send this CDP method?
 *
 * Default-deny. Only the method families below are allowed:
 *   - DOM inspection / query: geometry (getBoxModel, getNodeForLocation,
 *     getContentQuads), node lookup (querySelector, describeNode, resolveNode,
 *     requestNode) and attribute reads. All DOM.get* are read-only.
 *   - Input simulation, method-explicit only: Input.dispatchMouseEvent /
 *     Input.dispatchKeyEvent / Input.dispatchTouchEvent / Input.insertText —
 *     CDP-native trusted events. The Input domain as a whole is NOT allowed:
 *     no family-wide 'Input.' prefix, so Input.setIgnoreInputEvents and other
 *     future/untracked Input.* mutations stay denied by default.
 *   - A few read-only Page helpers (layout metrics, navigation history,
 *     frame tree) and CSS computed-style reads.
 * Everything else — Network.*, Storage.*, Security.*, Fetch.*, Target.*,
 * Browser.*, Emulation.*, Runtime.evaluate, DOM.setFileInputFiles, etc. — is
 * rejected with CDP_DENIED.
 * @module dsh-browser-playwright-codex/cdp-policy
 */

/** Method prefixes the allow-list accepts. Keep this explicit and reviewable. */
export const CDP_ALLOW_PREFIXES: readonly string[] = [
  // DOM inspection: geometry + node/attribute reads (all read-only).
  'DOM.get',
  'DOM.query',
  'DOM.describeNode',
  'DOM.requestNode',
  'DOM.resolveNode',
  'DOM.performSearch',
  'DOM.focus',
  'DOM.collectClassNamesFromSubtree',
  'DOM.getRelayoutBoundary',
  'DOM.getFrameOwner',
  'DOM.requestChildNodes',
  'DOM.getContainerForNode',
  'DOM.getQueryingDescendantsForContainer',
  'DOM.getNodesForSubtreeByStyle',
  // Input simulation: the four trusted CDP-native input events, enumerated
  // explicitly. No 'Input.' family prefix: future Input.* methods (e.g.
  // setIgnoreInputEvents, synthesizeScrollGesture) are denied by default.
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.dispatchTouchEvent',
  'Input.insertText',
  // Read-only page layout / history helpers.
  'Page.getLayoutMetrics',
  'Page.getNavigationHistory',
  'Page.getFrameTree',
  // Read-only computed style lookup.
  'CSS.getComputedStyleForNode',
]

/** Human summary for the tool description and denial diagnostics. */
export const CDP_ALLOW_SUMMARY =
  'DOM inspection (geometry / node lookup / attributes) and trusted input events (Input.dispatchMouseEvent / Input.dispatchKeyEvent / Input.dispatchTouchEvent / Input.insertText) only'

/**
 * Decide whether an agent may send the given CDP method.
 *
 * Matching rules keep the list method-explicit:
 *   - a prefix ending in '.' (none today — the widening guard forbids it)
 *     would open the whole family;
 *   - 'DOM.get' / 'DOM.query' are read-only families matched on their Pascal
 *     segment (e.g. DOM.getDocument), never on a forged lower-case suffix;
 *   - every other entry is an exact full method name, so a forged suffix like
 *     'Input.dispatchMouseEvent2' or 'Input.insertText.extra' cannot ride the
 *     allow-list.
 * @param method - CDP method name, e.g. "DOM.getNodeForLocation".
 * @returns true when the method is inside the allow-list.
 */
export function isCdpMethodAllowed(method: unknown): boolean {
  if (typeof method !== 'string' || method.length === 0) return false
  return CDP_ALLOW_PREFIXES.some((prefix) => {
    if (prefix.endsWith('.')) return method.startsWith(prefix)
    if (method === prefix) return true
    return method.startsWith(prefix) && /^[A-Z]/.test(method.slice(prefix.length))
  })
}

/**
 * Describe a denied method for the error message: name the allow-list family
 * so the model learns the boundary instead of guessing.
 */
export function cdpDenialMessage(method: unknown): string {
  return (
    'browser_cdp method ' +
    JSON.stringify(method) +
    ' is not in the allow-list (' +
    CDP_ALLOW_SUMMARY +
    '). ' +
    'If you need it, it is intentionally blocked: raw CDP network/storage/security commands can mutate cookies, ' +
    'intercept traffic or read stored data, which the agent must not do through this tool.'
  )
}
