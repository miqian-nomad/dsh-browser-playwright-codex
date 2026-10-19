/**
 * Pure snapshot rendering: model-facing tree text. No I/O, no clock — these
 * functions run on live calls and on session replay alike.
 * @module dsh-browser-playwright-codex/snapshot-render
 */
import type { BrowserNode, BrowserSnapshot, SnapshotDiff } from './types.ts';
/** Default cap for a rendered href, in characters. */
export declare const MAX_HREF_LENGTH = 160;
/**
 * Trim a href for display: drop analytics parameters and clip the whole thing.
 * The snapshot's refs remain the interaction handle, so this only affects what
 * the model reads, never what a click does.
 *
 * @param href - the raw href from the accessibility tree
 * @param maxLength - display budget in characters
 * @returns the shortened href
 */
export declare function trimUrlForDisplay(href: string, maxLength?: number): string;
/**
 * Render a node tree as indented lines, one element per line.
 * @param nodes - the snapshot's root nodes.
 * @returns the rendered tree text.
 */
export declare function renderSnapshotTree(nodes: readonly BrowserNode[]): string;
/**
 * Render a complete snapshot: header facts plus the tree.
 * @param snapshot - the bounded accessibility snapshot.
 * @returns the model-facing snapshot text.
 */
export declare function renderSnapshot(snapshot: BrowserSnapshot): string;
/**
 * Render an incremental snapshot diff as model-facing lines: `+` for added,
 * `-` for removed, `~` for changed, each line carrying its nearest ancestor
 * ref so the model keeps tree context without a full re-render. A navigation
 * reset renders as a marker line: the delta is void and the full snapshot
 * that follows is authoritative.
 * @param diff - the incremental delta produced by the provider.
 * @returns the rendered diff text.
 */
export declare function renderSnapshotDiff(diff: SnapshotDiff): string;
