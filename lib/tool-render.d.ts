/**
 * tool-render：从 tool.ts 拆出的一部分（纯搬运，行为不变）。
 * @module dsh-browser-playwright-codex/tool-render
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { BrowserSnapshot, DiagnosticsValue } from './types.ts';
import type { SnapshotValue, ScreenshotValue, TabsValue } from './tool-types.ts';
/**
 * Render one diagnostics payload as one line per entry. Diagnostics are read when
 * something already looks wrong, so the compact form matters more than the rich
 * one: the model needs the level, the message and the source, not a JSON tree.
 */
export declare function renderDiagnostics(kind: string, value: DiagnosticsValue): string;
/** Project a provider snapshot into its canonical tool value. */
export declare function snapshotValue(snapshot: BrowserSnapshot): SnapshotValue;
/** Render a snapshot value as one text block. */
export declare function renderSnapshotValue(_args: unknown, value: SnapshotValue): ContentBlock[];
export declare function renderTabsValue(_args: unknown, value: TabsValue): ContentBlock[];
/** Render a screenshot as its summary plus the image block itself. */
export declare function renderScreenshotValue(_args: unknown, value: ScreenshotValue): ContentBlock[];
