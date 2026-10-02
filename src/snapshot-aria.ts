/**
 * Aria semantic snapshot engine: uses Playwright's official
 * locator.ariaSnapshot({ mode: 'ai' }) as the semantic tree source, then
 * re-aligns refs onto the project's stable data-dsh-ref scheme.
 *
 * Why a ref-alignment layer: ariaSnapshot's `[ref=eN]` are Playwright-internal
 * per-invocation handles — they are NOT locator-addressable and their numbering
 * does not survive the project's cross-snapshot stability contract. This module
 * therefore (1) walks the DOM to mint/keep the same e<docNonce><seq> refs the
 * legacy engine uses, (2) parses the official YAML into a semantic tree, and
 * (3) assigns the DOM-minted refs to actionable nodes in document order, so
 * refLocator('[data-dsh-ref=...]') and REF_PATTERN keep working unchanged.
 *
 * The actionable set is intentionally role-based (the same role set the
 * injected engine uses) so DOM-side ref assignment and tree-side ref alignment
 * agree on ordering; elements that only tabindex/contenteditable would make
 * actionable in the legacy engine are out of scope for this engine.
 * @module dsh-browser-playwright-codex/snapshot-aria
 */

import type { Page } from 'playwright-core'
import type { BrowserNode } from './types.ts'

/** Roles that carry a ref (mirrors the legacy engine's INTERACTIVE_ROLES). */
const ACTIONABLE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'combobox',
  'listbox',
  'option',
  'textbox',
  'searchbox',
  'slider',
  'spinbutton',
  'row',
  'gridcell',
])

/**
 * Page-context script: walks the DOM in document order and mints/keeps
 * data-dsh-ref on every actionable element (same rule as the legacy engine,
 * minus the tabindex/contenteditable escape hatches). Returns the refs in
 * document order plus the per-document nonce, so the alignment layer can pair
 * them with the aria tree's actionable nodes depth-first.
 */
export const ARIA_REF_SCRIPT = String.raw`
;(() => {
  // Versioned install guard: a page that already ran an older revision of this
  // script keeps the old closure (and its ref list) otherwise, and a stale
  // closure would silently skip the role verification below.
  if (window.__dshAriaRefsV === 2) return window.__dshAriaRefs()
  window.__dshAriaRefsV = 2
  const INTERACTIVE = new Set(['button','link','checkbox','radio','menuitem','menuitemcheckbox','menuitemradio','tab','switch','combobox','listbox','option','textbox','searchbox','slider','spinbutton','row','gridcell'])
  const TAGS = new Set(['a','button','select','textarea','option','summary'])
  const INPUT_ROLE = { checkbox:'checkbox', radio:'radio', button:'button', submit:'button', reset:'button', image:'button', range:'slider', search:'searchbox', hidden:'null' }
  const DOC_NONCE = String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  let refSeq = 0
  const roleOf = (el) => {
    const explicit = el.getAttribute && el.getAttribute('role')
    if (explicit && explicit.trim()) return explicit.trim().toLowerCase()
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') return INPUT_ROLE[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox'
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textarea'
    if (tag === 'option') return 'option'
    if (tag === 'summary') return 'summary'
    return 'generic'
  }
  const isActionable = (el) => {
    if (!(el instanceof Element)) return false
    const tag = el.tagName.toLowerCase()
    if (TAGS.has(tag)) return true
    const role = roleOf(el)
    if (tag === 'input' && role !== 'null') return true
    return INTERACTIVE.has(role)
  }
  // Visibility must agree with the accessibility tree, or the two lists drift.
  // The tree only contains what a screen reader can reach, so an actionable
  // element the tree cannot see (a hidden menu copy, a 0x0 leftover from a
  // re-render) must not consume a ref slot here: one extra element ahead of a
  // node shifts every later ref onto the wrong element (measured 2026-10-02 on
  // dsh-plugin.market: 7 hidden nav copies moved the textbox's ref 12 slots).
  const isVisible = (el) => {
    try {
      if (el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true') return false
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      // A 'display: contents' box has no rect of its own but lays its children
      // out normally — it belongs to the tree, so it keeps its slot.
      if (style.display === 'contents') return true
      const rect = el.getBoundingClientRect()
      return rect.width > 0 || rect.height > 0
    } catch (_) {
      return false
    }
  }
  const assignRef = (el) => {
    const existing = el.getAttribute('data-dsh-ref')
    if (existing !== null) return existing
    const ref = 'e' + DOC_NONCE + String(++refSeq)
    try { el.setAttribute('data-dsh-ref', ref) } catch (_) { /* foreign objects */ }
    return ref
  }
  window.__dshAriaRefs = () => {
    const refs = []
    // Role of each ref, in the same order, so the alignment layer can verify
    // that ref k really belongs to the node it is about to be pasted onto.
    const roles = []
    const walk = (root) => {
      for (const el of root.children || []) {
        if (el.tagName) {
          const tag = el.tagName.toLowerCase()
          if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue
          if (isActionable(el) && isVisible(el)) {
            refs.push(assignRef(el))
            roles.push(roleOf(el))
          }
        }
        if (el.contentDocument && el.contentDocument.body) {
          walk(el.contentDocument.body)
        } else {
          walk(el)
        }
      }
    }
    if (document.body) walk(document.body)
    return { refs, roles, nonce: DOC_NONCE }
  }
  return window.__dshAriaRefs()
})()
`

/** One semantic node parsed from the official ariaSnapshot YAML. */
export interface AriaNode {
  readonly role: string
  readonly name: string
  /** Playwright-internal ref from the YAML ([ref=eN]); used for alignment only. */
  readonly ariaRef?: string
  readonly level?: number
  readonly checked?: boolean
  readonly selected?: boolean
  readonly disabled?: boolean
  readonly href?: string
  /** `/placeholder:` attribute line: names an input the same way the legacy walker does. */
  readonly placeholder?: string
  readonly children: readonly AriaNode[]
}

/** Mutable build shape for the YAML parser (children are grown in place). */
interface MutableAriaNode {
  role: string
  name: string
  ariaRef?: string
  level?: number
  checked?: boolean
  selected?: boolean
  disabled?: boolean
  href?: string
  placeholder?: string
  children: MutableAriaNode[]
}

/** Parsed tree plus the lines the parser could not read (format drift). */
export interface AriaParseResult {
  readonly roots: AriaNode[]
  /** Content lines that could not be parsed — non-empty means format drift. */
  readonly unparsed: string[]
}

const LINE_RE = /^(\s*)-\s+(.*)$/
const ROLE_RE = /^([A-Za-z][\w-]*)\s*/
const FLAG_RE = /\[([^\]]*)\]/g

/** Read a leading `"quoted"` name, honoring backslash escapes. */
function readQuoted(text: string): { name: string; rest: string } | undefined {
  if (!text.startsWith('"')) return undefined
  let out = ''
  let i = 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      const next = text[i + 1]
      out += next === '"' ? '"' : next === '\\' ? '\\' : next === 'n' ? '\n' : (next ?? '')
      i += 2
      continue
    }
    if (ch === '"') return { name: out, rest: text.slice(i + 1) }
    out += ch
    i += 1
  }
  return undefined
}

/**
 * Parse Playwright's official ariaSnapshot YAML into a semantic node tree.
 *
 * The real format (verified against playwright-core 1.62, 2026-09-30) is:
 *
 *   - generic [active] [ref=e1]:          ← trailing ':' = the node has children
 *     - link "One" [ref=e6] [cursor=pointer]:
 *       - /url: /one                       ← href rides a deeper child line
 *     - text: Name                         ← text content uses 'text: <value>'
 *
 * The first version of this parser assumed a hand-rolled dialect
 * (`- role "name" [flags] -> href`, nothing after the flags) that real output
 * never produces. Every container line ends in ':', so that regex matched none
 * of them: the whole hierarchy was dropped, links and their hrefs vanished, and
 * `captureAriaSnapshot` still reported success. Unreadable lines are now
 * collected in `unparsed` so the capture layer can refuse the tree and let the
 * provider fall back to the legacy engine.
 * @param yaml - the ariaSnapshot text.
 * @returns parsed roots plus any unreadable content lines.
 */
export function parseAriaSnapshotWithStats(yaml: string): AriaParseResult {
  const roots: MutableAriaNode[] = []
  const stack: { indent: number; node: MutableAriaNode }[] = []
  const unparsed: string[] = []
  const push = (indent: number, node: MutableAriaNode) => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top === undefined || top.indent < indent) break
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    if (parent === undefined) roots.push(node)
    else parent.node.children.push(node)
    stack.push({ indent, node })
  }
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const m = LINE_RE.exec(line)
    if (m === null) {
      unparsed.push(trimmed)
      continue
    }
    const indent = Math.floor((m[1] ?? '').length / 2)
    const body = m[2] ?? ''
    // Attribute child lines describe the node declared above: '- /url: /one',
    // '- /placeholder: Search'. Playwright adds facts over time, and an attribute
    // line carries no tree structure — so an unknown one is safe to ignore.
    // Refusing the whole tree over one is what silently turned EVERY page with a
    // placeholder input into a legacy fallback (measured 2026-10-02: the mode
    // selector said smart mode while the engine never got to run).
    if (body.startsWith('/')) {
      const owner = stack[stack.length - 1]
      const colon = body.indexOf(':')
      const key = (colon === -1 ? body.slice(1) : body.slice(1, colon)).trim()
      const value = colon === -1 ? '' : body.slice(colon + 1).trim()
      if (owner === undefined || (key === 'url' && value === '')) {
        unparsed.push(trimmed)
        continue
      }
      // `javascript:` targets carry no navigable URL, so they are not exposed.
      if (key === 'url') {
        if (!value.startsWith('javascript:')) owner.node.href = value
      } else if (key === 'placeholder') {
        owner.node.placeholder = value
      }
      continue
    }
    // Text-content line: '- text: <value>'.
    if (body.startsWith('text:')) {
      push(indent, { role: 'text', name: body.slice('text:'.length).trim(), children: [] })
      continue
    }
    const roleMatch = ROLE_RE.exec(body)
    if (roleMatch === null) {
      unparsed.push(trimmed)
      continue
    }
    const role = (roleMatch[1] ?? '').toLowerCase()
    let rest = body.slice(roleMatch[0].length)
    const node: MutableAriaNode = { role, name: '', children: [] }
    // Optional quoted name, else an inline ': value' form.
    const quoted = readQuoted(rest)
    if (quoted !== undefined) {
      node.name = quoted.name
      rest = quoted.rest
    } else if (rest.startsWith(':')) {
      node.name = rest.slice(1).trim()
      rest = ''
    }
    // Flags may appear in any position after the name; the trailing ':' that
    // marks children is simply ignored.
    for (const flagMatch of rest.matchAll(FLAG_RE)) {
      for (const flag of (flagMatch[1] ?? '').split(',')) {
        const f = flag.trim()
        if (f === '') continue
        const eq = f.indexOf('=')
        const key = eq === -1 ? f : f.slice(0, eq)
        const value = eq === -1 ? '' : f.slice(eq + 1)
        if (key === 'ref') node.ariaRef = value
        else if (key === 'level') node.level = Number(value)
        else if (key === 'checked') node.checked = true
        else if (key === 'selected') node.selected = true
        else if (key === 'disabled') node.disabled = true
      }
    }
    // Inline name AFTER the flags: '- paragraph [ref=e5]: (未点)'. The trailing ':'
    // normally marks children, but whatever follows it is the node's own text.
    // Ignoring it lost page content (measured 2026-10-02: in smart mode every
    // paragraph rendered nameless, and nameless childless nodes are pruned — the
    // text simply never reached the model). Only text after the last ']' counts,
    // so a colon inside a flag value can never be mistaken for a name.
    if (node.name === '') {
      const lastBracket = rest.lastIndexOf(']')
      const tail = (lastBracket === -1 ? rest : rest.slice(lastBracket + 1)).trim()
      if (tail.startsWith(':')) {
        const inline = tail.slice(1).trim()
        if (inline !== '') node.name = inline
      }
    }
    push(indent, node)
  }
  return { roots: roots as unknown as AriaNode[], unparsed }
}

/**
 * Parse Playwright's ariaSnapshot YAML into a semantic node tree.
 * @param yaml - the ariaSnapshot text.
 * @returns the parsed root nodes (see {@link parseAriaSnapshotWithStats} for
 * the unreadable-line report this is a thin wrapper over).
 */
export function parseAriaSnapshot(yaml: string): AriaNode[] {
  return parseAriaSnapshotWithStats(yaml).roots
}

/** Conversion state shared across one aria tree build. */
interface BuildState {
  count: number
  truncated: boolean
  refIndex: number
  /** True once the DOM ref list and the tree's actionable nodes cannot be paired. */
  misaligned: boolean
}

/** Mutable build shape during conversion (BrowserNode fields are readonly). */
interface MutableBrowserNode {
  role: string
  name: string
  ref?: string
  level?: number
  checked?: boolean
  selected?: boolean
  disabled?: boolean
  href?: string
  children: MutableBrowserNode[]
}

/** Whether an aria role carries a ref (must match the DOM-side assignment). */
export function isActionableRole(role: string): boolean {
  return ACTIONABLE_ROLES.has(role)
}

/**
 * Role names the DOM-side walker and the accessibility tree spell differently.
 * Everything the walker reports must compare equal to the tree's spelling, or
 * the alignment below would refuse perfectly good trees.
 */
const ROLE_ALIAS: Record<string, string> = {
  textarea: 'textbox',
  summary: 'button',
  image: 'button',
}

function normalizeRole(role: string): string {
  return ROLE_ALIAS[role] ?? role
}

function convertAriaNode(
  node: AriaNode,
  opts: { maxNodes: number; maxNameLength: number; maxTextLength: number; interactiveOnly?: boolean },
  refs: readonly string[],
  roles: readonly string[] | undefined,
  state: BuildState,
): MutableBrowserNode | null {
  const actionable = isActionableRole(node.role)
  if (opts.interactiveOnly === true && !actionable) {
    const kids: MutableBrowserNode[] = []
    for (const child of node.children) {
      const sub = convertAriaNode(child, opts, refs, roles, state)
      if (sub) kids.push(sub)
    }
    return kids.length ? { role: 'generic', name: '', children: kids } : null
  }
  state.count += 1
  if (state.count > opts.maxNodes) {
    state.truncated = true
    return null
  }
  // Name fallback: an input Playwright names by its placeholder (`/placeholder:`)
  // must read the same here as it does in the legacy walker, or the same page
  // gets two different trees depending on the mode.
  const rawName = node.name !== '' ? node.name : (node.placeholder ?? '')
  const out: MutableBrowserNode = {
    role: node.role,
    name: rawName.length > opts.maxNameLength ? rawName.slice(0, opts.maxNameLength) + '…' : rawName,
    children: [],
  }
  if (actionable) {
    if (state.refIndex >= refs.length) {
      // More actionable nodes in the tree than ref slots minted in the DOM: the
      // two sequences are not the same list, so nothing below can be paired.
      state.misaligned = true
    } else {
      const r = refs[state.refIndex]
      const domRole = roles?.[state.refIndex]
      // Identity check. Positional pairing alone is a guess: one element the
      // tree cannot see (a hidden menu copy, a 0x0 re-render leftover) shifts
      // every later ref onto a different element. Comparing the walker's role
      // with the node's role catches exactly that, and a mismatch means we must
      // not hand the model a ref at all.
      if (roles !== undefined && domRole !== undefined && normalizeRole(domRole) !== normalizeRole(node.role)) {
        state.misaligned = true
      } else if (r !== undefined) {
        out.ref = r
        state.refIndex += 1
      }
    }
  }
  if (node.level !== undefined) out.level = node.level
  if (node.checked === true) out.checked = true
  if (node.selected === true) out.selected = true
  if (node.disabled === true) out.disabled = true
  if (node.href !== undefined) out.href = node.href
  for (const child of node.children) {
    const sub = convertAriaNode(child, opts, refs, roles, state)
    if (sub) out.children.push(sub)
  }
  if (
    !actionable &&
    out.name === '' &&
    out.children.length === 0 &&
    out.checked === undefined &&
    out.selected === undefined &&
    out.disabled === undefined
  ) {
    return null
  }
  return out
}

/**
 * Build BrowserNode[] from the parsed aria tree, aligning DOM-minted refs onto
 * actionable nodes in depth-first order, with node/name caps and truncation.
 * @param nodes - parsed aria tree roots.
 * @param opts - bounding options.
 * @param refs - data-dsh-refs minted by the page-side walk, in document order.
 * @returns the converted tree plus the truncation flag.
 */
export function ariaTreeToBrowserNodes(
  nodes: readonly AriaNode[],
  opts: { maxNodes: number; maxNameLength: number; maxTextLength: number; interactiveOnly?: boolean },
  refs: readonly string[],
  roles?: readonly string[],
): { nodes: BrowserNode[]; truncated: boolean; totalRefs: number; misaligned: boolean } {
  const state: BuildState = { count: 0, truncated: false, refIndex: 0, misaligned: false }
  const out: BrowserNode[] = []
  for (const node of nodes) {
    const sub = convertAriaNode(node, opts, refs, roles, state)
    if (sub) out.push(sub as unknown as BrowserNode)
  }
  // Leftover ref slots mean the DOM minted elements the tree never consumed: the
  // two lists are not the same list, so the pairing above cannot be trusted.
  // Truncation is the one legitimate reason to stop consuming early.
  if (roles !== undefined && !state.truncated && state.refIndex !== refs.length) state.misaligned = true
  return { nodes: out, truncated: state.truncated, totalRefs: refs.length, misaligned: state.misaligned }
}

/**
 * Capture one aria snapshot from a live page: official ariaSnapshot(mode:'ai')
 * for the semantic tree, DOM-side ref minting for stable refs, then alignment.
 * Returns the same shape the legacy capture produces, so playwright.ts can
 * dispatch transparently.
 *
 * `missing: true` is the honest-failure contract: the official call threw, the
 * YAML was empty, or the text carried lines this parser cannot read. The caller
 * must treat it as "engine unavailable" (the provider falls back to the legacy
 * DOM walker) and must never forward the empty node list to the model.
 */
export async function captureAriaSnapshot(
  page: Page,
  opts: { interactiveOnly?: boolean; maxNodes: number; maxNameLength: number; maxTextLength: number } | undefined,
): Promise<{ nodes: BrowserNode[]; truncated: boolean; totalRefs: number; missing?: boolean }> {
  const o = {
    interactiveOnly: opts?.interactiveOnly === true,
    maxNodes: opts?.maxNodes ?? 500,
    maxNameLength: opts?.maxNameLength ?? 120,
    maxTextLength: opts?.maxTextLength ?? 300,
  }
  let aria = ''
  try {
    aria = await page.locator('body').ariaSnapshot({ mode: 'ai' })
  } catch {
    return { nodes: [], truncated: false, totalRefs: 0, missing: true }
  }
  if (aria === '') return { nodes: [], truncated: false, totalRefs: 0, missing: true }
  let assigned: { refs: string[]; roles: string[]; nonce: string } | undefined
  try {
    assigned = await page.evaluate(ARIA_REF_SCRIPT)
  } catch {
    return { nodes: [], truncated: false, totalRefs: 0, missing: true }
  }
  // No roles means no way to verify the pairing — refuse rather than guess.
  if (!assigned || !Array.isArray(assigned.refs) || !Array.isArray(assigned.roles)) {
    return { nodes: [], truncated: false, totalRefs: 0, missing: true }
  }
  const parsed = parseAriaSnapshotWithStats(aria)
  // Format-drift guard. A line this parser cannot read means the tree is not
  // trustworthy — that is exactly how the first version silently dropped every
  // container line (and all hrefs) while still reporting success. Refuse the
  // capture instead: the provider then falls back to the legacy engine.
  if (parsed.unparsed.length > 0) {
    return { nodes: [], truncated: false, totalRefs: 0, missing: true }
  }
  const built = ariaTreeToBrowserNodes(parsed.roots, o, assigned.refs, assigned.roles)
  // Ref-identity guard. The alignment pairs two independently produced lists
  // (DOM walk order vs accessibility-tree order); when they disagree the refs
  // would name one element and resolve to another, and a click on such a ref
  // could land on a different element without any error. Measured 2026-10-02:
  // a page with 7 hidden nav copies shifted every ref after them, so the model
  // was told the search box was the ref of an invisible link. Refuse the whole
  // capture instead — the legacy engine mints refs while it walks, so it cannot
  // drift.
  if (built.misaligned) {
    return { nodes: [], truncated: false, totalRefs: 0, missing: true }
  }
  // A tree with no nodes while the DOM minted refs means the semantic tree lost
  // everything actionable: refuse it rather than hand the model an empty page.
  if (built.nodes.length === 0 && assigned.refs.length > 0) {
    return { nodes: [], truncated: false, totalRefs: 0, missing: true }
  }
  return built
}
