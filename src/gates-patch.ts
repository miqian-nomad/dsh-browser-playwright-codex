/**
 * Home-level patch writer for the merged single-row plugin (2026-10-19).
 *
 * Reads and rewrites ONE managed block inside the home-level cordis.patch.yml
 * (the patch layer with the highest priority, so the user's own choice wins over
 * any profile layer and over the package default). Everything outside the block
 * is preserved byte for byte.
 *
 * Why the block carries the WHOLE row: the loader replaces an entry's `config`
 * wholesale, so a block that lists only the two gates would silently reset the
 * launch options, the idle timeout and the snapshot engine to their defaults.
 * The template below therefore mirrors cordis.patch.yml's shipped values and
 * differs only in the two gate booleans.
 *
 * Dependency-free on purpose: a half-written patch layer breaks every plugin
 * load in the profile, so this file only uses node builtins and stays testable
 * on its own.
 *
 * @module dsh-browser-playwright-codex/gates-patch
 */
import { readFile, writeFile, rename, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Managed block markers: everything between them belongs to this plugin. */
export const BEGIN = '# >>> dsh-browser: 浏览器插件配置（本块由设置页维护，也可手工编辑）>>>'
export const END = '# <<< dsh-browser <<<'

/**
 * The pre-merge markers, written by dsh-browser-toggle 0.3.0. Accepted so an
 * existing block is replaced in place instead of accumulating a second row that
 * would patch the same entry twice.
 */
export const LEGACY_BEGIN = '# >>> dsh-browser-toggle: 强力工具闸门（本块由设置页维护，也可手工编辑）>>>'
export const LEGACY_END = '# <<< dsh-browser-toggle <<<'

/** Path of the home-level patch layer (highest priority among patch files). */
export function homePatchPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.DSH_HOME || join(homedir(), '.dsh'), 'cordis.patch.yml')
}

/**
 * The managed block: one loader row for the whole plugin, with the shipped
 * launch/provider/snapshot values repeated and the two gates filled in.
 *
 * @param allowEvaluate - register browser_evaluate
 * @param allowCdp - register browser_cdp
 * @returns the YAML block, markers included
 */
export function renderBrowserBlock(allowEvaluate: boolean, allowCdp: boolean): string {
  return [
    BEGIN,
    '# allowEvaluate: 注册 browser_evaluate（页面任意 JS，能用你的登录态操作网站）',
    '# allowCdp:      注册 browser_cdp（原始 CDP，仅放行检查与输入模拟）',
    '# 包内默认关闭；这里的值就是用户自己的选择。改完由热重载生效。',
    '# 整行 config 会被整体替换，所以这里写全 —— 只写两个闸门会把其它设置重置成默认值。',
    '- id: browser',
    "  name: 'dsh-browser-playwright-codex'",
    '  config:',
    '    service:',
    '      provider: playwright',
    '    playwright:',
    '      launch:',
    '        headless: false',
    '        persistent: true',
    '        viewport:',
    '          width: 1280',
    '          height: 800',
    '        navigationTimeoutMs: 30000',
    '        ignoreHTTPSErrors: false',
    '      idleTimeoutMs: 0',
    '      maxSessions: 8',
    '      snapshot:',
    '        diff: false',
    '    tool:',
    '      toolPrefix: "browser_"',
    '      allowEvaluate: ' + (allowEvaluate ? 'true' : 'false'),
    '      allowCdp: ' + (allowCdp ? 'true' : 'false'),
    '      registerDisabledTools: false',
    '      diagnostics: false',
    '      maxWaitMs: 60000',
    END,
    '',
  ].join('\n')
}

/** Locate the managed block, preferring the current markers over the legacy ones. */
function findBlock(original: string): { start: number; after: number } | undefined {
  const markers = [
    [BEGIN, END],
    [LEGACY_BEGIN, LEGACY_END],
  ] as const
  for (const [begin, end] of markers) {
    const beginIdx = original.indexOf(begin)
    const endIdx = original.indexOf(end)
    if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
      let after = endIdx + end.length
      if (original[after] === '\n') after += 1
      return { start: beginIdx, after }
    }
  }
  return undefined
}

/** Merge the managed block into `original`, replacing an existing one in place. */
export function mergeBrowserBlock(original: string, allowEvaluate: boolean, allowCdp: boolean): string {
  const block = renderBrowserBlock(allowEvaluate, allowCdp)
  const found = findBlock(original)
  if (found !== undefined) return original.slice(0, found.start) + block + original.slice(found.after)
  return (original === '' || original.endsWith('\n') ? original : original + '\n') + '\n' + block
}

/** Read the current managed block, or undefined when there is none. */
export function parseBrowserBlock(text: string): { allowEvaluate: boolean; allowCdp: boolean } | undefined {
  const found = findBlock(text)
  if (found === undefined) return undefined
  const body = text.slice(found.start, found.after)
  const evaluate = /allowEvaluate:\s*(true|false)/.exec(body)
  const cdp = /allowCdp:\s*(true|false)/.exec(body)
  if (evaluate === null || cdp === null) return undefined
  return { allowEvaluate: evaluate[1] === 'true', allowCdp: cdp[1] === 'true' }
}

/** Back-compat aliases used by the absorbed settings-card host half. */
export const parseGatesBlock = parseBrowserBlock
/** Back-compat alias (see {@link mergeBrowserBlock}). */
export const mergeGatesBlock = mergeBrowserBlock

/**
 * Write both gates into the home-level patch. Backup first, atomic rename, then
 * read back and check; on a failed check the previous bytes are restored.
 *
 * @param allowEvaluate - register browser_evaluate
 * @param allowCdp - register browser_cdp
 * @param env - environment (DSH_HOME override for tests)
 * @returns the file written and the values it now carries
 */
export async function writeGates(
  allowEvaluate: boolean,
  allowCdp: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ patch: string; allowEvaluate: boolean; allowCdp: boolean }> {
  const file = homePatchPath(env)
  let original = ''
  try {
    original = await readFile(file, 'utf8')
  } catch {
    original = ''
  }
  const next = mergeBrowserBlock(original, allowEvaluate, allowCdp)
  if (original !== '') await copyFile(file, file + '.bak-browser-toggle').catch(() => {})
  const tmp = file + '.tmp-browser-toggle'
  await writeFile(tmp, next, 'utf8')
  await rename(tmp, file)
  const check = await readFile(file, 'utf8')
  const parsed = parseBrowserBlock(check)
  if (parsed === undefined || parsed.allowEvaluate !== allowEvaluate || parsed.allowCdp !== allowCdp) {
    if (original !== '') {
      await writeFile(file, original, 'utf8')
      throw new Error('patch self-check failed after write; previous content restored')
    }
    throw new Error('patch self-check failed after write')
  }
  return { patch: file, allowEvaluate, allowCdp }
}
