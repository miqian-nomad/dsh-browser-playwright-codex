/**
 * Injected page-context snapshot engine, installed through addInitScript.
 * It is plain JavaScript: it runs inside the page, never in Node. Each
 * snapshot call assigns stable data-dsh-ref attributes to actionable
 * elements in document order and returns a pruned role/name tree. Names come
 * from the element itself first, then from its descendants for actionable
 * elements whose own text is empty (so a label one level down still lands on
 * the line that carries the ref). A child that merely repeats an ancestor
 * name is folded, and container roles (select options, table rows) are never
 * named from their content.
 * @module dsh-browser-playwright-codex/injected
 */
/** Options passed from the provider into one snapshot call. */
export interface SnapshotOptions {
    /** Include only actionable (ref-carrying) elements. */
    readonly interactiveOnly?: boolean;
    /** Maximum nodes in the returned tree. */
    readonly maxNodes?: number;
    /** Maximum characters kept per accessible name. */
    readonly maxNameLength?: number;
    /** Maximum characters kept per text block. */
    readonly maxTextLength?: number;
}
/** Options for the bounded page-data extraction. */
export interface PageDataOptions {
    readonly maxTextChars?: number;
    readonly maxLinks?: number;
    readonly maxInputs?: number;
}
/**
 * The browser-side snapshot script. Installed with page.addInitScript and
 * invoked as window.__dshSnapshot(opts). The returned value crosses the
 * evaluate boundary as plain JSON.
 */
export declare const SNAPSHOT_SCRIPT: string;
