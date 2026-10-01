/**
 * Boundary adapter for the branded identifiers this plugin borrows from the
 * DeepSeek Harness. The harness ships a release every few days and renames
 * freely — `CallId` became `ToolCallId`, brand constructors moved to
 * `@deepseek-ai/dsh-brand` — and a renamed identifier used to break an import
 * in the middle of the tests.
 *
 * Scope, stated honestly: this file owns the *identifier brands* (below).
 * The harness API surface this plugin uses on purpose (cordis `Context`,
 * `defineTool` / `ToolExecution`, `BlockAssembler`, `createUserMessage`) is
 * still imported directly at its call site — a rename there is a load-time
 * failure that `npm run doctor` reports as a missing export, which is the
 * signal we want rather than a silent `undefined`.
 *
 * `CallId` / `ToolCallId` are nominal wrappers over a string whose runtime body
 * is the identity function, so this plugin defines its own instead of importing
 * theirs — a harness rename cannot break it, and no version range has to be
 * chased.
 * @module dsh-browser-playwright-codex/compat
 */
/**
 * Brand a string as a {@link ToolCallId}. Runtime identity, exactly like the
 * harness brand constructor it replaces.
 * @param id - the provider-issued or synthesized call id.
 * @returns the same string, branded.
 */
export function toolCallId(id) {
    return id;
}
/** Historical alias: the 0.1.6-and-earlier name, kept so call sites read the same. */
export const CallId = toolCallId;
