/** The four buckets the card can report and clean. */
export type TargetId = 'browser-cache' | 'temp-residue' | 'updater-residue' | 'attachment-cache';
/** Display order and labels for every target. */
export declare const TARGETS: readonly {
    id: TargetId;
    label: string;
}[];
/** Is this value one of the enum ids? Unknown strings are rejected, never joined into a path. */
export declare function isTargetId(value: unknown): value is TargetId;
/** Absolute locations this module may inspect. */
export interface CachePaths {
    /** DSH home (`~/.dsh` unless DSH_HOME overrides it). */
    dshHome: string;
    /** Persistent Chromium profile directory of the browser capability. */
    browserProfileDir: string;
    /** OS temp directory. */
    tmpDir: string;
    /** Electron updater residue directory for the DSH desktop app. */
    updaterDir: string;
    /** Version currently installed — used to refuse other versions' installers. */
    installedVersion: string;
}
/** Resolve the default paths from the environment (no path ever comes from the request). */
export declare function resolvePaths(env: NodeJS.ProcessEnv | undefined, version: string, platform?: NodeJS.Platform): CachePaths;
/** One row of the disk panel. */
export interface DiskItem {
    id: TargetId;
    label: string;
    bytes: number;
    files: number;
    /** Optional human note (e.g. "浏览器正在运行，整段跳过"). */
    note?: string;
}
/** What `scan()` reports. */
export interface ScanReport {
    items: DiskItem[];
    totalBytes: number;
    attachments: {
        objectsBytes: number;
        requestImagesBytes: number;
    };
    skipped: {
        id: TargetId;
        reason: string;
    }[];
}
/** One skipped entry inside a target. */
export interface SkippedEntry {
    path: string;
    reason: 'in-use' | 'permission' | 'other-version' | 'unknown-version' | 'missing';
}
/** Per-target outcome of a clean pass. */
export interface CleanTargetReport {
    id: TargetId;
    freedBytes: number;
    skipped: SkippedEntry[];
}
/** What `clean()` reports. */
export interface CleanReport {
    dryRun: boolean;
    freedBytes: number;
    perTarget: CleanTargetReport[];
}
/** Options for one clean pass. */
export interface CleanOptions extends CachePaths {
    targets: readonly TargetId[];
    dryRun: boolean;
    /** True when the capability is enabled — reported, not used to skip silently. */
    browserActive?: boolean;
    /** Clock override for tests. */
    now?: number;
}
/**
 * Inspect every bucket without touching anything.
 * @param paths - resolved locations
 * @returns per-target sizes plus the attachment totals kept apart from the cache
 */
export declare function scan(paths: CachePaths): Promise<ScanReport>;
/**
 * Clean the requested buckets. With `dryRun` the same walk happens but nothing
 * is renamed or removed, so the preview shows real numbers.
 *
 * @param options - resolved paths, enum targets and dry-run flag
 * @returns per-target freed bytes and every skipped entry with a reason
 */
export declare function clean(options: CleanOptions): Promise<CleanReport>;
/** Human-readable size for the card and the CLI. */
export declare function formatBytes(bytes: number): string;
/** Basename helper re-exported for the route's skipped-entry display. */
export declare function displayName(path: string): string;
