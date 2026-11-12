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
import { readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Managed block markers: everything between them belongs to this plugin. */
export const BEGIN = '# >>> dsh-browser: 浏览器插件配置（本块由设置页维护，也可手工编辑）>>>';
export const END = '# <<< dsh-browser <<<';
/**
 * The pre-merge markers, written by dsh-browser-toggle 0.3.0. Accepted so an
 * existing block is replaced in place instead of accumulating a second row that
 * would patch the same entry twice.
 */
export const LEGACY_BEGIN = '# >>> dsh-browser-toggle: 强力工具闸门（本块由设置页维护，也可手工编辑）>>>';
export const LEGACY_END = '# <<< dsh-browser-toggle <<<';
/** Path of the home-level patch layer (highest priority among patch files). */
export function homePatchPath(env = process.env) {
    return join(env.DSH_HOME || join(homedir(), '.dsh'), 'cordis.patch.yml');
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
export function renderBrowserBlock(allowEvaluate, allowCdp, diagnostics) {
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
    ].join('\n');
}
/** The three gate keys, in the order a freshly created block writes them. */
const GATE_KEYS = ['allowEvaluate', 'allowCdp', 'diagnostics'];
/** One `key: value  # note` line of the managed block. */
const GATE_LINE = /^(\s*)(allowEvaluate|allowCdp|diagnostics)(\s*:\s*)(?:true|false)?[ \t]*(#.*)?$/;
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
export function patchBlockGates(body, gates) {
    const nl = body.includes('\r\n') ? '\r\n' : '\n';
    const lines = body.split(/\r?\n/);
    const seen = new Set();
    let lastGateAt = -1;
    let gateIndent = '';
    let toolAt = -1;
    let configIndent;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const gate = GATE_LINE.exec(line);
        if (gate !== null) {
            const key = gate[2];
            seen.add(key);
            const indent = gate[1] ?? '';
            const comment = gate[4] === undefined ? '' : '  ' + gate[4];
            lines[index] = indent + key + ': ' + (gates[key] ? 'true' : 'false') + comment;
            lastGateAt = index;
            gateIndent = indent;
            continue;
        }
        if (toolAt === -1 && /^\s*tool\s*:\s*(#.*)?$/.test(line))
            toolAt = index;
        const config = /^(\s*)config\s*:/.exec(line);
        if (configIndent === undefined && config !== null)
            configIndent = config[1] ?? '';
    }
    const missing = GATE_KEYS.filter((key) => !seen.has(key));
    if (missing.length === 0)
        return lines.join(nl);
    const rendered = missing.map((key) => key + ': ' + (gates[key] ? 'true' : 'false'));
    if (lastGateAt >= 0) {
        // Beside the gates already present: same indentation, same section.
        lines.splice(lastGateAt + 1, 0, ...rendered.map((line) => gateIndent + line));
        return lines.join(nl);
    }
    if (toolAt >= 0) {
        const indent = (/^\s*/.exec(lines[toolAt] ?? '')?.[0] ?? '') + '  ';
        lines.splice(toolAt + 1, 0, ...rendered.map((line) => indent + line));
        return lines.join(nl);
    }
    // No tool section at all: add one just above the closing marker, inside config.
    const endAt = lines.findIndex((line) => line.trim() === END || line.trim() === LEGACY_END);
    const configPad = (configIndent ?? '') + '  ';
    const insert = [configPad + 'tool:', ...rendered.map((line) => configPad + '  ' + line)];
    if (endAt === -1)
        return lines.concat(insert).join(nl);
    lines.splice(endAt, 0, ...insert);
    return lines.join(nl);
}
/** Locate the managed block, preferring the current markers over the legacy ones. */
function findBlock(original) {
    const markers = [
        [BEGIN, END],
        [LEGACY_BEGIN, LEGACY_END],
    ];
    for (const [begin, end] of markers) {
        const beginIdx = original.indexOf(begin);
        const endIdx = original.indexOf(end);
        if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
            let after = endIdx + end.length;
            if (original[after] === '\n')
                after += 1;
            return { start: beginIdx, after };
        }
    }
    return undefined;
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
function findUnmarkedRow(original) {
    const head = /^([ \t]*)-[ \t]+id:[ \t]*browser[ \t]*(?:#.*)?$/m.exec(original);
    if (head === null)
        return undefined;
    const start = head.index;
    const indent = (head[1] ?? '').length;
    const bodyStart = start + head[0].length;
    // The row ends at the next sequence item at the same (or a shallower) indent.
    let end = original.length;
    const item = /^([ \t]*)-[ \t]+/gm;
    item.lastIndex = bodyStart;
    for (let found = item.exec(original); found !== null; found = item.exec(original)) {
        if ((found[1] ?? '').length <= indent) {
            end = found.index;
            break;
        }
    }
    const body = original.slice(start, end);
    const namesUs = /['"]dsh-browser-playwright-codex['"]/.test(body);
    return { start, end, namesUs, indent };
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
export function mergeBrowserBlock(original, allowEvaluate, allowCdp, diagnostics) {
    const gates = { allowEvaluate, allowCdp, diagnostics };
    const found = findBlock(original);
    if (found === undefined) {
        const row = findUnmarkedRow(original);
        if (row !== undefined) {
            // An unmarked row already mounts this package. Wrapping it (instead of appending a
            // second one) is what keeps "one loader row per package" true — the same invariant
            // the 0.7.0 merge had to satisfy.
            if (!row.namesUs) {
                // It is somebody else's `- id: browser` row. Refuse rather than write a file that
                // mounts two different packages under one id: a clear error now beats a fatal start.
                throw new Error('the home patch already has an `- id: browser` row that is not this package; ' +
                    'refusing to add a second row for the same id — rename one of them by hand, then retry');
            }
            const nl = original.includes('\r\n') ? '\r\n' : '\n';
            const body = original.slice(row.start, row.end).replace(/[ \t]+$/, '');
            const wrapped = BEGIN + nl + body + nl + END + nl;
            const edited = patchBlockGates(wrapped, gates);
            const check = parseBrowserBlock(edited);
            if (check !== undefined &&
                check.allowEvaluate === allowEvaluate &&
                check.allowCdp === allowCdp &&
                check.diagnostics === diagnostics) {
                return original.slice(0, row.start) + edited + original.slice(row.end);
            }
            const rebuilt = BEGIN + nl + renderBrowserBlock(allowEvaluate, allowCdp, diagnostics) + END + nl;
            return original.slice(0, row.start) + rebuilt + original.slice(row.end);
        }
        const block = renderBrowserBlock(allowEvaluate, allowCdp, diagnostics);
        return (original === '' || original.endsWith('\n') ? original : original + '\n') + '\n' + block;
    }
    const current = original.slice(found.start, found.after);
    const edited = patchBlockGates(current, gates);
    const check = parseBrowserBlock(edited);
    if (check !== undefined &&
        check.allowEvaluate === allowEvaluate &&
        check.allowCdp === allowCdp &&
        check.diagnostics === diagnostics) {
        return original.slice(0, found.start) + edited + original.slice(found.after);
    }
    const rebuilt = renderBrowserBlock(allowEvaluate, allowCdp, diagnostics);
    return original.slice(0, found.start) + rebuilt + original.slice(found.after);
}
/** Read the current managed block, or undefined when there is none. */
export function parseBrowserBlock(text) {
    const found = findBlock(text);
    if (found === undefined)
        return undefined;
    const body = text.slice(found.start, found.after);
    const evaluate = /allowEvaluate:\s*(true|false)/.exec(body);
    const cdp = /allowCdp:\s*(true|false)/.exec(body);
    if (evaluate === null || cdp === null)
        return undefined;
    const diag = /diagnostics:\s*(true|false)/.exec(body);
    return {
        allowEvaluate: evaluate[1] === 'true',
        allowCdp: cdp[1] === 'true',
        diagnostics: diag === null ? false : diag[1] === 'true',
    };
}
/** Back-compat aliases used by the absorbed settings-card host half. */
export const parseGatesBlock = parseBrowserBlock;
/** Back-compat alias (see {@link mergeBrowserBlock}). */
export const mergeGatesBlock = mergeBrowserBlock;
/**
 * Write both gates into the home-level patch. Backup first, atomic rename, then
 * read back and check; on a failed check the previous bytes are restored.
 *
 * @param allowEvaluate - register browser_evaluate
 * @param allowCdp - register browser_cdp
 * @param env - environment (DSH_HOME override for tests)
 * @returns the file written and the values it now carries
 */
export async function writeGates(allowEvaluate, allowCdp, diagnostics, env = process.env) {
    const file = homePatchPath(env);
    let original = '';
    try {
        original = await readFile(file, 'utf8');
    }
    catch {
        original = '';
    }
    const next = mergeBrowserBlock(original, allowEvaluate, allowCdp, diagnostics);
    if (original !== '')
        await copyFile(file, file + '.bak-browser-toggle').catch(() => { });
    const tmp = file + '.tmp-browser-toggle';
    await writeFile(tmp, next, 'utf8');
    await rename(tmp, file);
    const check = await readFile(file, 'utf8');
    const parsed = parseBrowserBlock(check);
    if (parsed === undefined ||
        parsed.allowEvaluate !== allowEvaluate ||
        parsed.allowCdp !== allowCdp ||
        parsed.diagnostics !== diagnostics) {
        if (original !== '') {
            await writeFile(file, original, 'utf8');
            throw new Error('patch self-check failed after write; previous content restored');
        }
        throw new Error('patch self-check failed after write');
    }
    return { patch: file, allowEvaluate, allowCdp, diagnostics };
}
