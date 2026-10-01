/** How a page is read into a snapshot tree. */
export type SnapshotEngine = 'legacy' | 'aria';
/** Current enable state (loads from disk on first call). */
export declare function getEnabled(): boolean;
/** Set the enable state. Returns true if the value actually changed. */
export declare function setEnabled(next: boolean): boolean;
/** Subscribe to enable-state transitions. Returns an unsubscribe function. */
export declare function subscribe(fn: (enabled: boolean) => void): () => void;
/**
 * The page-reading mode the user picked, or undefined when they never picked
 * one — the configured default then applies.
 */
export declare function getSnapshotEngine(): SnapshotEngine | undefined;
/** Pick the page-reading mode. Returns true if the value actually changed. */
export declare function setSnapshotEngine(next: SnapshotEngine): boolean;
/**
 * Report the mode this deployment was configured with, so the settings page can
 * display what is actually in effect instead of guessing. Called by the provider
 * when it is constructed; not persisted (it comes from config).
 * @param engine - the configured default mode.
 */
export declare function publishConfiguredEngine(engine: SnapshotEngine): void;
/**
 * What a capture will use right now: the user's pick, else the configured
 * default, else 'legacy'. This is what the settings page shows.
 */
export declare function getEffectiveEngine(): SnapshotEngine;
/** Whether the current mode is the user's own pick rather than the default. */
export declare function isEngineUserChosen(): boolean;
