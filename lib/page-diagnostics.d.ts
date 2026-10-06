/**
 * 失败诊断：把 Playwright 抛出的错误归类成可读的原因。
 * @module dsh-browser-playwright-codex/page-diagnostics
 */
import type { Page } from 'playwright-core';
import type { PlaywrightSession } from './session.ts';
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
/**
 * Wire bounded console/network capture onto one page, exactly once. Capture is
 * best-effort observation for the model: it must never throw into a page that is
 * otherwise healthy, and it must never grow without a bound.
 */
export declare function trackPage(session: PlaywrightSession, page: Page): void;
/** Recent console messages and uncaught page errors, newest last. */
export declare function consoleMessages(session: PlaywrightSession, args: {
    level?: string;
    limit?: number;
}): {
    url: string | null;
    level: string;
    total: number;
    returned: number;
    dropped: number;
    otherPages: number;
    note: string;
    entries: {
        n: number;
        level: string | undefined;
        text: string;
        source: string;
    }[];
};
/** Recent network requests, newest last, with status and duration where known. */
export declare function networkRequests(session: PlaywrightSession, args: {
    urlContains?: string;
    failedOnly?: boolean;
    limit?: number;
}): {
    url: string | null;
    total: number;
    returned: number;
    dropped: number;
    otherPages: number;
    note: string;
    entries: {
        n: number;
        method: string | undefined;
        url: string;
        status: number | null | undefined;
        kind: string | undefined;
        ms: number | null | undefined;
        failure: string | null | undefined;
    }[];
};
export declare function pageData(session: PlaywrightSession): Promise<unknown>;
