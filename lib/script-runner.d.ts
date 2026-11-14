/**
 * Runs a saved script's steps against a live browser session.
 *
 * Shape of a run, and why:
 *  - A step list is executed in order, and the first failure ends the run. A
 *    script that continued past a failed click would act on a page that never
 *    got to where the script assumed, and every later step would be noise.
 *  - Each step uses the same session methods the individual tools call, so the
 *    URL policy, ref validation and credential refusal stay in force; a step
 *    cannot do anything the model could not do one call at a time.
 *  - A `text` target is resolved against the freshest snapshot immediately
 *    before the action, never against a snapshot taken at the start: that is
 *    the ref-staleness failure every mature runner designs around.
 *  - The failure result carries the index, the action and the snapshot from
 *    the last good step, so the model can take over from there instead of
 *    replaying the whole script blind.
 * @module dsh-browser-playwright-codex/script-runner
 */
import type { BrowserSession, BrowserSnapshot } from './types.ts';
import { type ScriptStep } from './script-steps.ts';
/** One step's result. */
export interface ScriptStepOutcome {
    /** 1-based index, as the model numbered the steps. */
    readonly index: number;
    /** Human-readable line, e.g. `click "登录"`. */
    readonly step: string;
    readonly ok: boolean;
    /** What the step did, on success. */
    readonly note?: string;
}
/** Everything one run produced. */
export interface ScriptRunOutcome {
    /** Steps attempted, including the one that failed. */
    readonly ran: number;
    /** Steps in the script. */
    readonly total: number;
    /** 1-based index of the failed step; absent when the whole script ran. */
    readonly failedAt?: number;
    /** Action name of the failed step. */
    readonly failedAction?: string;
    /** Failure message, unchanged from the underlying action. */
    readonly failure?: string;
    /** Machine-readable code when the failure was a BrowserError. */
    readonly failureCode?: string;
    /** Snapshot from the last step that succeeded (or the failed one's page). */
    readonly snapshot?: BrowserSnapshot;
    /** Per-step log, oldest first. */
    readonly outcomes: readonly ScriptStepOutcome[];
}
/** Options for {@link runScript}. */
export interface RunScriptOptions {
    /** Cancellation from the calling tool execution. */
    readonly signal?: AbortSignal;
    /** Called with the last working snapshot; used to publish login sites. */
    readonly onSnapshot?: (snapshot: BrowserSnapshot) => void;
}
/**
 * Execute every step in order, stopping at the first failure.
 *
 * @param session - The calling session's live browser.
 * @param steps - Steps already validated by `parseScriptSteps`.
 * @param options - Cancellation and the snapshot callback.
 * @returns What ran, what failed, and the last working snapshot.
 */
export declare function runScript(session: BrowserSession, steps: readonly ScriptStep[], options?: RunScriptOptions): Promise<ScriptRunOutcome>;
