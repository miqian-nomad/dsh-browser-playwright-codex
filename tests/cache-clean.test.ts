/**
 * Fixture tests for the disk panel's pure module.
 *
 * Each case builds a throwaway tree, so the assertions can prove both halves of
 * the safety boundary: what the whitelist removes, and what it must leave alone.
 * Nothing here touches the real DSH home or the real browser profile.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clean, formatBytes, isTargetId, resolvePaths, scan, type CachePaths } from '../src/cache-clean.ts'

const VERSION = '0.7.3'

/** Build one isolated fixture tree; returns its root and the resolved paths. */
function fixture(): { root: string; paths: CachePaths } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cache-clean-test-'))
  const dshHome = join(root, 'dsh')
  const profile = join(root, 'profile')
  const tmp = join(root, 'tmp')
  const updater = join(root, 'updater')

  const write = (path: string, bytes: number): void => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'x'.repeat(bytes))
  }

  // Browser profile: one pure cache plus the files that must survive.
  write(join(profile, 'Default', 'Cache', 'data_0'), 2048)
  write(join(profile, 'Default', 'Code Cache', 'js', 'index'), 1024)
  write(join(profile, 'Default', 'Cookies'), 512)
  write(join(profile, 'Default', 'Local Storage', 'leveldb', '000003.log'), 256)
  write(join(profile, 'Default', 'Network', 'Cookies'), 128)
  write(join(profile, 'Default', 'Preferences'), 64)

  // Temp residue: one old entry, one fresh, and one foreign directory.
  const oldTemp = join(tmp, 'dsh-browser-state-old')
  const freshTemp = join(tmp, 'dsh-spill-fresh')
  const foreign = join(tmp, 'not-dsh-prefixed')
  for (const dir of [oldTemp, freshTemp, foreign]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'payload.bin'), 'x'.repeat(100))
  }
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
  utimesSync(oldTemp, old, old)

  // Updater residue: our version, another version, and an unparseable installer.
  write(join(updater, `installer-${VERSION}.exe`), 4096)
  write(join(updater, 'installer-0.6.0.exe'), 4096)
  write(join(updater, 'installer.exe'), 1024)
  write(join(updater, `pending`, `update-${VERSION}.blockmap`), 512)

  // Attachment cache (deletable) vs session attachments (never touched).
  write(join(dshHome, 'cache', 'attachments', 'req-1.png'), 1024)
  write(join(dshHome, 'cache', 'attachments', 'req-2.png'), 1024)
  write(join(dshHome, 'attachments', 'v1', 'objects', 'aa', 'bb'), 2048)

  return {
    root,
    paths: { dshHome, browserProfileDir: profile, tmpDir: tmp, updaterDir: updater, installedVersion: VERSION },
  }
}

test('scan reports every bucket and keeps the session attachments apart', async () => {
  const { root, paths } = fixture()
  try {
    const report = await scan(paths)
    const byId = new Map(report.items.map((item) => [item.id, item]))
    assert.equal(byId.get('browser-cache')?.bytes, 3072)
    assert.equal(byId.get('temp-residue')?.files, 2)
    assert.equal(byId.get('updater-residue')?.bytes, 4096 + 512)
    assert.equal(byId.get('attachment-cache')?.bytes, 2048)
    assert.equal(report.attachments.objectsBytes, 2048)
    assert.ok(report.totalBytes > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('clean removes only the browser cache and keeps login state', async () => {
  const { root, paths } = fixture()
  try {
    const report = await clean({ ...paths, targets: ['browser-cache'], dryRun: false })
    const defaultDir = join(paths.browserProfileDir, 'Default')
    assert.equal(existsSync(join(defaultDir, 'Cache')), false)
    assert.equal(existsSync(join(defaultDir, 'Code Cache')), false)
    for (const keep of ['Cookies', 'Local Storage', 'Network', 'Preferences']) {
      assert.equal(existsSync(join(defaultDir, keep)), true, keep + ' must survive')
    }
    assert.equal(report.freedBytes, 3072)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a dry run reports the same bytes and deletes nothing', async () => {
  const { root, paths } = fixture()
  try {
    const preview = await clean({ ...paths, targets: ['browser-cache', 'temp-residue'], dryRun: true })
    assert.equal(preview.dryRun, true)
    assert.ok(preview.freedBytes > 0)
    assert.equal(existsSync(join(paths.browserProfileDir, 'Default', 'Cache')), true)
    assert.equal(existsSync(join(paths.tmpDir, 'dsh-browser-state-old')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('temp residue: the preview treats a fresh entry as possibly in use, the real run detaches it', async () => {
  const { root, paths } = fixture()
  try {
    const preview = await clean({ ...paths, targets: ['temp-residue'], dryRun: true })
    const previewReport = preview.perTarget[0]
    assert.ok(previewReport !== undefined)
    const skipped = previewReport.skipped.map((entry) => entry.reason)
    assert.deepEqual(skipped, ['in-use'])

    const real = await clean({ ...paths, targets: ['temp-residue'], dryRun: false })
    assert.equal(existsSync(join(paths.tmpDir, 'dsh-browser-state-old')), false)
    assert.equal(existsSync(join(paths.tmpDir, 'dsh-spill-fresh')), false)
    assert.equal(existsSync(join(paths.tmpDir, 'not-dsh-prefixed')), true, 'foreign dir must survive')
    assert.equal(real.freedBytes, 200)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('updater residue only removes files of the installed version', async () => {
  const { root, paths } = fixture()
  try {
    const report = await clean({ ...paths, targets: ['updater-residue'], dryRun: false })
    assert.equal(existsSync(join(paths.updaterDir, `installer-${VERSION}.exe`)), false)
    assert.equal(existsSync(join(paths.updaterDir, 'installer-0.6.0.exe')), true, 'other version must survive')
    assert.equal(existsSync(join(paths.updaterDir, 'installer.exe')), true, 'unknown version must survive')
    assert.equal(existsSync(join(paths.updaterDir, `pending`, `update-${VERSION}.blockmap`)), false)
    assert.equal(existsSync(paths.updaterDir), true, 'the directory itself stays')
    const reasons = report.perTarget[0]?.skipped.map((entry) => entry.reason) ?? []
    assert.deepEqual(reasons.sort(), ['other-version', 'unknown-version'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('attachment cache is cleared but the session attachments are never touched', async () => {
  const { root, paths } = fixture()
  try {
    await clean({ ...paths, targets: ['attachment-cache'], dryRun: false })
    assert.equal(existsSync(join(paths.dshHome, 'cache', 'attachments', 'req-1.png')), false)
    assert.equal(existsSync(join(paths.dshHome, 'attachments', 'v1', 'objects', 'aa', 'bb')), true)
    assert.equal(existsSync(join(paths.dshHome, 'cache', 'attachments')), true, 'the cache directory stays')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('target ids are a closed enum and unknown names are rejected', () => {
  assert.equal(isTargetId('browser-cache'), true)
  assert.equal(isTargetId('temp-residue'), true)
  assert.equal(isTargetId('../etc'), false)
  assert.equal(isTargetId('C:\\Windows'), false)
  assert.equal(isTargetId(42), false)
})

test('resolvePaths derives every location and never accepts one from a request', () => {
  const paths = resolvePaths({ DSH_HOME: 'C:\\dsh', LOCALAPPDATA: 'C:\\local' }, '1.2.3', 'win32')
  assert.equal(paths.dshHome, 'C:\\dsh')
  assert.equal(paths.browserProfileDir, join('C:\\dsh', 'browser-profiles', 'playwright'))
  assert.equal(paths.updaterDir, join('C:\\local', '@deepseek-aidsh-desktop-updater'))
  assert.equal(paths.installedVersion, '1.2.3')
})

test('formatBytes keeps the card readable', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1024 * 1024 * 512), '512 MB')
})
