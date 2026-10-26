/**
 * Error taxonomy for the browser capability. Every failure the model can
 * encounter carries a stable, provider-neutral code plus a human-readable
 * message; tools translate these onto the wire without exposing internals.
 * The code list lives in `contract.ts` so registration, tests and the verify
 * script share one source of truth.
 * @module dsh-browser-playwright-codex/errors
 */
import type { BrowserErrorCode } from './contract.ts';
/** Stable machine-readable browser failure codes. */
export type { BrowserErrorCode };
/**
 * Error thrown by every browser-capability operation. Tools surface the
 * code as structured diagnostics; the message stays model-visible prose.
 */
export declare class BrowserError extends Error {
    readonly code: BrowserErrorCode;
    /**
     * @param code - stable machine-readable failure code.
     * @param message - non-empty human-readable failure summary.
     */
    constructor(code: BrowserErrorCode, message: string);
}
/** Wrap an unknown cause into a launch failure with the code preserved. */
export declare function launchFailed(cause: unknown): BrowserError;
/**
 * "browser_evaluate is switched off". One wording, thrown by both layers that
 * enforce it: the tool layer (before a browser is even launched) and the
 * session itself (so a programmatic caller cannot go around the switch).
 * @returns the denial, ready to throw.
 */
export declare function evaluateDisabled(): BrowserError;
/**
 * "browser_cdp is switched off". Same two-layer rule as {@link evaluateDisabled}.
 * @returns the denial, ready to throw.
 */
export declare function cdpDisabled(): BrowserError;
