/**
 * extract：从 tool.ts 拆出的一部分（纯搬运，行为不变）。
 * @module dsh-browser-playwright-codex/extract
 */
import type { JsonValue } from './tool-types.ts';
/** Strip markdown fences and whitespace, then parse one JSON document. */
export declare function parseJsonText(raw: string): JsonValue;
/**
 * Prompt template for structured page extraction. `maxInputChars` bounds the page
 * data handed to the auxiliary model — that model is billed on this prompt, so an
 * unbounded page is a tax on every extraction.
 */
export declare function extractionPrompt(instruction: string, data: unknown, maxInputChars: number): string;
