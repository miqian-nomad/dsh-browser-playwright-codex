/**
 * Where saved scripts live: one JSON file per script under `~/.dsh/browser-scripts`.
 *
 * Kept deliberately dumb — read, write, list — because the interesting rules
 * (what a step may contain, what may run) live in `script-steps.ts` and
 * `script-runner.ts`. A store that also validated would be the second place to
 * change when the step vocabulary grows.
 *
 * Names are restricted to a flat, boring charset and are never joined onto a
 * path unvalidated: a script name reaches `path.join`, so `../` in a name would
 * otherwise write anywhere the process can reach.
 * @module dsh-browser-playwright-codex/script-store
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScriptStepError, parseScriptSteps } from "./script-steps.js";
/** A script name: letters, digits, dash and underscore, starting with a letter or digit. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Directory holding the saved scripts. `DSH_BROWSER_SCRIPTS_DIR` overrides it (tests). */
export function scriptsDir() {
    const override = process.env.DSH_BROWSER_SCRIPTS_DIR;
    if (override !== undefined && override !== '')
        return override;
    return path.join(os.homedir(), '.dsh', 'browser-scripts');
}
/** Validate a script name, returning the trimmed value. */
export function validName(raw) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!NAME_RE.test(name)) {
        throw new ScriptStepError(1, 'script name must be 1-64 characters of letters, digits, dash or underscore — got ' +
            (name === '' ? '(empty)' : '"' + name + '"'));
    }
    return name;
}
/** Path of one script file. */
function scriptPath(name) {
    return path.join(scriptsDir(), name + '.json');
}
/**
 * Write a script, replacing any file of the same name.
 *
 * @param name - Validated script name.
 * @param steps - Steps already validated by `parseScriptSteps`.
 * @returns The file path and how many steps were stored.
 */
export function saveScript(name, steps) {
    const file = scriptPath(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = JSON.stringify({ name, savedAt: new Date().toISOString(), steps }, null, 2);
    // Write next to the target, then rename: a half-written file left by a crash
    // would otherwise load as a script that silently lost its last steps.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
    return { path: file, steps: steps.length };
}
/**
 * Read one script.
 *
 * @param name - Validated script name.
 * @param maxSteps - Cap applied to the file's steps, so an edited file cannot
 *   smuggle in a longer list than the tool accepts.
 */
export function loadScript(name, maxSteps) {
    // Validated here as well as at the tool boundary: this is exported, and a
    // name that reaches `path.join` unvalidated is the one way out of the folder.
    const safe = validName(name);
    const file = scriptPath(safe);
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    }
    catch {
        throw new ScriptStepError(1, 'no saved script named "' + safe + '"; save one with the save tool, or pass steps inline');
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new ScriptStepError(1, 'the saved script "' + safe + '" is not valid JSON; save it again');
    }
    const record = parsed;
    const steps = parseScriptSteps(record.steps, maxSteps);
    return {
        name: safe,
        savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
        steps,
    };
}
/** Names of the saved scripts, sorted. Missing directory means none yet. */
export function listScripts() {
    try {
        return fs
            .readdirSync(scriptsDir())
            .filter((entry) => entry.endsWith('.json'))
            .map((entry) => entry.slice(0, -'.json'.length))
            .sort();
    }
    catch {
        return [];
    }
}
