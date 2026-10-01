/**
 * Error thrown by every browser-capability operation. Tools surface the
 * code as structured diagnostics; the message stays model-visible prose.
 */
export class BrowserError extends Error {
    code;
    /**
     * @param code - stable machine-readable failure code.
     * @param message - non-empty human-readable failure summary.
     */
    constructor(code, message) {
        super(message);
        this.name = 'BrowserError';
        this.code = code;
    }
}
/** Wrap an unknown cause into a launch failure with the code preserved. */
export function launchFailed(cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new BrowserError('BROWSER_LAUNCH_FAILED', 'failed to launch the browser: ' + detail);
}
