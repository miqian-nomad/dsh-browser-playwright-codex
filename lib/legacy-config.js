/**
 * Legacy loader-row detection (2026-10-19 merge follow-up).
 *
 * 0.7.0 collapsed three loader rows (`browser-playwright`, `browser-tool`, and
 * the `/service` entry) into one `- id: browser` row with nested
 * `service` / `playwright` / `tool` config. The loader simply stops reading the
 * old rows, so an upgraded deployment whose patch layer still lists them starts
 * with the package defaults — and the package ships both power gates OFF.
 *
 * That failure is silent: nothing errors, the tools that the old row would have
 * published are simply absent, and the user believes a capability is still on.
 * A real 0.7.4 deployment was found in exactly this state (16 tools, no
 * `evaluate` / `cdp`, `allowEvaluate: true` sitting in a row nobody reads).
 *
 * This module reads the patch layers (read-only, never writes) and reports the
 * stale rows once per DSH home so the operator can fix the config instead of
 * discovering the downgrade through a missing tool.
 *
 * @module dsh-browser-playwright-codex/legacy-config
 */
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Row ids that 0.7.0 stopped reading. */
export const LEGACY_ROW_IDS = ['browser-playwright', 'browser-tool', 'browser-playwright-service'];
/**
 * Subpath entries that 0.7.0 stopped mounting. Rows naming one of these are
 * stale even when the user gave them some other id.
 */
export const LEGACY_ENTRY_NAMES = [
    'dsh-browser-playwright-codex/tool',
    'dsh-browser-playwright-codex/playwright',
    'dsh-browser-playwright-codex/service',
];
/**
 * Retired package names this project owns on npm. A row mounting one of them
 * keeps a second, older settings card alive — and that card rewrites the patch
 * layer in the pre-0.7.0 shape, so the fix keeps reverting.
 *
 * Matching is by package NAME, never by row id: `- id:` is a local label the
 * user picks, so another plugin may legitimately call its row `browser-tool`.
 * Only a row whose `name:` is one of ours is reported.
 */
export const RETIRED_PACKAGES = ['dsh-browser-playwright', 'dsh-browser-toggle'];
/** A `- id:` at column 0 starts a loader row. */
const ROW_ID = /^- id:\s*['"]?([A-Za-z0-9._-]+)['"]?\s*$/;
/** `name:` at exactly two spaces belongs to the row, not to a nested config block. */
const ROW_NAME = /^ {2}name:\s*['"]?([^'"\s#]+)['"]?\s*$/;
/**
 * Find loader rows in one patch file's text that 0.7.0 stopped reading.
 *
 * The evidence is always the row's `name:` — never its `- id:`, which is just a
 * local label. A patch layer that happens to call some unrelated plugin's row
 * `browser-tool` is not reported.
 *
 * Pure and text-only so the rule can be tested without touching a real patch
 * layer. Comments are ignored naturally: a commented row fails the anchored
 * `- id:` / `  name:` patterns.
 *
 * @param text - contents of a cordis.patch.yml layer
 * @returns every stale row, in file order
 */
export function findLegacyRowsIn(text) {
    const rows = [];
    const lines = text.split(/\r?\n/);
    let current;
    const finish = () => {
        const name = current?.name;
        if (name !== undefined && LEGACY_ENTRY_NAMES.includes(name)) {
            rows.push({
                id: current?.id ?? '(no id)',
                name,
                line: current?.line ?? 0,
                target: 'entry',
            });
        }
        else if (name !== undefined && RETIRED_PACKAGES.includes(name)) {
            rows.push({
                id: current?.id ?? '(no id)',
                name,
                line: current?.line ?? 0,
                target: 'package',
            });
        }
        current = undefined;
    };
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const id = ROW_ID.exec(line);
        if (id !== null) {
            finish();
            const value = id[1];
            if (value !== undefined)
                current = { id: value, line: index + 1 };
            continue;
        }
        if (current === undefined)
            continue;
        const name = ROW_NAME.exec(line);
        const label = name?.[1];
        if (label !== undefined && current.name === undefined)
            current.name = label;
    }
    finish();
    return rows;
}
/**
 * The operator-facing warning for one patch file.
 *
 * Written as one self-contained paragraph pair on purpose: it lands in a log
 * line, so it has to name the file, the rows, and the fix without the reader
 * opening documentation first.
 *
 * @param file - absolute path of the patch layer
 * @param rows - stale rows found in it
 * @returns the warning text
 */
export function legacyRowWarning(file, rows) {
    const listed = rows
        .map((row) => `  - 第 ${String(row.line)} 行: - id: ${row.id} (name: ${row.name ?? '?'})` +
        (row.target === 'package' ? '  ← 退役包' : '  ← 本插件 0.7.0 之前的入口'))
        .join('\n');
    const retired = rows.some((row) => row.target === 'package');
    return [
        'browser 插件发现 0.7.0 之前的旧加载行，当前版本不再读取它们 —— 那几行里的 config 全部不生效，',
        '插件按包内默认值运行（allowEvaluate / allowCdp 默认关闭，等于你以为开着其实关着）。',
        `文件: ${file}`,
        listed,
        ...(retired
            ? [
                '标了「退役包」的行挂的是本项目的旧包（dsh-browser-toggle / dsh-browser-playwright）：它们自带一张旧设置卡，',
                '还会按旧写法改写这个文件，所以只改下面这几行会反复被改回去 —— 先把那一行去掉或禁用。',
            ]
            : []),
        '改法：按 name 删掉这些旧行，然后打开一次设置页的「浏览器」卡片（它会整块重写成一行），',
        "或手写一行 `- id: browser` + `name: 'dsh-browser-playwright-codex'`，并把 service / playwright / tool 三节写全。",
        '判断依据是每行的 name（包名），不是 id —— id 只是本地标签，别人的插件也可能叫 browser-tool。',
        '如果你确认某个 name 不是本插件的包，那它跟这条提示无关，忽略即可。',
    ].join('\n');
}
/**
 * Patch layers that can hold a browser row: the home layer plus every profile
 * layer. Missing files and unreadable directories are skipped silently — this
 * check must never be the reason a plugin fails to load.
 *
 * @param env - environment (`DSH_HOME` override, as the rest of the package uses)
 * @returns candidate file paths, home layer first
 */
export async function patchLayers(env = process.env) {
    const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh');
    const files = [join(home, 'cordis.patch.yml')];
    const profiles = join(home, 'profiles');
    let entries = [];
    try {
        entries = await readdir(profiles);
    }
    catch {
        entries = [];
    }
    for (const entry of entries.sort())
        files.push(join(profiles, entry, 'cordis.patch.yml'));
    return files;
}
/**
 * Scan every patch layer for stale rows.
 *
 * @param env - environment (`DSH_HOME` override)
 * @returns one entry per file that still lists a retired row; empty when clean
 */
export async function scanLegacyRows(env = process.env) {
    const hits = [];
    for (const file of await patchLayers(env)) {
        let text = '';
        try {
            text = await readFile(file, 'utf8');
        }
        catch {
            continue;
        }
        const rows = findLegacyRowsIn(text);
        if (rows.length > 0)
            hits.push({ file, rows });
    }
    return hits;
}
/** DSH homes already scanned in this process, so one load logs once. */
const scannedHomes = new Set();
/**
 * Warn about stale loader rows, once per DSH home, never throwing.
 *
 * Call it from the plugin entry: it is advisory only, so a failure here must
 * never affect mounting the capability.
 *
 * @param ctx - plugin context (its logger carries the message to the host log)
 * @param env - environment (`DSH_HOME` override, as tests use)
 * @param report - sink for the text (defaults to the context logger, then console)
 */
export async function warnLegacyRows(ctx, env = process.env, report) {
    if (env.DSH_BROWSER_SKIP_LEGACY_SCAN === '1')
        return;
    const home = env.DSH_HOME !== undefined && env.DSH_HOME !== '' ? env.DSH_HOME : join(homedir(), '.dsh');
    if (scannedHomes.has(home))
        return;
    scannedHomes.add(home);
    let hits = [];
    try {
        hits = await scanLegacyRows(env);
    }
    catch {
        return;
    }
    if (hits.length === 0)
        return;
    const warn = report ?? loggerWarn(ctx);
    for (const hit of hits) {
        try {
            warn(legacyRowWarning(hit.file, hit.rows));
        }
        catch {
            // A logger that is not mounted yet must not break the load.
        }
    }
}
/** Best-effort warn sink: the context logger when it exists, otherwise console. */
function loggerWarn(ctx) {
    return (text) => {
        try {
            if (ctx.logger !== undefined) {
                ctx.logger.warn(text);
                return;
            }
        }
        catch {
            // fall through to console
        }
        console.warn(text);
    };
}
