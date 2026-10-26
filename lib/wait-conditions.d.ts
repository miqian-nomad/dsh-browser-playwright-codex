import type { PlaywrightSession } from './session.ts';
import type { WaitCondition, WaitOutcome } from './types.ts';
/** Timeout used when the caller does not pass `timeoutMs`. */
export declare const DEFAULT_WAIT_TIMEOUT_MS = 15000;
/**
 * Absolute ceiling for a goal wait at the session layer. The tool clamps to
 * `tool.maxWaitMs` first; this only stops a programmatic caller from parking a
 * session for an hour on a selector that will never appear.
 */
export declare const SESSION_WAIT_CAP_MS = 120000;
/** One validated wait, ready to run. */
export type NormalizedWait = {
    readonly kind: 'ms';
    readonly ms: number;
} | {
    readonly kind: 'selector';
    readonly selector: string;
    readonly timeoutMs: number;
} | {
    readonly kind: 'text';
    readonly text: string;
    readonly timeoutMs: number;
} | {
    readonly kind: 'networkIdle';
    readonly timeoutMs: number;
};
/**
 * Validate and normalize one wait request.
 *
 * Exactly one condition is allowed per call. Accepting several would make the
 * composed semantics ("all of them? in which order? what if the first never
 * comes?") something the model has to guess, and the tool description would
 * have to grow to explain it.
 *
 * @param condition - what the caller asked for
 * @param maxWaitMs - deployment cap (`tool.maxWaitMs`)
 * @returns the validated wait
 * @throws Error with an actionable message when the request is malformed
 */
export declare function normalizeWaitCondition(condition: WaitCondition, maxWaitMs: number): NormalizedWait;
/** Human name of what a normalized wait is waiting for. */
export declare function describeWait(wait: NormalizedWait): string;
/**
 * Run one validated wait against the session's active page.
 *
 * A timeout is reported as `ACTION_TIMEOUT` naming what was awaited: the model
 * then knows the page is still working rather than that its action failed, and
 * its next move is a snapshot instead of a blind retry.
 *
 * @param session - the session whose active page to wait on
 * @param wait - a value from {@link normalizeWaitCondition}
 * @param signal - abort signal from the tool call
 * @returns what was waited for and how long it took
 */
export declare function waitForCondition(session: PlaywrightSession, wait: NormalizedWait, signal?: AbortSignal): Promise<WaitOutcome>;
