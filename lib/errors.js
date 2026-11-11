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
/**
 * Normalize a `browser_evaluate` result so it survives the harness's
 * lossless-JSON output boundary.
 *
 * The harness (dsh-tools) rejects a tool result that is not losslessly
 * JSON-serializable, and it is strictest about *top-level* shape: a bare array
 * or `undefined` at the root fails its check with an opaque
 * "value is not lossless JSON" that does not tell the model how to fix it. This
 * wraps only those shapes — arrays, `undefined` and functions — into a JSON
 * string plus a marker note, and leaves every other value (objects, strings,
 * numbers, booleans, null) untouched so callers get back what their expression
 * actually returned.
 *
 * @param value - the raw value the page expression evaluated to.
 * @returns a lossless-JSON-safe value, with a note when it had to be stringified.
 */
export function normalizeEvaluateResult(value) {
    if (Array.isArray(value)) {
        return { note: 'array converted to JSON string', value: JSON.stringify(value) };
    }
    if (value === undefined) {
        return { note: 'expression returned undefined' };
    }
    if (typeof value === 'function') {
        return { note: 'function converted to string', value: String(value) };
    }
    return value;
}
