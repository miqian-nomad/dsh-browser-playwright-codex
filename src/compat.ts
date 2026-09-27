/**
 * Boundary adapter for the DeepSeek Harness packages this plugin links
 * against. The harness ships a release every few days and renames its
 * internals freely (`CallId` became `ToolCallId`, brand constructors moved to
 * `@deepseek-ai/dsh-brand`), so every borrowed name lives here instead of
 * being imported at each call site: when a rename lands, exactly one file
 * changes.
 *
 * Prefer owning the value outright. `CallId` / `ToolCallId` are nominal
 * wrappers over a string whose runtime body is the identity function, so this
 * plugin defines its own instead of importing theirs — a harness rename can no
 * longer break it, and no version range has to be chased.
 * @module dsh-browser-playwright/compat
 */

/**
 * Correlates one model-issued tool call with its result. Structurally
 * compatible with the harness brand, owned by this plugin so the harness
 * cannot rename it out from under the tests.
 */
export type ToolCallId = string & { readonly __brand?: 'ToolCallId' }

/**
 * Brand a string as a {@link ToolCallId}. Runtime identity, exactly like the
 * harness brand constructor it replaces.
 * @param id - the provider-issued or synthesized call id.
 * @returns the same string, branded.
 */
export function toolCallId(id: string): ToolCallId {
  return id as ToolCallId
}

/** Historical alias: the 0.1.6-and-earlier name, kept so call sites read the same. */
export const CallId = toolCallId

/**
 * Branded-identifier constructors the harness may or may not export yet. Each
 * falls back to the identity function, so a missing (or renamed) export can
 * never fail an import again.
 */
export const MessageId = toolCallId
/** Provider-issued request identifier, used for diagnostics only. */
export const ProviderRequestId = toolCallId
/** One model streaming attempt within an agent lifecycle. */
export const LlmAttemptId = toolCallId

/**
 * Read one optional export off a harness module without a static named
 * import. A named import of a missing export fails at load time; a namespace
 * probe returns `undefined` instead, which is what "the harness renamed this"
 * should look like.
 * @param module - the namespace object to probe.
 * @param name - the export name to look for.
 * @returns the export when present, otherwise undefined.
 */
export function optionalExport<T>(module: Record<string, unknown>, name: string): T | undefined {
  return module[name] as T | undefined
}
