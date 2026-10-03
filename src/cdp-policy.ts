/**
 * CDP allow-list policy for browser_cdp.
 *
 * Raw CDP is a kernel-level remote control: some commands are read-only
 * inspection / input simulation (safe), while others mutate browser or
 * network state (cookies, request interception, storage, security) — far
 * beyond what an agent should reach through a web tool. This module answers
 * one question: may an agent send this CDP method?
 *
 * Default-deny, by exact name. Every allowed entry is a full method name and
 * matching is plain equality, so a method this list has never heard of — a
 * future Chromium command, a forged suffix, a whole-domain prefix — is denied
 * without anyone having to notice it was added. The earlier policy matched
 * `DOM.get` / `DOM.query` as families, which quietly authorised nine more DOM
 * calls than the reviewed list and would have authorised every future member of
 * those families as well.
 *
 * What is allowed, and why:
 *   - DOM reads: geometry (getBoxModel, getContentQuads, getNodeForLocation),
 *     node lookup (querySelector[All], describeNode, resolveNode), markup and
 *     attribute reads (getOuterHTML, getAttributes) and the root tree.
 *   - One DOM action: focus. It moves focus, the same class of effect as the
 *     input events below, so it is a deliberate allow rather than a read.
 *   - Input simulation, four methods only: Input.dispatchMouseEvent,
 *     Input.dispatchKeyEvent, Input.dispatchTouchEvent, Input.insertText —
 *     CDP-native trusted events. The Input domain as a whole is NOT allowed:
 *     no family prefix, so Input.setIgnoreInputEvents, the gesture
 *     synthesizers and any future Input.* mutation stay denied by default.
 *   - Read-only helpers: Page.getLayoutMetrics, Page.getNavigationHistory,
 *     Page.getFrameTree, CSS.getComputedStyleForNode.
 *
 * Everything else — Network.*, Storage.*, Security.*, Fetch.*, Target.*,
 * Browser.*, Emulation.*, Runtime.evaluate, Page.navigate,
 * Page.getResourceContent (it reads any frame's resource body),
 * DOM.setFileInputFiles, the debugger-internal DOM calls (getDetachedDomNodes,
 * getNodeStackTraces, getRelayoutBoundary, the container-query and anchor
 * helpers …) — is rejected with CDP_DENIED. Growing this list is meant to be
 * work: add the name here, add it to the reviewed list in
 * tests/cdp-policy.test.ts (which asserts the two are equal), and say why.
 * @module dsh-browser-playwright-codex/cdp-policy
 */

/**
 * The allowed CDP methods, as exact names. Keep this explicit and reviewable:
 * nothing here may be a family or domain prefix, and every entry must also
 * appear in the reviewed list in tests/cdp-policy.test.ts.
 *
 * Frozen as a speed bump against accidental in-place edits at runtime. It is
 * not a security boundary — the boundary is the matching rule below plus the
 * tests that pin it; freezing only stops a typo from widening the list.
 */
export const CDP_ALLOWED_METHODS: readonly string[] = Object.freeze([
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
  // The one allowed DOM action (moves focus).
  'DOM.focus',
  // Input simulation: method-explicit, no family prefix.
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.dispatchTouchEvent',
  'Input.insertText',
  // Read-only page layout / history helpers and computed style.
  'Page.getLayoutMetrics',
  'Page.getNavigationHistory',
  'Page.getFrameTree',
  'CSS.getComputedStyleForNode',
])

/** Human summary for the tool description and denial diagnostics. */
export const CDP_ALLOW_SUMMARY =
  'DOM inspection (geometry / node lookup / attributes / markup) plus the four trusted input events (Input.dispatchMouseEvent / Input.dispatchKeyEvent / Input.dispatchTouchEvent / Input.insertText) and read-only Page / CSS helpers, matched by exact name with no family prefixes'

/**
 * Decide whether an agent may send the given CDP method.
 *
 * Exact equality only. The shape check comes first, so a non-string (an object
 * with a toString, a number, a null) is denied without ever being evaluated.
 * There is deliberately no prefix, family or suffix rule: a name that is not
 * written out above does not pass, no matter who adds it to Chromium.
 * @param method - CDP method name, e.g. "DOM.getNodeForLocation".
 * @returns true when the method is exactly one of the allowed names.
 */
export function isCdpMethodAllowed(method: unknown): boolean {
  if (typeof method !== 'string' || method.length === 0) return false
  return CDP_ALLOWED_METHODS.includes(method)
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
