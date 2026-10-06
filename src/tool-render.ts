/**
 * tool-render：从 tool.ts 拆出的一部分（纯搬运，行为不变）。
 * @module dsh-browser-playwright-codex/tool-render
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { BrowserSnapshot, DiagnosticsValue } from './types.ts'
import type { SnapshotValue, ScreenshotValue, TabsValue } from './tool-types.ts'
import { CHALLENGE_NOTE, detectChallenge } from './challenge.ts'
import { renderSnapshot, renderSnapshotDiff } from './snapshot-render.ts'

/**
 * Render one diagnostics payload as one line per entry. Diagnostics are read when
 * something already looks wrong, so the compact form matters more than the rich
 * one: the model needs the level, the message and the source, not a JSON tree.
 */
export function renderDiagnostics(kind: string, value: DiagnosticsValue): string {
  if (value === null || typeof value !== 'object') return String(value)
  const label =
    kind === 'console'
      ? 'console (' + String(value.returned) + '/' + String(value.total) + ' shown, level=' + String(value.level) + ')'
      : 'network (' + String(value.returned) + '/' + String(value.total) + ' shown)'
  const lines = [label + (value.url === null ? '' : ' @ ' + String(value.url))]
  if ((value.dropped ?? 0) > 0) lines.push('[' + String(value.dropped) + ' older entries evicted]')
  // Scope disclosure. Without this line an empty result looks like "the page is
  // quiet" even when another tab of the shared window is throwing: that is how a
  // model ends up diagnosing a page it is not even looking at.
  if ((value.otherPages ?? 0) > 0)
    lines.push(
      '[' +
        String(value.otherPages) +
        ' matching ' +
        (kind === 'console' ? 'entries' : 'requests') +
        ' from other tabs of the same window not shown — this reports only the tab this session is driving]',
    )
  const entries = value.entries ?? []
  for (const entry of entries) {
    if (kind === 'console') {
      lines.push(
        '#' +
          String(entry.n) +
          ' [' +
          String(entry.level) +
          '] ' +
          String(entry.text) +
          (entry.source ? '  <- ' + String(entry.source) : ''),
      )
    } else {
      const outcome =
        entry.failure !== null && entry.failure !== undefined
          ? 'FAILED ' + String(entry.failure)
          : String(entry.status === null ? 'pending' : entry.status)
      lines.push(
        '#' +
          String(entry.n) +
          ' ' +
          String(entry.method) +
          ' ' +
          outcome +
          ' ' +
          String(entry.kind) +
          (entry.ms === null ? '' : ' ' + String(entry.ms) + 'ms') +
          ' ' +
          String(entry.url),
      )
    }
  }
  if (entries.length === 0) lines.push('(nothing captured yet)')
  return lines.join('\n')
}

/** Project a provider snapshot into its canonical tool value. */
export function snapshotValue(snapshot: BrowserSnapshot): SnapshotValue {
  const challenge = detectChallenge(snapshot)
  const tree = renderSnapshot(snapshot)
  const notes = []
  const dialog = snapshot.dialogNote
  if (dialog !== undefined && dialog !== '') notes.push(dialog)
  const landing = snapshot.landingNote
  if (landing !== undefined && landing !== '') notes.push(landing)
  // Engine fallback disclosure. The user explicitly chose a page-reading mode in
  // Settings; when the provider has to serve the other engine's tree, saying so
  // is the difference between a checked assumption and a silent one.
  const engine = snapshot.engineNote
  if (engine !== undefined && engine !== '') notes.push('[page reader] ' + engine)
  const head = notes.length > 0 ? notes.join('\n\n') + '\n\n' : ''
  // Incremental diff rides along when the provider computed one (snapshot.diff).
  const diffBlock = snapshot.diff !== undefined ? '\n\n' + renderSnapshotDiff(snapshot.diff) : ''
  return {
    url: snapshot.url,
    title: snapshot.title,
    refs: snapshot.totalRefs,
    truncated: snapshot.truncated,
    tree:
      head +
      (challenge === null ? tree : challenge.engine + ': ' + challenge.hint + '.\n' + CHALLENGE_NOTE + '\n\n' + tree) +
      diffBlock,
  }
}

/** Render a snapshot value as one text block. */
export function renderSnapshotValue(_args: unknown, value: SnapshotValue): ContentBlock[] {
  return [{ type: 'text', text: value.tree }]
}

export function renderTabsValue(_args: unknown, value: TabsValue): ContentBlock[] {
  if (value.tabs.length === 0) return [{ type: 'text', text: 'No open tabs.' }]
  const lines = value.tabs.map(
    (tab) => String(tab.index) + '.' + (tab.active ? ' [active]' : '') + ' ' + (tab.title || tab.url),
  )
  return [{ type: 'text', text: lines.join('\n') }]
}

const SCREENSHOT_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
} as const

/** Render a screenshot as its summary plus the image block itself. */
export function renderScreenshotValue(_args: unknown, value: ScreenshotValue): ContentBlock[] {
  // The attachment store normalizes a capture before storing it: a metadata-carrying PNG
  // is re-encoded to JPEG (no alpha) or WebP (alpha). The durable reference must therefore
  // carry the media type the store returned -- hardcoding 'image/png' here makes every
  // later request containing this message fail with ATTACHMENT_CORRUPT before the model
  // call is even attempted (surfacing as a bogus transport error).
  const mediaType = typeof value.mediaType === 'string' && value.mediaType.length > 0 ? value.mediaType : 'image/png'
  const summary =
    'Screenshot of ' +
    value.url +
    ': ' +
    value.width +
    'x' +
    value.height +
    ' px, ' +
    value.bytes +
    ' bytes (' +
    mediaType.slice('image/'.length).toUpperCase() +
    ' attachment).'
  // The store brands its id and media type; the canonical value carries plain
  // strings, so the assertion happens once, here, at the boundary.
  const attachment = {
    attachmentId: value.attachmentId,
    mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    name: 'browser-screenshot' + (SCREENSHOT_EXTENSIONS[mediaType] ?? '.png'),
  } as Extract<ContentBlock, { type: 'image' }>['attachment']
  return [
    { type: 'text', text: summary },
    { type: 'image', attachment },
  ]
}
