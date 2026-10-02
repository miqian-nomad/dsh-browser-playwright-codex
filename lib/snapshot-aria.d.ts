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
import type { Page } from 'playwright-core';
import type { BrowserNode } from './types.ts';
/**
 * Page-context script: walks the DOM in document order and mints/keeps
 * data-dsh-ref on every actionable element (same rule as the legacy engine,
 * minus the tabindex/contenteditable escape hatches). Returns the refs in
 * document order plus the per-document nonce, so the alignment layer can pair
 * them with the aria tree's actionable nodes depth-first.
 */
export declare const ARIA_REF_SCRIPT: string;
/** One semantic node parsed from the official ariaSnapshot YAML. */
export interface AriaNode {
    readonly role: string;
    readonly name: string;
    /** Playwright-internal ref from the YAML ([ref=eN]); used for alignment only. */
    readonly ariaRef?: string;
    readonly level?: number;
    readonly checked?: boolean;
    readonly selected?: boolean;
    readonly disabled?: boolean;
    readonly href?: string;
    readonly children: readonly AriaNode[];
}
/** Parsed tree plus the lines the parser could not read (format drift). */
export interface AriaParseResult {
    readonly roots: AriaNode[];
    /** Content lines that could not be parsed — non-empty means format drift. */
    readonly unparsed: string[];
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
export declare function parseAriaSnapshotWithStats(yaml: string): AriaParseResult;
/**
 * Parse Playwright's ariaSnapshot YAML into a semantic node tree.
 * @param yaml - the ariaSnapshot text.
 * @returns the parsed root nodes (see {@link parseAriaSnapshotWithStats} for
 * the unreadable-line report this is a thin wrapper over).
 */
export declare function parseAriaSnapshot(yaml: string): AriaNode[];
/** Whether an aria role carries a ref (must match the DOM-side assignment). */
export declare function isActionableRole(role: string): boolean;
/**
 * Build BrowserNode[] from the parsed aria tree, aligning DOM-minted refs onto
 * actionable nodes in depth-first order, with node/name caps and truncation.
 * @param nodes - parsed aria tree roots.
 * @param opts - bounding options.
 * @param refs - data-dsh-refs minted by the page-side walk, in document order.
 * @returns the converted tree plus the truncation flag.
 */
export declare function ariaTreeToBrowserNodes(nodes: readonly AriaNode[], opts: {
    maxNodes: number;
    maxNameLength: number;
    maxTextLength: number;
    interactiveOnly?: boolean;
}, refs: readonly string[], roles?: readonly string[]): {
    nodes: BrowserNode[];
    truncated: boolean;
    totalRefs: number;
    misaligned: boolean;
};
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
export declare function captureAriaSnapshot(page: Page, opts: {
    interactiveOnly?: boolean;
    maxNodes: number;
    maxNameLength: number;
    maxTextLength: number;
} | undefined): Promise<{
    nodes: BrowserNode[];
    truncated: boolean;
    totalRefs: number;
    missing?: boolean;
}>;
