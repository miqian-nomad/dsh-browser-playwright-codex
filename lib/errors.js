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
/**
 * "browser_evaluate is switched off". One wording, thrown by both layers that
 * enforce it: the tool layer (before a browser is even launched) and the
 * session itself (so a programmatic caller cannot go around the switch).
 * @returns the denial, ready to throw.
 */
export function evaluateDisabled() {
    return new BrowserError('EVALUATE_DISABLED', "browser_evaluate is disabled; set tool.allowEvaluate: true on the single '- id: browser' row of cordis.patch.yml (the Settings card rewrites that row for you) to enable arbitrary page JavaScript");
}
/**
 * "browser_cdp is switched off". Same two-layer rule as {@link evaluateDisabled}.
 * @returns the denial, ready to throw.
 */
export function cdpDisabled() {
    return new BrowserError('CDP_DISABLED', "browser_cdp is disabled; set tool.allowCdp: true on the single '- id: browser' row of cordis.patch.yml (the Settings card rewrites that row for you) to enable raw CDP inspection commands");
}
