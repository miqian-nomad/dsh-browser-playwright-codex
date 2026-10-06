/**
 * 提取工具的辅助：容错地解析模型返回的 JSON，以及为提取请求拼装提示词。
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
