import { type ScriptStep } from './script-steps.ts';
/** Directory holding the saved scripts. `DSH_BROWSER_SCRIPTS_DIR` overrides it (tests). */
export declare function scriptsDir(): string;
/** Validate a script name, returning the trimmed value. */
export declare function validName(raw: unknown): string;
/** One saved script, as stored. */
export interface StoredScript {
    readonly name: string;
    readonly savedAt: string;
    readonly steps: readonly ScriptStep[];
}
/**
 * Write a script, replacing any file of the same name.
 *
 * @param name - Validated script name.
 * @param steps - Steps already validated by `parseScriptSteps`.
 * @returns The file path and how many steps were stored.
 */
export declare function saveScript(name: string, steps: readonly ScriptStep[]): {
    path: string;
    steps: number;
};
/**
 * Read one script.
 *
 * @param name - Validated script name.
 * @param maxSteps - Cap applied to the file's steps, so an edited file cannot
 *   smuggle in a longer list than the tool accepts.
 */
export declare function loadScript(name: string, maxSteps: number): StoredScript;
/** Names of the saved scripts, sorted. Missing directory means none yet. */
export declare function listScripts(): string[];
