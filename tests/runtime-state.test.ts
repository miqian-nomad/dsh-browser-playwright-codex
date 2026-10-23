import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getConfiguredHeadless,
  getEffectiveHeadless,
  getEnabled,
  getHeadless,
  getSnapshotEngine,
  isHeadlessUserChosen,
  publishConfiguredHeadless,
  setEnabled,
  setHeadless,
  setSnapshotEngine,
} from '../src/runtime-state.ts'
import { resolveSnapshotEngine } from '../src/page-snapshot.ts'

/**
 * The settings file is the user's state, so these tests redirect it with
 * DSH_BROWSER_STATE_FILE — they must never touch the real
 * ~/.dsh/dsh-browser-playwright.state.json.
 */
/** Temp dirs this file created; removed when the suite ends (they used to leak). */
const createdTempDirs: string[] = []
after(() => {
  for (const dir of createdTempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

function freshStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-browser-state-'))
  createdTempDirs.push(dir)
  return path.join(dir, 'state.json')
}

function withStateFile<T>(file: string, body: () => T): T {
  process.env.DSH_BROWSER_STATE_FILE = file
  try {
    return body()
  } finally {
    delete process.env.DSH_BROWSER_STATE_FILE
  }
}

test('the window mode is persisted; the configured default is only a fallback', () => {
  const file = freshStateFile()
  process.env.DSH_BROWSER_STATE_FILE = file
  try {
    // An existing file without `headless` resets the in-memory choice (this is
    // how a stale module-level value from an earlier case is cleared).
    fs.writeFileSync(file, JSON.stringify({ enabled: true }))
    // No user choice, no published default: the shipped default is headful.
    assert.equal(getEffectiveHeadless(false), false)
    assert.equal(isHeadlessUserChosen(), false)

    assert.equal(setHeadless(true), true)
    assert.equal(setHeadless(true), false, 'setting the same value again is a no-op')
    assert.equal(getHeadless(), true)
    assert.equal(getEffectiveHeadless(), true)
    assert.equal(isHeadlessUserChosen(), true)

    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { enabled?: boolean; headless?: boolean }
    assert.equal(saved.headless, true)
    assert.equal(saved.enabled, true, 'other keys survive a window-mode write')
  } finally {
    delete process.env.DSH_BROWSER_STATE_FILE
  }
})

test('without a user choice the configured default wins', () => {
  const file = freshStateFile()
  process.env.DSH_BROWSER_STATE_FILE = file
  try {
    fs.writeFileSync(file, JSON.stringify({ enabled: true }))
    publishConfiguredHeadless(true)
    assert.equal(getConfiguredHeadless(), true)
    assert.equal(getEffectiveHeadless(false), true)
    publishConfiguredHeadless(false)
    assert.equal(getEffectiveHeadless(true), false)
  } finally {
    publishConfiguredHeadless(false)
    delete process.env.DSH_BROWSER_STATE_FILE
  }
})

test('a state file written before the page-reading setting existed still works', () => {
  const file = freshStateFile()
  fs.writeFileSync(file, JSON.stringify({ enabled: false }))
  withStateFile(file, () => {
    assert.equal(getEnabled(), false)
    assert.equal(getSnapshotEngine(), undefined, 'absent setting means "follow the configured default"')
    assert.equal(resolveSnapshotEngine('legacy'), 'legacy')
    assert.equal(resolveSnapshotEngine('aria'), 'aria')
  })
})

test('picking a page-reading mode persists and outranks the configured default', () => {
  const file = freshStateFile()
  fs.writeFileSync(file, JSON.stringify({ enabled: true }))
  withStateFile(file, () => {
    assert.equal(getSnapshotEngine(), undefined)
    assert.equal(setSnapshotEngine('aria'), true)
    assert.equal(getSnapshotEngine(), 'aria')
    assert.equal(resolveSnapshotEngine('legacy'), 'aria', 'the user choice wins over the config default')
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { enabled: true, engine: 'aria' })
    assert.equal(setSnapshotEngine('aria'), false, 'setting the same value again is not a change')
    assert.equal(setSnapshotEngine('legacy'), true)
    assert.equal(resolveSnapshotEngine('aria'), 'legacy', 'and back again')
  })
})

test('the two settings do not clobber each other', () => {
  const file = freshStateFile()
  fs.writeFileSync(file, JSON.stringify({ enabled: true }))
  withStateFile(file, () => {
    assert.equal(setSnapshotEngine('aria'), true)
    assert.equal(setEnabled(false), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { enabled: false, engine: 'aria' })
    assert.equal(getEnabled(), false)
    assert.equal(getSnapshotEngine(), 'aria')
    // Restore the default availability so later tests in this file see a clean slate.
    assert.equal(setEnabled(true), true)
  })
})

test('an unknown mode is refused instead of written', () => {
  const file = freshStateFile()
  fs.writeFileSync(file, JSON.stringify({ enabled: true }))
  withStateFile(file, () => {
    assert.equal(setSnapshotEngine('smart' as unknown as 'aria'), false)
    assert.equal(getSnapshotEngine(), undefined)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { enabled: true })
  })
})

test('a missing file keeps the defaults (tools on, mode follows the config)', () => {
  const file = freshStateFile()
  withStateFile(file, () => {
    assert.equal(getEnabled(), true)
    assert.equal(getSnapshotEngine(), undefined)
    assert.equal(resolveSnapshotEngine('legacy'), 'legacy')
  })
})
