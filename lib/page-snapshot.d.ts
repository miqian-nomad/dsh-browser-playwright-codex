import type { SnapshotDiffEntry } from './types.ts';
/**
 * Which page-reading mode a capture uses. The user's choice on the settings page
 * (Settings → 浏览器 → 页面识别方式) wins over the deployment default, so flipping
 * that switch changes the very next operation — no restart, no config edit.
 * @param configured - the mode from this provider's config.
 * @returns the effective mode.
 */
export declare function resolveSnapshotEngine(configured: 'legacy' | 'aria'): 'legacy' | 'aria';
/** Feature fingerprint of one ref-bearing node, for cross-snapshot diffing. */
export interface RefSignature {
    role?: string;
    name?: string;
    level?: number;
    checked?: boolean;
    selected?: boolean;
    disabled?: boolean;
    href?: string;
    parentRef?: string;
}
/** Feature flags carried by an added diff entry. */
export declare function flagsOf(sig: RefSignature): string[];
/** Flag keys whose value changed between two signatures. */
export declare function flagsDeltaOf(before: RefSignature, after: RefSignature): string[];
/** Build a SnapshotDiffEntry, dropping undefined optionals (exactOptionalPropertyTypes). */
export declare function diffEntry(input: {
    ref: string;
    role?: string | undefined;
    name?: string | undefined;
    flags?: string[] | undefined;
    flagsDelta?: string[] | undefined;
    parentRef?: string | undefined;
}): SnapshotDiffEntry;
