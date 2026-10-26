import type { Context } from '@deepseek-ai/cordis';
/** Row ids that 0.7.0 stopped reading. */
export declare const LEGACY_ROW_IDS: readonly ["browser-playwright", "browser-tool", "browser-playwright-service"];
/**
 * Subpath entries that 0.7.0 stopped mounting. Rows naming one of these are
 * stale even when the user gave them some other id.
 */
export declare const LEGACY_ENTRY_NAMES: readonly ["dsh-browser-playwright-codex/tool", "dsh-browser-playwright-codex/playwright", "dsh-browser-playwright-codex/service"];
/**
 * Retired package names this project owns on npm. A row mounting one of them
 * keeps a second, older settings card alive — and that card rewrites the patch
 * layer in the pre-0.7.0 shape, so the fix keeps reverting.
 *
 * Matching is by package NAME, never by row id: `- id:` is a local label the
 * user picks, so another plugin may legitimately call its row `browser-tool`.
 * Only a row whose `name:` is one of ours is reported.
 */
export declare const RETIRED_PACKAGES: readonly ["dsh-browser-playwright", "dsh-browser-toggle"];
/** One loader row that no longer takes effect. */
export interface LegacyRow {
    /** The row id, or `(no id)` when the row only carried a legacy `name`. */
    readonly id: string;
    /** The row's `name:` value when it had one. */
    readonly name?: string;
    /** 1-based line number of the row's `- id:` line. */
    readonly line: number;
    /**
     * `entry`: a row mounting a subpath entry this package no longer exposes.
     * `package`: a row mounting a whole package that 0.7.0 retired.
     */
    readonly target: 'entry' | 'package';
}
/**
 * Find loader rows in one patch file's text that 0.7.0 stopped reading.
 *
 * The evidence is always the row's `name:` — never its `- id:`, which is just a
 * local label. A patch layer that happens to call some unrelated plugin's row
 * `browser-tool` is not reported.
 *
 * Pure and text-only so the rule can be tested without touching a real patch
 * layer. Comments are ignored naturally: a commented row fails the anchored
 * `- id:` / `  name:` patterns.
 *
 * @param text - contents of a cordis.patch.yml layer
 * @returns every stale row, in file order
 */
export declare function findLegacyRowsIn(text: string): LegacyRow[];
/**
 * The operator-facing warning for one patch file.
 *
 * Written as one self-contained paragraph pair on purpose: it lands in a log
 * line, so it has to name the file, the rows, and the fix without the reader
 * opening documentation first.
 *
 * @param file - absolute path of the patch layer
 * @param rows - stale rows found in it
 * @returns the warning text
 */
export declare function legacyRowWarning(file: string, rows: readonly LegacyRow[]): string;
/**
 * Patch layers that can hold a browser row: the home layer plus every profile
 * layer. Missing files and unreadable directories are skipped silently — this
 * check must never be the reason a plugin fails to load.
 *
 * @param env - environment (`DSH_HOME` override, as the rest of the package uses)
 * @returns candidate file paths, home layer first
 */
export declare function patchLayers(env?: NodeJS.ProcessEnv): Promise<string[]>;
/** Stale rows found in one patch file. */
export interface LegacyHit {
    /** Absolute path of the patch layer. */
    readonly file: string;
    /** Stale rows inside it. */
    readonly rows: readonly LegacyRow[];
}
/**
 * Scan every patch layer for stale rows.
 *
 * @param env - environment (`DSH_HOME` override)
 * @returns one entry per file that still lists a retired row; empty when clean
 */
export declare function scanLegacyRows(env?: NodeJS.ProcessEnv): Promise<LegacyHit[]>;
/**
 * Warn about stale loader rows, once per DSH home, never throwing.
 *
 * Call it from the plugin entry: it is advisory only, so a failure here must
 * never affect mounting the capability.
 *
 * @param ctx - plugin context (its logger carries the message to the host log)
 * @param env - environment (`DSH_HOME` override, as tests use)
 * @param report - sink for the text (defaults to the context logger, then console)
 */
export declare function warnLegacyRows(ctx: Context, env?: NodeJS.ProcessEnv, report?: (text: string) => void): Promise<void>;
