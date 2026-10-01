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
export declare const TOOL_SUFFIXES: readonly ["navigate", "snapshot", "click", "dialog", "click_at", "hover", "fill", "press", "scroll", "back", "forward", "wait", "tabs", "switch_tab", "open_tab", "close_tab", "screenshot", "extract", "evaluate", "cdp", "console_messages", "network_requests", "close"];
/** One tool name suffix. */
export type ToolSuffix = (typeof TOOL_SUFFIXES)[number];
/**
 * Suffixes registered unconditionally. They are always in the system prompt,
 * so this list is also the resident schema cost of the plugin.
 */
export declare const ALWAYS_ON_SUFFIXES: readonly ["navigate", "snapshot", "click", "dialog", "click_at", "hover", "fill", "press", "scroll", "back", "forward", "wait", "tabs", "switch_tab", "open_tab", "close_tab", "screenshot", "console_messages", "network_requests", "close"];
/**
 * Suffixes registered only when their capability is enabled (or configured):
 * a tool the deployment disabled can only error, so shipping its schema would
 * spend prompt tokens on a capability that cannot run.
 */
export declare const GATED_SUFFIXES: readonly ["extract", "evaluate", "cdp"];
/** Which gated capabilities are live for one configuration. */
export interface ToolSurfaceConfig {
    /** allowEvaluate: registers browser_evaluate when true. */
    allowEvaluate: boolean;
    /** allowCdp: registers browser_cdp when true. */
    allowCdp: boolean;
    /** extract.provider and extract.model both set: registers browser_extract. */
    extractConfigured: boolean;
    /** Force every gated tool to register even when its capability is off. */
    registerDisabledTools: boolean;
}
/** Full wire names for every tool, in registration order. */
export declare function toolNames(prefix: string): string[];
/** Suffixes this configuration actually registers, in registration order. */
export declare function registeredSuffixes(config: ToolSurfaceConfig): ToolSuffix[];
/** Full wire names this configuration registers, in registration order. */
export declare function registeredToolNames(prefix: string, config: ToolSurfaceConfig): string[];
/**
 * Stable machine-readable browser failure codes. Model-visible text never
 * keys off these strings, so tests and tools can rely on them as an API.
 */
export declare const ERROR_CODES: {
    readonly NO_PROVIDER: "NO_PROVIDER";
    readonly AMBIGUOUS_PROVIDER: "AMBIGUOUS_PROVIDER";
    readonly CONFIGURED_PROVIDER_MISSING: "CONFIGURED_PROVIDER_MISSING";
    readonly CONFIGURED_PROVIDER_UNAVAILABLE: "CONFIGURED_PROVIDER_UNAVAILABLE";
    readonly NO_BROWSER: "NO_BROWSER";
    readonly BROWSER_LAUNCH_FAILED: "BROWSER_LAUNCH_FAILED";
    readonly NAVIGATION_TIMEOUT: "NAVIGATION_TIMEOUT";
    readonly ACTION_TIMEOUT: "ACTION_TIMEOUT";
    readonly REF_NOT_FOUND: "REF_NOT_FOUND";
    readonly URL_NOT_ALLOWED: "URL_NOT_ALLOWED";
    readonly EVALUATE_DISABLED: "EVALUATE_DISABLED";
    readonly SESSION_CLOSED: "SESSION_CLOSED";
    readonly DISABLED: "DISABLED";
    readonly BROWSER_CRASHED: "BROWSER_CRASHED";
    readonly PARAM_MISSING: "PARAM_MISSING";
    readonly ELEMENT_NOT_ACTIONABLE: "ELEMENT_NOT_ACTIONABLE";
    readonly VALUE_NOT_SET: "VALUE_NOT_SET";
    readonly CLICK_TARGET_NOT_FOUND: "CLICK_TARGET_NOT_FOUND";
    readonly HOVER_TARGET_NOT_FOUND: "HOVER_TARGET_NOT_FOUND";
    readonly DIALOG_PENDING: "DIALOG_PENDING";
    readonly NO_DIALOG: "NO_DIALOG";
    readonly CDP_DISABLED: "CDP_DISABLED";
    readonly CDP_DENIED: "CDP_DENIED";
    readonly CDP_ERROR: "CDP_ERROR";
};
/** One machine-readable failure code. */
export type BrowserErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
