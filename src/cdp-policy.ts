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
 *   - Input simulation: dispatchMouseEvent / dispatchKeyEvent /
 *     dispatchTouchEvent / insertText — CDP-native trusted events.
 *   - A few read-only Page helpers (layout metrics, navigation history,
 *     frame tree) and CSS computed-style reads.
 * Everything else — Network.*, Storage.*, Security.*, Fetch.*, Target.*,
 * Browser.*, Emulation.*, Runtime.evaluate, DOM.setFileInputFiles, etc. — is
 * rejected with CDP_DENIED.
 * @module dsh-browser-playwright/cdp-policy
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
  // Input simulation: CDP-native trusted input events.
  'Input.',
  // Read-only page layout / history helpers.
  'Page.getLayoutMetrics',
  'Page.getNavigationHistory',
  'Page.getFrameTree',
  // Read-only computed style lookup.
  'CSS.getComputedStyleForNode',
]

/** Human summary for the tool description and denial diagnostics. */
export const CDP_ALLOW_SUMMARY =
  'DOM inspection (geometry / node lookup / attributes) and input simulation (Input.* trusted events) only'

/**
 * Decide whether an agent may send the given CDP method.
 * @param method - CDP method name, e.g. "DOM.getNodeForLocation".
 * @returns true when the method is inside the allow-list.
 */
export function isCdpMethodAllowed(method: unknown): boolean {
  if (typeof method !== 'string' || method.length === 0) return false
  return CDP_ALLOW_PREFIXES.some((prefix) => method.startsWith(prefix))
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
