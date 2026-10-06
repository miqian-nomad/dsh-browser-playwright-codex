/**
 * Model-facing browser tool family: navigate, snapshot with refs, click,
 * hover, fill, press, scroll, history, tabs, screenshot, extract, evaluate,
 * close.
 * Every tool acquires the calling session's browser through ctx.browser, so
 * the browser persists across calls. Persistent mode shares one profile-backed
 * window across sessions (personal-browser style). Outputs follow the
 * canonical-value + pure-render contract.
 * @module dsh-browser-playwright-codex/tool
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { detectChallenge } from './challenge.ts';
export { detectChallenge };
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "browser-tool";
/** The browser runtime and tool registry this plugin consumes. */
export declare const inject: string[];
/** Configuration for the browser tool family. */
export interface ToolConfig {
    /** Tool name prefix; final names are <prefix>navigate and so on. */
    toolPrefix: string;
    /** Allow browser_evaluate (arbitrary page JavaScript). Defaults to false. */
    allowEvaluate: boolean;
    /** Allow raw CDP inspection commands. Defaults to false. */
    allowCdp: boolean;
    /**
     * Register the gated tools (evaluate, cdp, extract) even when their
     * capability is off, so the model can discover them and read the error that
     * names the switch. Defaults to false: a disabled tool can only error, and
     * its schema would sit in the system prompt on every turn for nothing.
     */
    registerDisabledTools: boolean;
    /** Upper bound for browser_wait in milliseconds. */
    maxWaitMs: number;
    /** Default value of the snapshot tool's interactiveOnly flag. */
    interactiveOnlyDefault: boolean;
    /** Auxiliary extraction configuration; omitted means browser_extract is unconfigured. */
    extract?: {
        provider?: string;
        model?: string;
        maxInputChars: number;
        maxOutputTokens: number;
    };
}
/** Schemastery validation for {@link ToolConfig}. */
export declare const Config: z<ToolConfig>;
/**
 * Register the browser tool family on ctx.tools.
 * @param ctx - plugin context carrying browser, tools, and the optional services.
 * @param config - tool naming and safety configuration.
 */
export declare function apply(ctx: Context, config: ToolConfig): void;
