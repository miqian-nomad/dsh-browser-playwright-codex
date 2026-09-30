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
  if (window.__dshAriaRefs) return window.__dshAriaRefs()
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
  const assignRef = (el) => {
    const existing = el.getAttribute('data-dsh-ref')
    if (existing !== null) return existing
    const ref = 'e' + DOC_NONCE + String(++refSeq)
    try { el.setAttribute('data-dsh-ref', ref) } catch (_) { /* foreign objects */ }
    return ref
  }
  window.__dshAriaRefs = () => {
    const refs = []
    const walk = (root) => {
      for (const el of root.children || []) {
        if (el.tagName) {
          const tag = el.tagName.toLowerCase()
          if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') continue
          if (isActionable(el)) refs.push(assignRef(el))
        }
        if (el.contentDocument && el.contentDocument.body) {
          walk(el.contentDocument.body)
        } else {
          walk(el)
        }
      }
    }
    if (document.body) walk(document.body)
    return { refs, nonce: DOC_NONCE }
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
    // Href child line: it belongs to the node declared on the previous line.
    // `javascript:` targets carry no navigable URL, so they are not exposed.
    if (body.startsWith('/url:')) {
      const owner = stack[stack.length - 1]
      const value = body.slice('/url:'.length).trim()
      if (owner === undefined || value === '') unparsed.push(trimmed)
      else if (!value.startsWith('javascript:')) owner.node.href = value
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

function convertAriaNode(
  node: AriaNode,
  opts: { maxNodes: number; maxNameLength: number; maxTextLength: number; interactiveOnly?: boolean },
  refs: readonly string[],
  state: BuildState,
): MutableBrowserNode | null {
  const actionable = isActionableRole(node.role)
  if (opts.interactiveOnly === true && !actionable) {
    const kids: MutableBrowserNode[] = []
    for (const child of node.children) {
      const sub = convertAriaNode(child, opts, refs, state)
      if (sub) kids.push(sub)
    }
    return kids.length ? { role: 'generic', name: '', children: kids } : null
  }
  state.count += 1
  if (state.count > opts.maxNodes) {
    state.truncated = true
    return null
  }
  const out: MutableBrowserNode = {
    role: node.role,
    name: node.name.length > opts.maxNameLength ? node.name.slice(0, opts.maxNameLength) + '…' : node.name,
    children: [],
  }
  if (actionable && state.refIndex < refs.length) {
    const r = refs[state.refIndex]
    if (r !== undefined) {
      out.ref = r
      state.refIndex += 1
    }
  }
  if (node.level !== undefined) out.level = node.level
  if (node.checked === true) out.checked = true
  if (node.selected === true) out.selected = true
  if (node.disabled === true) out.disabled = true
  if (node.href !== undefined) out.href = node.href
  for (const child of node.children) {
    const sub = convertAriaNode(child, opts, refs, state)
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
): { nodes: BrowserNode[]; truncated: boolean; totalRefs: number } {
  const state: BuildState = { count: 0, truncated: false, refIndex: 0 }
  const out: BrowserNode[] = []
  for (const node of nodes) {
    const sub = convertAriaNode(node, opts, refs, state)
    if (sub) out.push(sub as unknown as BrowserNode)
  }
  return { nodes: out, truncated: state.truncated, totalRefs: refs.length }
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
  let assigned: { refs: string[]; nonce: string } | undefined
  try {
    assigned = await page.evaluate(ARIA_REF_SCRIPT)
  } catch {
    return { nodes: [], truncated: false, totalRefs: 0, missing: true }
  }
  if (!assigned || !Array.isArray(assigned.refs)) {
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
  const built = ariaTreeToBrowserNodes(parsed.roots, o, assigned.refs)
  // A tree with no nodes while the DOM minted refs means the semantic tree lost
  // everything actionable: refuse it rather than hand the model an empty page.
  if (built.nodes.length === 0 && assigned.refs.length > 0) {
    return { nodes: [], truncated: false, totalRefs: 0, missing: true }
  }
  return built
}
