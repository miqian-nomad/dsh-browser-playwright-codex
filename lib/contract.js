/**
 * The browser capability's wire contract in one place: the tool names it
 * registers and the failure codes it can raise. Registration, the load-time
 * guard, the regression suites and the standalone verify script all read this
 * module, so a renamed tool or a changed code cannot drift apart silently.
 * @module dsh-browser-playwright-codex/contract
 */
/**
 * Tool name suffixes in registration order; a wire name is `prefix + suffix`.
 * Gated suffixes are kept in the same list so the full surface stays visible.
 */
export const TOOL_SUFFIXES = [
    'navigate',
    'snapshot',
    'click',
    'dialog',
    'click_at',
    'hover',
    'fill',
    'press',
    'scroll',
    'back',
    'forward',
    'wait',
    'tabs',
    'switch_tab',
    'open_tab',
    'close_tab',
    'screenshot',
    'extract',
    'evaluate',
    'cdp',
    'console_messages',
    'network_requests',
    'close',
];
/**
 * Suffixes registered unconditionally. They are always in the system prompt,
 * so this list is also the resident schema cost of the plugin.
 */
export const ALWAYS_ON_SUFFIXES = [
    'navigate',
    'snapshot',
    'click',
    'dialog',
    'click_at',
    'hover',
    'fill',
    'press',
    'scroll',
    'back',
    'forward',
    'wait',
    'tabs',
    'switch_tab',
    'open_tab',
    'close_tab',
    'screenshot',
    'console_messages',
    'network_requests',
    'close',
];
/**
 * Suffixes registered only when their capability is enabled (or configured):
 * a tool the deployment disabled can only error, so shipping its schema would
 * spend prompt tokens on a capability that cannot run.
 */
export const GATED_SUFFIXES = ['extract', 'evaluate', 'cdp'];
/** Full wire names for every tool, in registration order. */
export function toolNames(prefix) {
    return TOOL_SUFFIXES.map((suffix) => prefix + suffix);
}
/** Suffixes this configuration actually registers, in registration order. */
export function registeredSuffixes(config) {
    const live = new Set(ALWAYS_ON_SUFFIXES);
    if (config.allowEvaluate || config.registerDisabledTools)
        live.add('evaluate');
    if (config.allowCdp || config.registerDisabledTools)
        live.add('cdp');
    if (config.extractConfigured || config.registerDisabledTools)
        live.add('extract');
    return TOOL_SUFFIXES.filter((suffix) => live.has(suffix));
}
/** Full wire names this configuration registers, in registration order. */
export function registeredToolNames(prefix, config) {
    return registeredSuffixes(config).map((suffix) => prefix + suffix);
}
/**
 * Stable machine-readable browser failure codes. Model-visible text never
 * keys off these strings, so tests and tools can rely on them as an API.
 */
export const ERROR_CODES = {
    NO_PROVIDER: 'NO_PROVIDER',
    AMBIGUOUS_PROVIDER: 'AMBIGUOUS_PROVIDER',
    CONFIGURED_PROVIDER_MISSING: 'CONFIGURED_PROVIDER_MISSING',
    CONFIGURED_PROVIDER_UNAVAILABLE: 'CONFIGURED_PROVIDER_UNAVAILABLE',
    NO_BROWSER: 'NO_BROWSER',
    BROWSER_LAUNCH_FAILED: 'BROWSER_LAUNCH_FAILED',
    NAVIGATION_TIMEOUT: 'NAVIGATION_TIMEOUT',
    ACTION_TIMEOUT: 'ACTION_TIMEOUT',
    REF_NOT_FOUND: 'REF_NOT_FOUND',
    URL_NOT_ALLOWED: 'URL_NOT_ALLOWED',
    EVALUATE_DISABLED: 'EVALUATE_DISABLED',
    SESSION_CLOSED: 'SESSION_CLOSED',
    DISABLED: 'DISABLED',
    BROWSER_CRASHED: 'BROWSER_CRASHED',
    PARAM_MISSING: 'PARAM_MISSING',
    ELEMENT_NOT_ACTIONABLE: 'ELEMENT_NOT_ACTIONABLE',
    VALUE_NOT_SET: 'VALUE_NOT_SET',
    CLICK_TARGET_NOT_FOUND: 'CLICK_TARGET_NOT_FOUND',
    HOVER_TARGET_NOT_FOUND: 'HOVER_TARGET_NOT_FOUND',
    DIALOG_PENDING: 'DIALOG_PENDING',
    NO_DIALOG: 'NO_DIALOG',
    CDP_DISABLED: 'CDP_DISABLED',
    CDP_DENIED: 'CDP_DENIED',
    CDP_ERROR: 'CDP_ERROR',
};
