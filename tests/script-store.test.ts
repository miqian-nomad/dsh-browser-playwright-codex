/**
 * Script store: one JSON file per script, names that cannot escape the folder,
 * and a load path that re-validates what it reads.
 *
 * Every test points DSH_BROWSER_SCRIPTS_DIR at a temp folder, so nothing here
 * touches the real ~/.dsh.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { listScripts, loadScript, saveScript, validName } from '../src/script-store.ts'
import { MAX_SCRIPT_STEPS } from '../src/script-steps.ts'

/** Point the store at a fresh temp dir for one test. */
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-browser-scripts-'))
  process.env.DSH_BROWSER_SCRIPTS_DIR = dir
  return dir
}

test('存一份、读回来，步骤一字不差', () => {
  const dir = tempDir()
  const written = saveScript('login-read-orders', [
    { action: 'navigate', url: 'https://a.test/' },
    { action: 'click', target: { text: '登录' } },
  ])
  assert.equal(written.steps, 2)
  assert.ok(fs.existsSync(path.join(dir, 'login-read-orders.json')))
  const loaded = loadScript('login-read-orders', MAX_SCRIPT_STEPS)
  assert.equal(loaded.steps.length, 2)
  assert.deepEqual(loaded.steps[1], { action: 'click', target: { text: '登录' } })
  assert.match(loaded.savedAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('同名再存会覆盖（覆盖与否由工具层决定），不留 .tmp 残留', () => {
  const dir = tempDir()
  saveScript('a', [{ action: 'snapshot' }])
  saveScript('a', [{ action: 'snapshot' }, { action: 'snapshot' }])
  assert.equal(loadScript('a', MAX_SCRIPT_STEPS).steps.length, 2)
  assert.equal(fs.readdirSync(dir).filter((entry) => entry.endsWith('.tmp')).length, 0)
})

test('读取时会重新校验：文件被手工改坏就报错，不是带病运行', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'broken.json'), '{"steps":[{"action":"submit"}]}', 'utf8')
  assert.throws(() => loadScript('broken', MAX_SCRIPT_STEPS), /unknown action "submit"/)
  fs.writeFileSync(path.join(dir, 'not-json.json'), 'not json', 'utf8')
  assert.throws(() => loadScript('not-json', MAX_SCRIPT_STEPS), /not valid JSON/)
})

test('不存在的脚本说清楚下一步怎么做', () => {
  tempDir()
  assert.throws(() => loadScript('missing', MAX_SCRIPT_STEPS), /no saved script named "missing"/)
})

test('脚本名不许带路径：/ .. 空格 中文 都不行', () => {
  for (const bad of ['../evil', 'a/b', 'a b', '中文名', '', 'a'.repeat(65), '.hidden']) {
    assert.throws(() => validName(bad), /script name must be/, 'accepted: ' + bad)
  }
  assert.equal(validName('  ok-name_1  '), 'ok-name_1')
})

test('列表只列 .json，按名排序', () => {
  const dir = tempDir()
  saveScript('b', [{ action: 'snapshot' }])
  saveScript('a', [{ action: 'snapshot' }])
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x', 'utf8')
  assert.deepEqual(listScripts(), ['a', 'b'])
})

test('目录不存在时列表为空，不抛异常', () => {
  process.env.DSH_BROWSER_SCRIPTS_DIR = path.join(os.tmpdir(), 'dsh-never-created-' + String(Date.now()))
  assert.deepEqual(listScripts(), [])
})
