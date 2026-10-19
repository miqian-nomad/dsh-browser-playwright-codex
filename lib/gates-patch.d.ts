/** Managed block markers: everything between them belongs to this plugin. */
export declare const BEGIN = "# >>> dsh-browser: \u6D4F\u89C8\u5668\u63D2\u4EF6\u914D\u7F6E\uFF08\u672C\u5757\u7531\u8BBE\u7F6E\u9875\u7EF4\u62A4\uFF0C\u4E5F\u53EF\u624B\u5DE5\u7F16\u8F91\uFF09>>>";
export declare const END = "# <<< dsh-browser <<<";
/**
 * The pre-merge markers, written by dsh-browser-toggle 0.3.0. Accepted so an
 * existing block is replaced in place instead of accumulating a second row that
 * would patch the same entry twice.
 */
export declare const LEGACY_BEGIN = "# >>> dsh-browser-toggle: \u5F3A\u529B\u5DE5\u5177\u95F8\u95E8\uFF08\u672C\u5757\u7531\u8BBE\u7F6E\u9875\u7EF4\u62A4\uFF0C\u4E5F\u53EF\u624B\u5DE5\u7F16\u8F91\uFF09>>>";
export declare const LEGACY_END = "# <<< dsh-browser-toggle <<<";
/** Path of the home-level patch layer (highest priority among patch files). */
export declare function homePatchPath(env?: NodeJS.ProcessEnv): string;
/**
 * The managed block: one loader row for the whole plugin, with the shipped
 * launch/provider/snapshot values repeated and the two gates filled in.
 *
 * @param allowEvaluate - register browser_evaluate
 * @param allowCdp - register browser_cdp
 * @returns the YAML block, markers included
 */
export declare function renderBrowserBlock(allowEvaluate: boolean, allowCdp: boolean): string;
/** Merge the managed block into `original`, replacing an existing one in place. */
export declare function mergeBrowserBlock(original: string, allowEvaluate: boolean, allowCdp: boolean): string;
/** Read the current managed block, or undefined when there is none. */
export declare function parseBrowserBlock(text: string): {
    allowEvaluate: boolean;
    allowCdp: boolean;
} | undefined;
/** Back-compat aliases used by the absorbed settings-card host half. */
export declare const parseGatesBlock: typeof parseBrowserBlock;
/** Back-compat alias (see {@link mergeBrowserBlock}). */
export declare const mergeGatesBlock: typeof mergeBrowserBlock;
/**
 * Write both gates into the home-level patch. Backup first, atomic rename, then
 * read back and check; on a failed check the previous bytes are restored.
 *
 * @param allowEvaluate - register browser_evaluate
 * @param allowCdp - register browser_cdp
 * @param env - environment (DSH_HOME override for tests)
 * @returns the file written and the values it now carries
 */
export declare function writeGates(allowEvaluate: boolean, allowCdp: boolean, env?: NodeJS.ProcessEnv): Promise<{
    patch: string;
    allowEvaluate: boolean;
    allowCdp: boolean;
}>;
