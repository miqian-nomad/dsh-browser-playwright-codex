/**
 * Error taxonomy for the browser capability. Every failure the model can
 * encounter carries a stable, provider-neutral code plus a human-readable
 * message; tools translate these onto the wire without exposing internals.
 * The code list lives in `contract.ts` so registration, tests and the verify
 * script share one source of truth.
 * @module dsh-browser-playwright-codex/errors
 */
import type { BrowserErrorCode } from './contract.ts'

/** Stable machine-readable browser failure codes. */
export type { BrowserErrorCode }

/**
 * Error thrown by every browser-capability operation. Tools surface the
 * code as structured diagnostics; the message stays model-visible prose.
 */
export class BrowserError extends Error {
  readonly code: BrowserErrorCode

  /**
   * @param code - stable machine-readable failure code.
   * @param message - non-empty human-readable failure summary.
   */
  constructor(code: BrowserErrorCode, message: string) {
    super(message)
    this.name = 'BrowserError'
    this.code = code
  }
}

/** Wrap an unknown cause into a launch failure with the code preserved. */
export function launchFailed(cause: unknown): BrowserError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new BrowserError('BROWSER_LAUNCH_FAILED', 'failed to launch the browser: ' + detail)
}
