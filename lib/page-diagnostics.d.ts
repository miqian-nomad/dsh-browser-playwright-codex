/**
 * 失败诊断：把 Playwright 抛出的错误归类成可读的原因。
 * @module dsh-browser-playwright-codex/page-diagnostics
 */
import { BrowserError } from './errors.ts';
/** Serialize a Playwright timeout into a stable browser error. Code is
 * prefixed on the message so the model sees a stable machine-readable label. */
export declare function asTimeoutError(kind: string, cause: unknown): BrowserError;
/** Whether an error is a caller-initiated abort, which must propagate untouched. */
export declare function isAbortError(error: unknown): boolean;
/** Whether a Playwright failure is a mid-evaluate navigation race. */
export declare function isContextDestroyed(error: unknown): boolean;
/** Whether a failure means the browser or its page died and must be relaunched. */
export declare function isCrashError(error: unknown): boolean;
