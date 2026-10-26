/**
 * Goal-directed waits behind `browser_wait`.
 *
 * The original tool could only sleep for a fixed number of milliseconds, which
 * forces the model to guess: too short and the click lands on a half-rendered
 * page, too long and every call burns wall-clock time for nothing. These three
 * conditions replace the guess with the actual thing being waited for:
 *
 * - `selector`: an element matching a CSS selector becomes visible
 * - `text`:     visible text containing a string appears
 * - `networkIdle`: the page stops issuing requests for 500ms
 *
 * `ms` stays supported exactly as before, so every existing call keeps working
 * (`session.wait(ms)` is untouched; this is a separate entry point).
 *
 * Validation is separate from execution on purpose: a malformed call must fail
 * before a browser is launched.
 *
 * @module dsh-browser-playwright-codex/wait-conditions
 */
import { BrowserError } from "./errors.js";
import { withAbort } from "./page-actions.js";
/** Timeout used when the caller does not pass `timeoutMs`. */
export const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
/**
 * Absolute ceiling for a goal wait at the session layer. The tool clamps to
 * `tool.maxWaitMs` first; this only stops a programmatic caller from parking a
 * session for an hour on a selector that will never appear.
 */
export const SESSION_WAIT_CAP_MS = 120_000;
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
export function normalizeWaitCondition(condition, maxWaitMs) {
    const given = [
        condition.ms === undefined ? undefined : 'ms',
        condition.selector === undefined ? undefined : 'selector',
        condition.text === undefined ? undefined : 'text',
        condition.networkIdle === true ? 'networkIdle' : undefined,
    ].filter((name) => name !== undefined);
    if (given.length === 0) {
        throw new Error('browser_wait: pass one of ms, selector, text or networkIdle — sleeping without a condition is the guess this tool exists to remove');
    }
    if (given.length > 1) {
        throw new Error('browser_wait: pass only one condition per call (received ' +
            given.join(', ') +
            '); call it again for the next one');
    }
    const cap = Math.max(1, Math.floor(maxWaitMs));
    if (condition.ms !== undefined) {
        if (!Number.isSafeInteger(condition.ms) || condition.ms <= 0 || condition.ms > cap) {
            throw new Error('browser_wait: ms must be a positive integer no larger than ' + String(cap));
        }
        return { kind: 'ms', ms: condition.ms };
    }
    const requested = condition.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    if (!Number.isSafeInteger(requested) || requested <= 0) {
        throw new Error('browser_wait: timeoutMs must be a positive integer');
    }
    const timeoutMs = Math.min(requested, cap);
    if (condition.selector !== undefined) {
        const selector = condition.selector.trim();
        if (selector === '')
            throw new Error('browser_wait: selector must not be empty');
        return { kind: 'selector', selector, timeoutMs };
    }
    if (condition.text !== undefined) {
        const text = condition.text.trim();
        if (text === '')
            throw new Error('browser_wait: text must not be empty');
        return { kind: 'text', text, timeoutMs };
    }
    return { kind: 'networkIdle', timeoutMs };
}
/** Human name of what a normalized wait is waiting for. */
export function describeWait(wait) {
    switch (wait.kind) {
        case 'ms':
            return 'a fixed ' + String(wait.ms) + 'ms';
        case 'selector':
            return 'selector ' + JSON.stringify(wait.selector) + ' to become visible';
        case 'text':
            return 'text ' + JSON.stringify(wait.text) + ' to become visible';
        case 'networkIdle':
            return 'the network to go idle (no request for 500ms)';
    }
}
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
export async function waitForCondition(session, wait, signal) {
    const started = Date.now();
    return session.run(async () => {
        session.provider.touch(session.owner);
        if (wait.kind === 'ms') {
            await withAbort(new Promise((resolve) => setTimeout(resolve, wait.ms)), signal);
            return { waitedFor: describeWait(wait), elapsedMs: Date.now() - started };
        }
        const page = await session.ensurePage();
        try {
            if (wait.kind === 'selector') {
                await withAbort(page.waitForSelector(wait.selector, { state: 'visible', timeout: wait.timeoutMs }), signal);
            }
            else if (wait.kind === 'text') {
                await withAbort(page.getByText(wait.text).first().waitFor({ state: 'visible', timeout: wait.timeoutMs }), signal);
            }
            else {
                await withAbort(page.waitForLoadState('networkidle', { timeout: wait.timeoutMs }), signal);
            }
        }
        catch (error) {
            if (signal?.aborted === true)
                throw error;
            throw new BrowserError('ACTION_TIMEOUT', 'wait timed out after ' +
                String(wait.timeoutMs) +
                'ms waiting for ' +
                describeWait(wait) +
                '; the page may still be loading — take a snapshot to see where it stands instead of retrying blind');
        }
        return { waitedFor: describeWait(wait), elapsedMs: Date.now() - started };
    });
}
