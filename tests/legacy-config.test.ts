/**
 * Stale loader-row detection (0.7.0 merged three rows into one).
 *
 * The failure this guards against is silent: a patch layer that still lists
 * `browser-tool` mounts nothing, so the deployment runs on package defaults
 * with both power gates off while the user believes they are on. A 0.7.4
 * install was found in exactly that state, so the rule and its warning text are
 * pinned here rather than left to the startup path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  findLegacyRowsIn,
  legacyRowWarning,
  patchLayers,
  scanLegacyRows,
  warnLegacyRows,
} from '../src/legacy-config.ts'

const OLD_LAYOUT = `# 老的三行写法（0.6.x）
- id: browser-playwright
  name: 'dsh-browser-playwright-codex/playwright'
  config:
    launch:
      headless: false
- id: browser-service
  name: 'dsh-browser-playwright-codex/service'
  config:
    provider: playwright
- id: browser-tool
  name: 'dsh-browser-playwright-codex/tool'
  config:
    allowEvaluate: true
    allowCdp: true
`

const NEW_LAYOUT = `- id: browser
  name: 'dsh-browser-playwright-codex'
  config:
    service:
      provider: playwright
    tool:
      allowEvaluate: true
      allowCdp: true
`

test('the pre-0.7 three-row layout is reported, with line numbers', () => {
  const rows = findLegacyRowsIn(OLD_LAYOUT)
  assert.deepEqual(
    rows.map((row) => [row.id, row.name, row.line]),
    [
      ['browser-playwright', 'dsh-browser-playwright-codex/playwright', 2],
      ['browser-service', 'dsh-browser-playwright-codex/service', 7],
      ['browser-tool', 'dsh-browser-playwright-codex/tool', 11],
    ],
  )
})

test('the merged single-row layout and a commented-out legacy row are both clean', () => {
  assert.deepEqual(findLegacyRowsIn(NEW_LAYOUT), [])
  const comments = OLD_LAYOUT.split('\n')
    .map((line) => '# ' + line)
    .join('\n')
  assert.deepEqual(findLegacyRowsIn(comments), [])
})

test('a legacy subpath name is caught even when the row id was renamed', () => {
  const rows = findLegacyRowsIn("- id: my-browser\n  name: 'dsh-browser-playwright-codex/tool'\n")
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.id, 'my-browser')
  assert.equal(rows[0]?.target, 'entry')
})

test('another plugin that calls its row browser-tool is NOT reported', () => {
  // `- id:` is a local label, so the id alone is never evidence. Only the row's
  // package name decides, otherwise this warning would accuse a stranger's plugin.
  assert.deepEqual(findLegacyRowsIn("- id: browser-tool\n  name: 'some-other-team-plugin'\n  config: {}\n"), [])
  assert.deepEqual(findLegacyRowsIn('- id: browser-tool\n  name: style-only-plugin\n'), [])
})

test('a retired package row is reported separately from a stale entry row', () => {
  const rows = findLegacyRowsIn("- id: browser-toggle\n  name: 'dsh-browser-toggle'\n  config:\n    enabled: true\n")
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.target, 'package')
  assert.equal(rows[0]?.name, 'dsh-browser-toggle')
})

test('the warning names the file, the rows, and the one-row replacement', () => {
  const text = legacyRowWarning('.dsh/cordis.patch.yml', findLegacyRowsIn(OLD_LAYOUT))
  assert.match(text, /0\.7\.0 之前的旧加载行/)
  assert.match(text, /\.dsh\/cordis\.patch\.yml/)
  assert.match(text, /第 11 行: - id: browser-tool/)
  assert.match(text, /- id: browser/)
  assert.match(text, /allowEvaluate \/ allowCdp 默认关闭/)
  assert.match(text, /判断依据是每行的 name/)
  assert.doesNotMatch(text, /退役包/)
})

test('a retired package gets the "it keeps rewriting the file" paragraph', () => {
  const text = legacyRowWarning('.dsh/cordis.patch.yml', findLegacyRowsIn('- id: t\n  name: dsh-browser-toggle\n'))
  assert.match(text, /退役包/)
  assert.match(text, /反复被改回去/)
})

test('scanning covers the home layer and every profile layer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-legacy-scan-'))
  await mkdir(join(home, 'profiles', 'desktop'), { recursive: true })
  await writeFile(join(home, 'cordis.patch.yml'), NEW_LAYOUT, 'utf8')
  await writeFile(join(home, 'profiles', 'desktop', 'cordis.patch.yml'), OLD_LAYOUT, 'utf8')
  const env = { DSH_HOME: home }
  const layers = await patchLayers(env)
  assert.deepEqual(layers, [join(home, 'cordis.patch.yml'), join(home, 'profiles', 'desktop', 'cordis.patch.yml')])
  const hits = await scanLegacyRows(env)
  assert.equal(hits.length, 1)
  assert.equal(hits[0]?.file, join(home, 'profiles', 'desktop', 'cordis.patch.yml'))
  assert.equal(hits[0]?.rows.length, 3)
})

test('a clean deployment logs nothing, a stale one logs once per home', async () => {
  const clean = await mkdtemp(join(tmpdir(), 'dsh-legacy-clean-'))
  await writeFile(join(clean, 'cordis.patch.yml'), NEW_LAYOUT, 'utf8')
  const quiet: string[] = []
  await warnLegacyRows(new Context(), { DSH_HOME: clean }, (text) => quiet.push(text))
  assert.deepEqual(quiet, [])

  const stale = await mkdtemp(join(tmpdir(), 'dsh-legacy-stale-'))
  await writeFile(join(stale, 'cordis.patch.yml'), OLD_LAYOUT, 'utf8')
  const said: string[] = []
  const env = { DSH_HOME: stale }
  await warnLegacyRows(new Context(), env, (text) => said.push(text))
  await warnLegacyRows(new Context(), env, (text) => said.push(text))
  assert.equal(said.length, 1, 'a second load of the same home must not repeat the warning')
  assert.match(said[0] ?? '', /browser-tool/)
})

test('the scan never throws on an unreadable home', async () => {
  const missing = join(tmpdir(), 'dsh-legacy-does-not-exist-' + String(Date.now()))
  assert.deepEqual(await scanLegacyRows({ DSH_HOME: missing }), [])
  const said: string[] = []
  await warnLegacyRows(new Context(), { DSH_HOME: missing }, (text) => said.push(text))
  assert.deepEqual(said, [])
})
