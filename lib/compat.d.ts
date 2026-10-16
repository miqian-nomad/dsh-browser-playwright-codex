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
 * is the identity function. The *type* now comes from the harness: its brand
 * cannot be reproduced structurally, so a locally invented one produces values
 * the harness rejects (2026-10-16: enabling type checking over `tests/` caught
 * exactly that). Only the runtime identity function stays local, and a rename
 * fails loudly at build time — which is the signal we want.
 * @module dsh-browser-playwright-codex/compat
 */
import type { ToolCallId as HarnessToolCallId } from '@deepseek-ai/dsh-llm';
/**
 * Correlates one model-issued tool call with its result: the harness's own brand,
 * so values this plugin mints are accepted everywhere the harness expects one.
 */
export type ToolCallId = HarnessToolCallId;
/**
 * Brand a string as a {@link ToolCallId}. Runtime identity, exactly like the
 * harness brand constructor it replaces.
 * @param id - the provider-issued or synthesized call id.
 * @returns the same string, branded.
 */
export declare function toolCallId(id: string): ToolCallId;
/** Historical alias: the 0.1.6-and-earlier name, kept so call sites read the same. */
export declare const CallId: typeof toolCallId;
