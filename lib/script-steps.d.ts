/**
 * One saved browser script: a short, deterministic list of steps that a first
 * successful run left behind, so a repeat run costs one tool call instead of a
 * snapshot round-trip per action.
 *
 * Why a step list and not generated code: every mature runner in this space
 * separates "explore once" from "replay deterministically" — Stagehand caches
 * the resolved action and replays it with self-healing off, browser-use's
 * workflow-use records a workflow with variables, and Playwright MCP ships its
 * only batch entry point as `browser_run_code_unsafe`, behind an explicit
 * "unsafe" name. A step list keeps the validation the individual tools already
 * have (URL policy, ref freshness, credential refusal) that generated code
 * would walk around.
 *
 * Pure: no I/O, no browser, no clock. The runner and the store stay separate so
 * this module can be tested on its own.
 * @module dsh-browser-playwright-codex/script-steps
 */
import type { LoadState } from './types.ts';
/** How a step names the element it acts on. */
export interface ScriptTarget {
    /** Ref from the snapshot the previous step returned. Stale after a navigation. */
    ref?: string;
    /** Visible label, matched against the current snapshot's accessible names. */
    text?: string;
}
/** One deterministic step. */
export type ScriptStep = {
    action: 'navigate';
    url: string;
    waitFor?: LoadState;
} | {
    action: 'snapshot';
} | {
    action: 'click';
    target: ScriptTarget;
} | {
    action: 'fill';
    target: ScriptTarget;
    value: string;
} | {
    action: 'press';
    target: ScriptTarget;
    key: string;
} | {
    action: 'hover';
    target: ScriptTarget;
} | {
    action: 'scroll';
    direction: 'up' | 'down';
    amount: number;
    target?: ScriptTarget;
} | {
    action: 'back';
} | {
    action: 'forward';
} | {
    action: 'wait';
    ms?: number;
    text?: string;
    selector?: string;
    networkIdle?: boolean;
    /** Wait until the page URL contains this substring — the only condition a “did the click navigate” check can trust. */
    urlContains?: string;
};
/** Upper bound on the steps one script may carry. A longer list is a loop, not a script. */
export declare const MAX_SCRIPT_STEPS = 40;
/** Step actions this version understands. */
export declare const SCRIPT_ACTIONS: readonly ["navigate", "snapshot", "click", "fill", "press", "hover", "scroll", "back", "forward", "wait"];
/** Default scroll distance when a scroll step omits `amount`. */
export declare const DEFAULT_SCROLL_AMOUNT = 600;
/** Upper bound on one scroll step's distance, so a typo cannot jump to the page end. */
export declare const MAX_SCROLL_AMOUNT = 20000;
/** One step action name. */
export type ScriptAction = (typeof SCRIPT_ACTIONS)[number];
/** Raised for a malformed script; the message names the offending step. */
export declare class ScriptStepError extends Error {
    /** Index of the offending step, 1-based as the model sees them. */
    readonly step: number;
    constructor(step: number, message: string);
}
/**
 * Validate and normalise a script's steps.
 *
 * Throws {@link ScriptStepError} on the first bad step rather than collecting
 * everything: a script runs as a unit, so the first error is the one that
 * matters, and a partial list would read as if the rest were fine.
 *
 * @param raw - Steps exactly as the model sent them.
 * @param maxSteps - Upper bound; a long list is a sign the model meant a loop.
 * @returns The normalised steps.
 */
export declare function parseScriptSteps(raw: unknown, maxSteps: number): ScriptStep[];
/** One line per step, for logs and for the model's summary. */
export declare function describeStep(step: ScriptStep): string;
