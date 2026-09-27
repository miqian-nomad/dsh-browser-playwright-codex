/**
 * Shared enable/disable flag for dsh-browser-playwright as a whole.
 *
 * Single source of truth shared across the three host entries
 * (browser / browser-playwright / browser-tool) and the toggle HTTP API. State persists to
 * ~/.dsh/dsh-browser-playwright.state.json so toggling survives
 * DSH restarts without needing to touch cordis.patch.yml or restart DSH.
 *
 * Default is `true` (enabled) on first run, which matches the user-visible
 * behaviour the plugin has had so far.
 * @module dsh-browser-playwright/runtime-state
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Shared layer: the web and desktop sides read the same switch file, so one
// agent can never see two different states depending on which side is open.
const STATE_DIR = path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(STATE_DIR, 'dsh-browser-playwright.state.json')

let _loaded = false
let _enabled = true
const _subscribers = new Set<(enabled: boolean) => void>()

function load() {
  // Re-read the file on every call: whichever side flips the switch, the
  // other side follows immediately (no read-once caching).
  const previous = _enabled
  try {
    const txt = fs.readFileSync(STATE_FILE, 'utf8')
    const obj = JSON.parse(txt)
    if (obj !== null && typeof obj === 'object' && typeof obj.enabled === 'boolean') _enabled = obj.enabled
  } catch {
    // Missing file / parse error / unreadable: keep the current value.
  }
  if (_enabled !== previous) {
    for (const fn of [..._subscribers]) {
      try {
        fn(_enabled)
      } catch {
        // One subscriber failing must not affect the others.
      }
    }
  }
}

function persist() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    // Atomic write: rename(2) is atomic on the same filesystem, so a crash
    // mid-write leaves either the old file or the new file, never half of
    // both.
    const tmp = STATE_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ enabled: _enabled }, null, 2))
    fs.renameSync(tmp, STATE_FILE)
  } catch {
    // Persist failure must not break the in-memory toggle; the next set
    // will retry.
  }
}

/** Current enable state (loads from disk on first call). */
export function getEnabled() {
  load()
  return _enabled
}

/** Set the enable state. Returns true if the value actually changed. */
export function setEnabled(next: boolean) {
  load()
  if (typeof next !== 'boolean') return false
  if (_enabled === next) return false
  _enabled = next
  persist()
  for (const fn of [..._subscribers]) {
    try {
      fn(next)
    } catch {
      // One subscriber failing must not prevent others from reacting.
    }
  }
  return true
}

/** Subscribe to enable-state transitions. Returns an unsubscribe function. */
export function subscribe(fn: (enabled: boolean) => void) {
  _subscribers.add(fn)
  return () => {
    _subscribers.delete(fn)
  }
}
