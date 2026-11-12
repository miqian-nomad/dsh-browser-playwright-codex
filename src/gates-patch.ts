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
 * @param diagnostics - register the two diagnostics tools
 * @returns the YAML block, markers included
 */
export function renderBrowserBlock(allowEvaluate: boolean, allowCdp: boolean, diagnostics: boolean): string {
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
    '      diagnostics: ' + (diagnostics ? 'true' : 'false'),
    '      registerDisabledTools: false',
    '      maxWaitMs: 60000',
    END,
    '',
  ].join('\n')
}

/** The three gate keys, in the order a freshly created block writes them. */
const GATE_KEYS = ['allowEvaluate', 'allowCdp', 'diagnostics'] as const
/** One of the three gate keys this writer owns. */
type GateKey = (typeof GATE_KEYS)[number]
/** The gate values as a record, for line-level rewriting. */
type GateValues = Record<GateKey, boolean>

/** One `key: value  # note` line of the managed block. */
const GATE_LINE = /^(\s*)(allowEvaluate|allowCdp|diagnostics)(\s*:\s*)(?:true|false)?[ \t]*(#.*)?$/

/**
 * Rewrite ONLY the three gate shortcuts inside an existing block, keeping every
 * other line byte for byte.
 *
 * Why not re-render the whole block: the loader replaces an entry's `config`
 * wholesale, so the block has to carry every key the user cares about — and it
 * cannot know all of them. Re-rendering the template silently reset whatever
 * the template did not list: `profileDir` (which wiped the saved login), the
 * launch channel, `snapshot.engine`, `toolPrefix`, `maxWaitMs`,
 * `interactiveOnlyDefault`, `registerDisabledTools`, the swarm section. Measured
 * 2026-11-10: toggling one switch in the settings card logged the user out of
 * every site, because their block said profileDir: 'D:/dsh-profile' and the
 * template does not.
 *
 * Documented consequence, deliberately kept: keys the user never wrote stay
 * unwritten (the package default applies), which is exactly what the user chose
 * by not writing them.
 *
 * @param body - the full block text, markers included
 * @param gates - the three gate values to write
 * @returns the block with only those lines changed or added
 */
export function patchBlockGates(body: string, gates: GateValues): string {
  const nl = body.includes('\r\n') ? '\r\n' : '\n'
  const lines = body.split(/\r?\n/)
  const seen = new Set<GateKey>()
  let lastGateAt = -1
  let gateIndent = ''
  let toolAt = -1
  let configIndent: string | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const gate = GATE_LINE.exec(line)
    if (gate !== null) {
      const key = gate[2] as GateKey
      seen.add(key)
      const indent = gate[1] ?? ''
      const comment = gate[4] === undefined ? '' : '  ' + gate[4]
      lines[index] = indent + key + ': ' + (gates[key] ? 'true' : 'false') + comment
      lastGateAt = index
      gateIndent = indent
      continue
    }
    if (toolAt === -1 && /^\s*tool\s*:\s*(#.*)?$/.test(line)) toolAt = index
    const config = /^(\s*)config\s*:/.exec(line)
    if (configIndent === undefined && config !== null) configIndent = config[1] ?? ''
  }
  const missing = GATE_KEYS.filter((key) => !seen.has(key))
  if (missing.length === 0) return lines.join(nl)
  const rendered = missing.map((key) => key + ': ' + (gates[key] ? 'true' : 'false'))
  if (lastGateAt >= 0) {
    // Beside the gates already present: same indentation, same section.
    lines.splice(lastGateAt + 1, 0, ...rendered.map((line) => gateIndent + line))
    return lines.join(nl)
  }
  if (toolAt >= 0) {
    const indent = (/^\s*/.exec(lines[toolAt] ?? '')?.[0] ?? '') + '  '
    lines.splice(toolAt + 1, 0, ...rendered.map((line) => indent + line))
    return lines.join(nl)
  }
  // No tool section at all: add one just above the closing marker, inside config.
  const endAt = lines.findIndex((line) => line.trim() === END || line.trim() === LEGACY_END)
  const configPad = (configIndent ?? '') + '  '
  const insert = [configPad + 'tool:', ...rendered.map((line) => configPad + '  ' + line)]
  if (endAt === -1) return lines.concat(insert).join(nl)
  lines.splice(endAt, 0, ...insert)
  return lines.join(nl)
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

/**
 * A **top-level** loader row for `id: browser` that is not inside a managed block.
 *
 * Why this exists (2026-11-12, found while writing the settings-card tests): when the
 * user's patch layer already carried an unmarked `- id: browser` row (hand-edited, or
 * written by a version before the markers existed), `mergeBrowserBlock` used to append
 * the full template — producing **two loader rows for the same id**. The loader then
 * sees the package twice, which is the same class of failure as issue #4 (a save writes
 * a patch that breaks the next start). Adopting the row instead keeps the user's keys
 * and leaves exactly one row.
 *
 * @param original - the whole patch file
 * @returns the row's bounds, or undefined when there is none
 */
function findUnmarkedRow(
  original: string,
): { start: number; end: number; namesUs: boolean; indent: number } | undefined {
  const head = /^([ \t]*)-[ \t]+id:[ \t]*browser[ \t]*(?:#.*)?$/m.exec(original)
  if (head === null) return undefined
  const start = head.index
  const indent = (head[1] ?? '').length
  const bodyStart = start + head[0].length
  // The row ends at the next sequence item at the same (or a shallower) indent.
  let end = original.length
  const item = /^([ \t]*)-[ \t]+/gm
  item.lastIndex = bodyStart
  for (let found = item.exec(original); found !== null; found = item.exec(original)) {
    if ((found[1] ?? '').length <= indent) {
      end = found.index
      break
    }
  }
  const body = original.slice(start, end)
  const namesUs = /['"]dsh-browser-playwright-codex['"]/.test(body)
  return { start, end, namesUs, indent }
}

/**
 * Merge the gate values into `original`.
 *
 * - No managed block yet → append the full template (nothing to preserve).
 * - Block present → rewrite ONLY the three gate lines (see patchBlockGates).
 * - Block present but its structure defeats line editing (a flow-style
 *   `tool: { ... }`, a truncated block) → fall back to the whole template, which
 *   is the old behaviour: at least the switch the user just flipped takes
 *   effect. Guarded by a read-back check so a half-edited block can never be
 *   written out.
 */
export function mergeBrowserBlock(
  original: string,
  allowEvaluate: boolean,
  allowCdp: boolean,
  diagnostics: boolean,
): string {
  const gates: GateValues = { allowEvaluate, allowCdp, diagnostics }
  const found = findBlock(original)
  if (found === undefined) {
    const row = findUnmarkedRow(original)
    if (row !== undefined) {
      // An unmarked row already mounts this package. Wrapping it (instead of appending a
      // second one) is what keeps "one loader row per package" true — the same invariant
      // the 0.7.0 merge had to satisfy.
      if (!row.namesUs) {
        // It is somebody else's `- id: browser` row. Refuse rather than write a file that
        // mounts two different packages under one id: a clear error now beats a fatal start.
        throw new Error(
          'the home patch already has an `- id: browser` row that is not this package; ' +
            'refusing to add a second row for the same id — rename one of them by hand, then retry',
        )
      }
      const nl = original.includes('\r\n') ? '\r\n' : '\n'
      const body = original.slice(row.start, row.end).replace(/[ \t]+$/, '')
      const wrapped = BEGIN + nl + body + nl + END + nl
      const edited = patchBlockGates(wrapped, gates)
      const check = parseBrowserBlock(edited)
      if (
        check !== undefined &&
        check.allowEvaluate === allowEvaluate &&
        check.allowCdp === allowCdp &&
        check.diagnostics === diagnostics
      ) {
        return original.slice(0, row.start) + edited + original.slice(row.end)
      }
      const rebuilt = BEGIN + nl + renderBrowserBlock(allowEvaluate, allowCdp, diagnostics) + END + nl
      return original.slice(0, row.start) + rebuilt + original.slice(row.end)
    }
    const block = renderBrowserBlock(allowEvaluate, allowCdp, diagnostics)
    return (original === '' || original.endsWith('\n') ? original : original + '\n') + '\n' + block
  }
  const current = original.slice(found.start, found.after)
  const edited = patchBlockGates(current, gates)
  const check = parseBrowserBlock(edited)
  if (
    check !== undefined &&
    check.allowEvaluate === allowEvaluate &&
    check.allowCdp === allowCdp &&
    check.diagnostics === diagnostics
  ) {
    return original.slice(0, found.start) + edited + original.slice(found.after)
  }
  const rebuilt = renderBrowserBlock(allowEvaluate, allowCdp, diagnostics)
  return original.slice(0, found.start) + rebuilt + original.slice(found.after)
}

/** Read the current managed block, or undefined when there is none. */
export function parseBrowserBlock(
  text: string,
): { allowEvaluate: boolean; allowCdp: boolean; diagnostics: boolean } | undefined {
  const found = findBlock(text)
  if (found === undefined) return undefined
  const body = text.slice(found.start, found.after)
  const evaluate = /allowEvaluate:\s*(true|false)/.exec(body)
  const cdp = /allowCdp:\s*(true|false)/.exec(body)
  if (evaluate === null || cdp === null) return undefined
  const diag = /diagnostics:\s*(true|false)/.exec(body)
  return {
    allowEvaluate: evaluate[1] === 'true',
    allowCdp: cdp[1] === 'true',
    diagnostics: diag === null ? false : diag[1] === 'true',
  }
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
  diagnostics: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ patch: string; allowEvaluate: boolean; allowCdp: boolean; diagnostics: boolean }> {
  const file = homePatchPath(env)
  let original = ''
  try {
    original = await readFile(file, 'utf8')
  } catch {
    original = ''
  }
  const next = mergeBrowserBlock(original, allowEvaluate, allowCdp, diagnostics)
  if (original !== '') await copyFile(file, file + '.bak-browser-toggle').catch(() => {})
  const tmp = file + '.tmp-browser-toggle'
  await writeFile(tmp, next, 'utf8')
  await rename(tmp, file)
  const check = await readFile(file, 'utf8')
  const parsed = parseBrowserBlock(check)
  if (
    parsed === undefined ||
    parsed.allowEvaluate !== allowEvaluate ||
    parsed.allowCdp !== allowCdp ||
    parsed.diagnostics !== diagnostics
  ) {
    if (original !== '') {
      await writeFile(file, original, 'utf8')
      throw new Error('patch self-check failed after write; previous content restored')
    }
    throw new Error('patch self-check failed after write')
  }
  return { patch: file, allowEvaluate, allowCdp, diagnostics }
}

// ---------------------------------------------------------------------------
// launch.proxy —— 设置页里的「代理」输入框
// ---------------------------------------------------------------------------
// 只增改 `playwright.launch` 下的 proxy 这一行：与三个闸门是同一个模式（已知键、按行改），
// 不是"能写任意键"。空字符串 = 删掉那一行（留空=直连必须是干净的，不能留个空值在文件里）。
// 结构认不出来时**拒绝写入**（文件一个字节不动），绝不整块重渲染 —— 那会抹掉 profileDir。

/** 托管块里 `playwright.launch` 的定位结果。 */
interface LaunchSection {
  /** `launch:` 那一行的下标 */
  readonly at: number
  /** `launch:` 的缩进 */
  readonly indent: number
  /** 子键该用的缩进（从现有兄弟行推断，推断不出就用 indent + 2 空格） */
  readonly childIndent: string
  /** 现有 proxy 行：下标与缩进 */
  readonly proxy?: { readonly at: number; readonly indent: string }
}

/** 在块的文本里找 `launch:` 与它的 `proxy:` 子行。认不出结构就抛错（拒绝写入）。 */
function findLaunchSection(lines: readonly string[]): LaunchSection {
  let launchAt = -1
  let launchIndent = ''
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)launch\s*:\s*(#.*)?$/.exec(lines[i] ?? '')
    if (m !== null) {
      launchAt = i
      launchIndent = m[1] ?? ''
      break
    }
  }
  if (launchAt === -1) {
    throw new Error(
      'the managed block has no `playwright.launch:` section, so launch.proxy cannot be edited safely; ' +
        'nothing was written. Fix the block by hand (or remove it and save a gate once to rebuild it).',
    )
  }
  const baseIndent = launchIndent.length
  let childIndent = ''
  let proxy
  for (let i = launchAt + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    if (trimmed === '') continue
    const indent = (/^\s*/.exec(line)?.[0] ?? '').length
    if (indent <= baseIndent) break // 出了 launch 这一节
    if (trimmed.startsWith('#')) continue
    if (childIndent === '') childIndent = ' '.repeat(indent)
    const p = /^(\s*)proxy\s*:/.exec(line)
    if (p !== null) proxy = { at: i, indent: p[1] ?? '' }
  }
  return {
    at: launchAt,
    indent: baseIndent,
    childIndent: childIndent === '' ? ' '.repeat(baseIndent + 2) : childIndent,
    ...(proxy === undefined ? {} : { proxy }),
  }
}

/**
 * 改写块里的 proxy 行：有就改、没有就插、空字符串就删。其它行逐字节保留。
 *
 * @param body - 托管块全文（含标记）
 * @param proxy - 已经过 normalizeProxy 校验的地址；'' 表示删掉这一行
 * @returns 改好的块
 */
export function patchBlockProxy(body: string, proxy: string): string {
  const nl = body.includes('\r\n') ? '\r\n' : '\n'
  const lines = body.split(/\r?\n/)
  const section = findLaunchSection(lines)
  const value = proxy.trim()
  const rendered = section.childIndent + 'proxy: ' + JSON.stringify(value)
  if (section.proxy !== undefined) {
    if (value === '') lines.splice(section.proxy.at, 1)
    else lines[section.proxy.at] = rendered
    return lines.join(nl)
  }
  if (value === '') return lines.join(nl) // 本来就没有，删空是幂等的
  lines.splice(section.at + 1, 0, rendered)
  return lines.join(nl)
}

/** 读托管块里的 proxy 值；没有就是 ''（= 直连）。 */
export function parseBrowserBlockProxy(text: string): string {
  const found = findBlock(text)
  if (found === undefined) return ''
  const body = text.slice(found.start, found.after)
  const lines = body.split(/\r?\n/)
  let section: LaunchSection | undefined
  try {
    section = findLaunchSection(lines)
  } catch {
    return ''
  }
  if (section?.proxy === undefined) return ''
  const raw = (lines[section.proxy.at] ?? '').replace(/^\s*proxy\s*:\s*/, '')
  const withoutComment = raw.replace(/\s+#.*$/, '').trim()
  if (withoutComment === '') return ''
  if (
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    return withoutComment.slice(1, -1)
  }
  return withoutComment
}

/**
 * 把 proxy 合并进文件内容：没有托管块就先按模板建一个，再改这一行。
 *
 * @param original - 原文件内容
 * @param proxy - 已校验的地址；'' = 删掉
 * @returns 新文件内容
 */
export function mergeBrowserBlockProxy(original: string, proxy: string): string {
  const value = proxy.trim()
  let base = original
  let found = findBlock(base)
  if (found === undefined) {
    base = (base === '' || base.endsWith('\n') ? base : base + '\n') + '\n' + renderBrowserBlock(false, false, false)
    found = findBlock(base)
  }
  if (found === undefined) throw new Error('could not create the managed block; nothing was written')
  const edited = patchBlockProxy(base.slice(found.start, found.after), value)
  if (parseBrowserBlockProxy(edited) !== value) {
    throw new Error('proxy line self-check failed; nothing was written')
  }
  return base.slice(0, found.start) + edited + base.slice(found.after)
}

/**
 * 写 proxy：备份 → 原子替换 → 读回校验；校验失败恢复原文件。
 *
 * @param proxy - 已校验的地址；'' 表示删掉这一行（= 直连）
 * @param env - 环境（测试用 DSH_HOME 覆盖）
 * @returns 写到的文件与现在的值
 */
export async function writeProxy(
  proxy: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ patch: string; proxy: string }> {
  const file = homePatchPath(env)
  const value = proxy.trim()
  let original = ''
  try {
    original = await readFile(file, 'utf8')
  } catch {
    original = ''
  }
  const next = mergeBrowserBlockProxy(original, value)
  if (original !== '') await copyFile(file, file + '.bak-browser-toggle').catch(() => {})
  const tmp = file + '.tmp-browser-toggle'
  await writeFile(tmp, next, 'utf8')
  await rename(tmp, file)
  const check = await readFile(file, 'utf8')
  if (parseBrowserBlockProxy(check) !== value) {
    if (original !== '') {
      await writeFile(file, original, 'utf8')
      throw new Error('proxy self-check failed after write; previous content restored')
    }
    throw new Error('proxy self-check failed after write')
  }
  return { patch: file, proxy: value }
}
