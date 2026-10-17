/**
 * 工具面类型：各工具的返回值形状（快照/标签/截图/诊断）与辅助服务接口。
 * @module dsh-browser-playwright-codex/tool-types
 */
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ChallengeTier } from './challenge-signatures.ts'
import type { DocumentResponse } from './types.ts'

/**
 * JSON value: the shape every tool value must be serializable to, so the
 * framework can put it on the wire. Declared locally because the installed
 * dsh-session build does not re-export one.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** One actionable element row as the renderer sees it. */
export interface SnapshotValue {
  url: string
  title: string
  refs: number
  truncated: boolean
  tree: string
}

/** One open tab row as the renderer sees it. */
export interface TabRow {
  index: number
  url: string
  title: string
  active: boolean
}

/** Canonical value of browser_tabs. */
export interface TabsValue {
  tabs: TabRow[]
}

/** Canonical value of browser_screenshot. */
export interface ScreenshotValue {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  url: string
}

/** Minimal node shape the challenge detector walks. */
export interface ChallengeNode {
  readonly name?: string
  /** Accessible role. Both built-in engines provide one; it gates the wording tier. */
  readonly role?: string
  readonly children?: readonly ChallengeNode[]
}

/** The slice of a snapshot the challenge detector reads. */
export interface ChallengeSnapshot {
  readonly title?: string
  readonly url?: string
  readonly nodes?: readonly ChallengeNode[]
  /**
   * Actionable-element count. The wording tier uses it to tell a challenge page
   * (nothing to click) from an ordinary page whose *title* merely contains the
   * phrase — searching Baidu for "安全验证" produces exactly that false positive.
   */
  readonly refs?: number
  /** Main document response metadata; absent when no navigation response was seen. */
  readonly response?: DocumentResponse
}

/** What the challenge detector reports when a page is an anti-bot wall. */
export interface ChallengeMatch {
  engine: string
  hint: string
  /** How it was proven, strongest first. */
  tier: ChallengeTier
  /** The concrete signal that fired, so a reader can judge the call instead of trusting it. */
  evidence: string
}

/** The attachments-service face consumed at execution time. */
export interface AttachmentServiceLike {
  saveImage(input: { data: Uint8Array; mediaType: string; name: string }): Promise<SavedImageRef>
}

/** Durable reference returned by the attachment store. */
export interface SavedImageRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
}

/** The llm-service face consumed at execution time. */
export interface LlmServiceLike {
  stream(options: unknown): AsyncIterable<StreamChunk>
}

/** Optional service faces consumed at execution time. */
export interface OptionalServices {
  attachments?: AttachmentServiceLike
  llm?: LlmServiceLike
}
