/**
 * 页面快照：识别模式选择、ref 签名与快照差异计算。
 * @module dsh-browser-playwright-codex/page-snapshot
 */
import type { Locator, Page } from 'playwright-core';
import type { PlaywrightSession } from './session.ts';
import type { BrowserNode, BrowserSnapshot } from './types.ts';
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
/** Post-action settle: wait out a real navigation, then render-stabilize before snapshotting. */
export declare function settleAndSnapshot(session: PlaywrightSession, page: Page, navChanged: boolean): Promise<BrowserSnapshot>;
/**
 * Semantic-tree capture via Playwright's official ariaSnapshot(mode:'ai').
 * An unavailable or unreadable aria tree (`missing`) degrades to the legacy
 * DOM walker instead of returning an empty snapshot: the model must never
 * receive "the page has no elements" because the engine failed to parse.
 */
export declare function captureAria(session: PlaywrightSession, page: Page, opts: {
    interactiveOnly?: boolean;
} | undefined): Promise<{
    engineNote: string;
    url: string;
    title: string;
    nodes: BrowserNode[];
    totalRefs: number;
    truncated: boolean;
} | {
    url: string;
    title: string;
    nodes: BrowserNode[];
    totalRefs: number;
    truncated: boolean;
}>;
/** Legacy capture: injected DOM walker (default engine, byte-identical output). */
export declare function captureLegacy(session: PlaywrightSession, page: Page, opts: {
    interactiveOnly?: boolean;
} | undefined): Promise<{
    url: string;
    title: string;
    nodes: BrowserNode[];
    totalRefs: number;
    truncated: boolean;
}>;
/**
 * Attach an incremental diff when snapshot.diff is enabled. Absence of the
 * diff field means "full snapshot follows": first capture of the session,
 * navigation reset, or a truncated tree. The diff is keyed by the stable
 * data-dsh-ref, so legacy and aria engines share the same contract.
 */
export declare function attachDiff(session: PlaywrightSession, snap: BrowserSnapshot): BrowserSnapshot;
/** Build ref -> feature signature map from a captured tree, with parent refs. */
export declare function buildRefSignatures(session: PlaywrightSession, nodes: readonly BrowserNode[]): Map<string, RefSignature>;
export declare function snapshot(session: PlaywrightSession, opts?: {
    interactiveOnly?: boolean;
}): Promise<BrowserSnapshot | {
    url: string;
    title: string;
    nodes: never[];
    totalRefs: number;
    truncated: boolean;
    dialogNote: string;
}>;
export declare function refLocator(session: PlaywrightSession, ref: string): Promise<Locator>;
export declare function assertLive(session: PlaywrightSession): void;
