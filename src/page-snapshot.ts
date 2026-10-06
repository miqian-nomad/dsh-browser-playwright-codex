/**
 * 页面快照：识别模式选择、ref 签名与快照差异计算。
 * @module dsh-browser-playwright-codex/page-snapshot
 */
import { getSnapshotEngine } from './runtime-state.ts'
import type { SnapshotDiffEntry } from './types.ts'

/**
 * Which page-reading mode a capture uses. The user's choice on the settings page
 * (Settings → 浏览器 → 页面识别方式) wins over the deployment default, so flipping
 * that switch changes the very next operation — no restart, no config edit.
 * @param configured - the mode from this provider's config.
 * @returns the effective mode.
 */
export function resolveSnapshotEngine(configured: 'legacy' | 'aria'): 'legacy' | 'aria' {
  return getSnapshotEngine() ?? configured
}

/** Feature fingerprint of one ref-bearing node, for cross-snapshot diffing. */
export interface RefSignature {
  role?: string
  name?: string
  level?: number
  checked?: boolean
  selected?: boolean
  disabled?: boolean
  href?: string
  parentRef?: string
}

/** Feature flags carried by an added diff entry. */
export function flagsOf(sig: RefSignature): string[] {
  const flags: string[] = []
  if (sig.checked === true) flags.push('checked')
  if (sig.selected === true) flags.push('selected')
  if (sig.disabled === true) flags.push('disabled')
  if (sig.level !== undefined) flags.push('level=' + String(sig.level))
  if (sig.href !== undefined) flags.push('href=' + sig.href)
  return flags
}

/** Flag keys whose value changed between two signatures. */
export function flagsDeltaOf(before: RefSignature, after: RefSignature): string[] {
  const delta: string[] = []
  const keys = ['checked', 'selected', 'disabled', 'level', 'href'] as const
  for (const key of keys) {
    const b = before[key]
    const a = after[key]
    if (String(b ?? '') === String(a ?? '')) continue
    delta.push(
      a !== undefined && a !== false
        ? key === 'level'
          ? 'level=' + String(a)
          : key === 'href'
            ? 'href=' + a
            : key
        : key,
    )
  }
  return delta
}

/** Build a SnapshotDiffEntry, dropping undefined optionals (exactOptionalPropertyTypes). */
export function diffEntry(input: {
  ref: string
  role?: string | undefined
  name?: string | undefined
  flags?: string[] | undefined
  flagsDelta?: string[] | undefined
  parentRef?: string | undefined
}): SnapshotDiffEntry {
  const out: {
    ref: string
    role?: string | undefined
    name?: string | undefined
    flags?: string[] | undefined
    flagsDelta?: string[] | undefined
    parentRef?: string | undefined
  } = { ref: input.ref }
  if (input.role !== undefined) out.role = input.role
  if (input.name !== undefined) out.name = input.name
  if (input.flags !== undefined) out.flags = input.flags
  if (input.flagsDelta !== undefined) out.flagsDelta = input.flagsDelta
  if (input.parentRef !== undefined) out.parentRef = input.parentRef
  return out as SnapshotDiffEntry
}
