/**
 * 失败诊断：把 Playwright 抛出的错误归类成可读的原因。
 * @module dsh-browser-playwright-codex/page-diagnostics
 */
import { BrowserError } from "./errors.js";
/** Serialize a Playwright timeout into a stable browser error. Code is
 * prefixed on the message so the model sees a stable machine-readable label. */
export function asTimeoutError(kind, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (kind === 'navigation')
        return new BrowserError('NAVIGATION_TIMEOUT', '[NAVIGATION_TIMEOUT] the browser operation timed out: ' + detail);
    return new BrowserError('ACTION_TIMEOUT', '[ACTION_TIMEOUT] the browser action timed out: ' + detail);
}
/** Whether an error is a caller-initiated abort, which must propagate untouched. */
export function isAbortError(error) {
    return error instanceof DOMException && error.name === 'AbortError';
}
/** Whether a Playwright failure is a mid-evaluate navigation race. */
export function isContextDestroyed(error) {
    return error instanceof Error && /Execution context was destroyed/.test(error.message);
}
/** Whether a failure means the browser or its page died and must be relaunched. */
export function isCrashError(error) {
    if (!(error instanceof Error))
        return false;
    return /browser has disconnected|has been closed|Target closed|Target crashed|ProcessSingleton|Session closed|Cannot access object .* destroyed|The page .* was closed/i.test(error.message);
}
