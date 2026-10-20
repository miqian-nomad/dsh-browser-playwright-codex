/**
 * Cache-residue scanning and cleaning for the Settings card.
 *
 * Design rules (these are the safety boundary, not implementation details):
 * - **Targets are enum ids, never paths.** The caller can only ask for
 *   `browser-cache` / `temp-residue` / `updater-residue` / `attachment-cache`;
 *   every path below is derived here from DSH_HOME and known OS locations, so a
 *   request can never point deletion at an arbitrary directory.
 * - **Whitelist only.** Inside the browser profile only Chromium's pure caches
 *   are touched; Cookies, Local Storage, Service Worker, IndexedDB, Network,
 *   Preferences and Login Data are never opened.
 * - **Rename before delete.** A directory that is in use fails the rename on
 *   Windows; that is treated as "in use" and reported instead of retried.
 * - **Count after success.** Bytes are measured before removal but only added to
 *   `freedBytes` once the entry is confirmed gone — the earlier disk-cleanup rule
 *   "count += size before deleting and swallow errors" produced fake accounting.
 * - Pure `node:fs` — no dependencies, so it is testable without a DSH host.
 *
 * @module dsh-browser-playwright-codex/cache-clean
 */
import { chmod, lstat, readdir, rename, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'

/** The four buckets the card can report and clean. */
export type TargetId = 'browser-cache' | 'temp-residue' | 'updater-residue' | 'attachment-cache'

/** Display order and labels for every target. */
export const TARGETS: readonly { id: TargetId; label: string }[] = [
  { id: 'browser-cache', label: '浏览器缓存' },
  { id: 'temp-residue', label: '临时残留' },
  { id: 'updater-residue', label: '更新器残留' },
  { id: 'attachment-cache', label: '附件缓存' },
]

/** Is this value one of the enum ids? Unknown strings are rejected, never joined into a path. */
export function isTargetId(value: unknown): value is TargetId {
  return typeof value === 'string' && TARGETS.some((target) => target.id === value)
}

/** Absolute locations this module may inspect. */
export interface CachePaths {
  /** DSH home (`~/.dsh` unless DSH_HOME overrides it). */
  dshHome: string
  /** Persistent Chromium profile directory of the browser capability. */
  browserProfileDir: string
  /** OS temp directory. */
  tmpDir: string
  /** Electron updater residue directory for the DSH desktop app. */
  updaterDir: string
  /** Version currently installed — used to refuse other versions' installers. */
  installedVersion: string
}

/** Resolve the default paths from the environment (no path ever comes from the request). */
export function resolvePaths(
  env: NodeJS.ProcessEnv = process.env,
  version: string,
  platform: NodeJS.Platform = process.platform,
): CachePaths {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh')
  const profileOverride = env.DSH_BROWSER_PROFILE_DIR
  const localAppData = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return {
    dshHome: home,
    browserProfileDir:
      profileOverride !== undefined && profileOverride !== ''
        ? profileOverride
        : join(home, 'browser-profiles', 'playwright'),
    tmpDir: tmpdir(),
    updaterDir: join(localAppData, '@deepseek-aidsh-desktop-updater'),
    installedVersion: version,
  }
}

/** One row of the disk panel. */
export interface DiskItem {
  id: TargetId
  label: string
  bytes: number
  files: number
  /** Optional human note (e.g. "浏览器正在运行，整段跳过"). */
  note?: string
}

/** What `scan()` reports. */
export interface ScanReport {
  items: DiskItem[]
  totalBytes: number
  attachments: { objectsBytes: number; requestImagesBytes: number }
  skipped: { id: TargetId; reason: string }[]
}

/** One skipped entry inside a target. */
export interface SkippedEntry {
  path: string
  reason: 'in-use' | 'permission' | 'other-version' | 'unknown-version' | 'missing'
}

/** Per-target outcome of a clean pass. */
export interface CleanTargetReport {
  id: TargetId
  freedBytes: number
  skipped: SkippedEntry[]
}

/** What `clean()` reports. */
export interface CleanReport {
  dryRun: boolean
  freedBytes: number
  perTarget: CleanTargetReport[]
}

/** Options for one clean pass. */
export interface CleanOptions extends CachePaths {
  targets: readonly TargetId[]
  dryRun: boolean
  /** True when the capability is enabled — reported, not used to skip silently. */
  browserActive?: boolean
  /** Clock override for tests. */
  now?: number
}

/** Chromium's pure caches. Everything else in the profile is off limits. */
const BROWSER_CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'ShaderCache',
  'GrShaderCache',
  'DawnCache',
  'DawnGraphiteCache',
  'ScriptCache',
] as const

/** Temp entries this plugin and the harness leave behind. */
const TEMP_PREFIXES = [
  'dsh-browser-state-',
  'dsh-provider-state-',
  'dsh-subprocess-',
  'dsh-spill-',
  'dsh-acl-skill-',
  'dsh-login-state-',
] as const

/** A temp entry younger than this is assumed to belong to a running task. */
const TEMP_MIN_AGE_MS = 30 * 60 * 1000

/** Measure a file or directory tree. Missing paths measure as zero. */
async function measure(path: string): Promise<{ bytes: number; files: number }> {
  const st = await lstat(path).catch(() => undefined)
  if (st === undefined) return { bytes: 0, files: 0 }
  if (!st.isDirectory()) return { bytes: st.size, files: 1 }
  let bytes = 0
  let files = 0
  const stack: string[] = [path]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) break
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined)
    if (entries === undefined) continue
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(child)
        continue
      }
      const size = await lstat(child).catch(() => undefined)
      if (size !== undefined) {
        bytes += size.size
        files += 1
      }
    }
  }
  return { bytes, files }
}

/** Windows refuses to delete read-only files even with `force`; clear the attribute first. */
async function makeWritable(path: string): Promise<void> {
  const st = await lstat(path).catch(() => undefined)
  if (st === undefined) return
  if (st.isDirectory()) {
    const entries = await readdir(path).catch(() => [])
    for (const name of entries) await makeWritable(join(path, name))
    await chmod(path, 0o777).catch(() => undefined)
    return
  }
  await chmod(path, 0o666).catch(() => undefined)
}

/** Remove an entry, retrying once after clearing read-only attributes. */
async function removeEntry(path: string): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 2 })
  } catch {
    await makeWritable(path)
    await rm(path, { recursive: true, force: true, maxRetries: 2 }).catch(() => undefined)
  }
  return (await lstat(path).catch(() => undefined)) === undefined
}

/**
 * Detach an entry by renaming it first, then delete the renamed copy.
 * A rename failure means something holds it open (Windows locks the directory),
 * which is exactly the "in use" signal we want instead of guessing.
 */
async function detachAndRemove(path: string): Promise<{ ok: boolean; reason?: SkippedEntry['reason'] }> {
  const detached = `${path}.dsh-delete-${process.pid}-${Date.now()}`
  try {
    await rename(path, detached)
  } catch {
    return { ok: false, reason: 'in-use' }
  }
  const removed = await removeEntry(detached)
  return removed ? { ok: true } : { ok: false, reason: 'permission' }
}

/** Browser-profile cache directories that currently exist. */
async function browserCacheDirs(profileDir: string): Promise<string[]> {
  const defaultDir = join(profileDir, 'Default')
  const entries = await readdir(defaultDir, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return []
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        (BROWSER_CACHE_DIRS as readonly string[]).includes(name) || /_crx_cache$/.test(name),
    )
    .map((name) => join(defaultDir, name))
}

/** Temp entries matching the known residue prefixes. */
async function tempResidueDirs(tmpDir: string): Promise<string[]> {
  const entries = await readdir(tmpDir, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return []
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) => join(tmpDir, entry.name))
}

/** Updater files that belong to the currently installed version. */
async function updaterResidue(
  updaterDir: string,
  installedVersion: string,
): Promise<{ files: string[]; skipped: SkippedEntry[] }> {
  const files: string[] = []
  const skipped: SkippedEntry[] = []
  const entries = await readdir(updaterDir, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return { files, skipped }
  const versionFrom = (name: string): string | undefined => {
    const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(name)
    return match?.[1]
  }
  for (const entry of entries) {
    const path = join(updaterDir, entry.name)
    if (entry.isDirectory()) {
      // Only `pending/` is updater residue; the directory itself stays.
      if (entry.name !== 'pending') continue
      const pending = await readdir(path, { withFileTypes: true }).catch(() => [])
      for (const child of pending) {
        if (!child.isFile()) continue
        const childPath = join(path, child.name)
        const version = versionFrom(child.name)
        if (version === undefined) skipped.push({ path: childPath, reason: 'unknown-version' })
        else if (version !== installedVersion) skipped.push({ path: childPath, reason: 'other-version' })
        else files.push(childPath)
      }
      continue
    }
    if (!entry.isFile()) continue
    const isUpdaterFile = /^installer.*\.exe$/i.test(entry.name) || /\.blockmap$/i.test(entry.name)
    if (!isUpdaterFile) continue
    const version = versionFrom(entry.name)
    if (version === undefined) {
      skipped.push({ path, reason: 'unknown-version' })
      continue
    }
    if (version !== installedVersion) {
      skipped.push({ path, reason: 'other-version' })
      continue
    }
    files.push(path)
  }
  return { files, skipped }
}

/** Everything under the request-image cache (kept apart from session attachments). */
async function attachmentCacheFiles(dshHome: string): Promise<string[]> {
  const root = join(dshHome, 'cache', 'attachments')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return []
  return entries.map((entry) => join(root, entry.name))
}

/**
 * Inspect every bucket without touching anything.
 * @param paths - resolved locations
 * @returns per-target sizes plus the attachment totals kept apart from the cache
 */
export async function scan(paths: CachePaths): Promise<ScanReport> {
  const items: DiskItem[] = []
  const skipped: { id: TargetId; reason: string }[] = []

  const browserDirs = await browserCacheDirs(paths.browserProfileDir)
  const browser = { bytes: 0, files: 0 }
  for (const dir of browserDirs) {
    const own = await measure(dir)
    browser.bytes += own.bytes
    browser.files += own.files
  }
  items.push({ id: 'browser-cache', label: '浏览器缓存', ...browser })

  const temp = { bytes: 0, files: 0 }
  for (const dir of await tempResidueDirs(paths.tmpDir)) {
    const own = await measure(dir)
    temp.bytes += own.bytes
    temp.files += own.files
  }
  items.push({ id: 'temp-residue', label: '临时残留', ...temp })

  const updater = await updaterResidue(paths.updaterDir, paths.installedVersion)
  const updaterSize = { bytes: 0, files: 0 }
  for (const file of updater.files) {
    const own = await measure(file)
    updaterSize.bytes += own.bytes
    updaterSize.files += own.files
  }
  items.push({
    id: 'updater-residue',
    label: '更新器残留',
    ...updaterSize,
    ...(updater.skipped.length > 0 ? { note: `${String(updater.skipped.length)} 项属于其它版本，跳过` } : {}),
  })

  const attachments = await measure(join(paths.dshHome, 'cache', 'attachments'))
  items.push({ id: 'attachment-cache', label: '附件缓存', ...attachments })

  const objects = await measure(join(paths.dshHome, 'attachments', 'v1', 'objects'))
  const requestImages = attachments

  return {
    items,
    totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
    attachments: { objectsBytes: objects.bytes, requestImagesBytes: requestImages.bytes },
    skipped,
  }
}

/**
 * Clean the requested buckets. With `dryRun` the same walk happens but nothing
 * is renamed or removed, so the preview shows real numbers.
 *
 * @param options - resolved paths, enum targets and dry-run flag
 * @returns per-target freed bytes and every skipped entry with a reason
 */
export async function clean(options: CleanOptions): Promise<CleanReport> {
  const now = options.now ?? Date.now()
  const perTarget: CleanTargetReport[] = []
  let freedBytes = 0

  for (const id of options.targets) {
    const report: CleanTargetReport = { id, freedBytes: 0, skipped: [] }

    if (id === 'browser-cache') {
      for (const dir of await browserCacheDirs(options.browserProfileDir)) {
        const size = await measure(dir)
        if (options.dryRun) {
          report.freedBytes += size.bytes
          continue
        }
        const outcome = await detachAndRemove(dir)
        if (outcome.ok) report.freedBytes += size.bytes
        else report.skipped.push({ path: dir, reason: outcome.reason ?? 'permission' })
      }
    }

    if (id === 'temp-residue') {
      for (const dir of await tempResidueDirs(options.tmpDir)) {
        const stat = await lstat(dir).catch(() => undefined)
        const age = stat === undefined ? 0 : now - stat.mtimeMs
        const size = await measure(dir)
        if (stat !== undefined && age < TEMP_MIN_AGE_MS) {
          // Too fresh to tell "left behind" from "this run is using it": prove it by
          // renaming first; only a successful rename means the owner let go.
          if (options.dryRun) {
            report.skipped.push({ path: dir, reason: 'in-use' })
            continue
          }
          const outcome = await detachAndRemove(dir)
          if (outcome.ok) report.freedBytes += size.bytes
          else report.skipped.push({ path: dir, reason: outcome.reason ?? 'in-use' })
          continue
        }
        if (options.dryRun) {
          report.freedBytes += size.bytes
          continue
        }
        const outcome = await detachAndRemove(dir)
        if (outcome.ok) report.freedBytes += size.bytes
        else report.skipped.push({ path: dir, reason: outcome.reason ?? 'permission' })
      }
    }

    if (id === 'updater-residue') {
      const residue = await updaterResidue(options.updaterDir, options.installedVersion)
      for (const skipped of residue.skipped) report.skipped.push(skipped)
      for (const file of residue.files) {
        const size = await measure(file)
        if (options.dryRun) {
          report.freedBytes += size.bytes
          continue
        }
        const removed = await removeEntry(file)
        if (removed) report.freedBytes += size.bytes
        else report.skipped.push({ path: file, reason: 'permission' })
      }
    }

    if (id === 'attachment-cache') {
      for (const path of await attachmentCacheFiles(options.dshHome)) {
        const size = await measure(path)
        if (options.dryRun) {
          report.freedBytes += size.bytes
          continue
        }
        const removed = await removeEntry(path)
        if (removed) report.freedBytes += size.bytes
        else report.skipped.push({ path, reason: 'permission' })
      }
    }

    freedBytes += report.freedBytes
    perTarget.push(report)
  }

  return { dryRun: options.dryRun, freedBytes, perTarget }
}

/** Human-readable size for the card and the CLI. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return String(bytes) + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return value.toFixed(value >= 100 ? 0 : 1) + ' ' + (units[unit] ?? 'TB')
}

/** Basename helper re-exported for the route's skipped-entry display. */
export function displayName(path: string): string {
  return basename(path)
}
