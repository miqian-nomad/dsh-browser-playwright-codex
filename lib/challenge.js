import { CAPTCHA_ROLES, CAPTCHA_WORD, CHALLENGE_SIGNATURES, WIDGET_CORROBORATION, WORDING_COMMAND, WORDING_EXCLUDE, WORDING_TITLE, } from "./challenge-signatures.js";
/** How many accessible names the wording tiers may look at. */
const MAX_NAMES = 60;
/** Cap on the joined text handed to the wording tiers. */
const MAX_TEXT = 900;
/** A control label is short; a sentence that merely mentions captchas is not. */
const MAX_CONTROL_LABEL = 32;
/** Cap on names folded into one page-state fingerprint. */
const MAX_FINGERPRINT_NAMES = 200;
/**
 * How deep the fingerprint reads. Deeper than the wording tiers on purpose: a
 * fingerprint that only saw the top of the tree would call a page "unchanged"
 * when a deep section revealed text without adding a new actionable element,
 * and the backstop would then warn about a wall that is not there.
 */
const FINGERPRINT_DEPTH = 4;
/** Collect accessible names breadth-first, bounded by depth and count. */
function scan(nodes, depth, maxDepth, out, cap) {
    if (nodes === undefined || out.length >= cap)
        return;
    for (const node of nodes) {
        if (out.length >= cap)
            return;
        const name = node.name ?? '';
        if (name !== '')
            out.push({ role: (node.role ?? '').toLowerCase(), name });
        if (depth < maxDepth)
            scan(node.children, depth + 1, maxDepth, out, cap);
    }
}
/** Evidence string when one header rule holds, else null. */
function headerEvidence(rule, headers) {
    if (headers === undefined)
        return null;
    const wanted = rule.name.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase() !== wanted)
            continue;
        const value = headers[key] ?? '';
        const lower = value.toLowerCase();
        if (rule.equals !== undefined && lower !== rule.equals.toLowerCase())
            return null;
        if (rule.contains !== undefined && !lower.includes(rule.contains.toLowerCase()))
            return null;
        return key + ': ' + value;
    }
    return null;
}
/** Evidence string when any header name carries the prefix, else null. */
function prefixEvidence(prefix, headers) {
    if (headers === undefined)
        return null;
    const wanted = prefix.toLowerCase();
    for (const key of Object.keys(headers)) {
        if (key.toLowerCase().startsWith(wanted))
            return key + ': ' + (headers[key] ?? '');
    }
    return null;
}
/**
 * Detect an anti-bot / human-verification surface from the MAIN document
 * response metadata, the page's accessible names and, as a last resort, its
 * wording. We never try to solve one: the correct move for an agent is to hand
 * it to the human who can see the open window.
 * @param snapshot - title, url, accessible tree and (when available) the main document response.
 * @returns the matched engine with its tier and the concrete evidence, else null.
 */
export function detectChallenge(snapshot) {
    const title = snapshot.title ?? '';
    const url = snapshot.url ?? '';
    const names = [];
    scan(snapshot.nodes, 0, 2, names, MAX_NAMES);
    const headers = snapshot.response?.headers;
    // Tier 1 — the vendor's own response metadata. This is their published API:
    // Cloudflare documents cf-mitigated: challenge as the supported way to detect
    // a challenge page, so a rename breaks every customer integration, not just us.
    for (const signature of CHALLENGE_SIGNATURES) {
        for (const rule of signature.headers ?? []) {
            const evidence = headerEvidence(rule, headers);
            if (evidence !== null) {
                return { engine: signature.engine, hint: signature.hint, tier: 'response-header', evidence };
            }
        }
        for (const prefix of signature.headerPrefixes ?? []) {
            const evidence = prefixEvidence(prefix, headers);
            if (evidence !== null) {
                return { engine: signature.engine, hint: signature.hint, tier: 'response-header', evidence };
            }
        }
    }
    // Tier 2 — the vendor's own widget, by accessible name. An iframe's title is
    // authored by the vendor, so it stands alone; the same word on an ordinary
    // node needs corroboration from somewhere else on the page, because a page may
    // simply discuss that vendor. Corroboration deliberately excludes the matched
    // node itself: "reCAPTCHA" contains "captcha", and letting a token corroborate
    // itself would make this guard vacuous.
    for (const signature of CHALLENGE_SIGNATURES) {
        const tokens = signature.widgetTokens;
        if (tokens === undefined)
            continue;
        for (const node of names) {
            if (!tokens.some((token) => token.test(node.name)))
                continue;
            const onFrame = node.role === 'iframe' || node.role === 'frame';
            if (!onFrame) {
                const others = [title, url, ...names.filter((other) => other !== node).map((other) => other.name)]
                    .join(' | ')
                    .slice(0, MAX_TEXT);
                const corroborated = WIDGET_CORROBORATION.some((token) => token.test(others));
                if (!corroborated)
                    continue;
            }
            return {
                engine: signature.engine,
                hint: signature.hint,
                tier: 'widget',
                evidence: node.name.slice(0, 60),
            };
        }
    }
    // Tier 3 — wording, weakest of the three. A title is short and written by the
    // interceptor, so it stands alone; on a node we require a command form (or a
    // captcha control), which is the difference between a challenge and a help
    // page about captchas.
    const head = title + ' ' + url;
    for (const signature of CHALLENGE_SIGNATURES) {
        for (const pattern of signature.titleWording ?? []) {
            if (!pattern.test(head))
                continue;
            return {
                engine: signature.engine,
                hint: signature.hint,
                tier: 'wording',
                evidence: 'title: ' + title.slice(0, 60),
            };
        }
    }
    for (const pattern of WORDING_TITLE) {
        if (!pattern.test(head))
            continue;
        return {
            engine: 'human-verification',
            hint: 'the page is asking to verify a human visitor',
            tier: 'wording',
            evidence: 'title: ' + title.slice(0, 60),
        };
    }
    for (const node of names) {
        if (node.name.length > MAX_CONTROL_LABEL)
            continue;
        if (WORDING_EXCLUDE.some((pattern) => pattern.test(node.name)))
            continue;
        const captchaControl = CAPTCHA_WORD.test(node.name) && CAPTCHA_ROLES.has(node.role);
        const command = WORDING_COMMAND.some((pattern) => pattern.test(node.name));
        if (!captchaControl && !command)
            continue;
        return {
            engine: 'human-verification',
            hint: 'the page is asking to verify a human visitor',
            tier: 'wording',
            evidence: node.role + ': ' + node.name.slice(0, 60),
        };
    }
    return null;
}
/**
 * Instruction appended above a snapshot when the page is an anti-bot
 * challenge. The browser window is visible on the user's desktop: the agent
 * should pause and ask the user to complete it by hand, then re-snapshot.
 */
export const CHALLENGE_NOTE = "[human verification] The page triggered an anti-bot challenge; it is NOT solvable by automation and must NOT be retried blindly. The browser window is open on the user's desktop — tell the user a verification appeared, wait for them to finish it (a few seconds), then call browser_snapshot again. The clearance cookie is saved to the profile automatically and keeps working for the session.";
/**
 * Appended after an action that left the page byte-for-byte unchanged on a page
 * with almost nothing else to interact with. Worded as a guess, because that is
 * what it is: it is the shape an unrecognised wall has, and the whole point of
 * this tier is to cover the vendors we have no signature for.
 */
export const NO_PROGRESS_NOTE = '[no visible change] that action left the page identical — same URL, same title, same elements — and the page offers almost nothing else to click. This is a guess, not a diagnosis: it is what an unrecognised anti-bot wall looks like. Take one browser_snapshot to confirm; if the page still looks unchanged, stop and tell the user what you were trying to do and ask them to look at the open window, instead of retrying the same action.';
/** A page with at most this many actionable elements counts as "nearly empty". */
export const NO_PROGRESS_MAX_REFS = 3;
/** Cheap, order-stable hash (djb2) so a fingerprint costs no prompt budget. */
function hash(text) {
    let value = 5381;
    for (let index = 0; index < text.length; index += 1) {
        value = ((value << 5) + value + text.charCodeAt(index)) >>> 0;
    }
    return value.toString(36);
}
/**
 * Identity of one page state: URL, title, actionable-element count and the
 * accessible labels. Two captures with the same fingerprint look the same to a
 * human glancing at the window, which is exactly the question this tier asks.
 * @param input - the slice of a snapshot the backstop compares.
 * @returns an opaque fingerprint string.
 */
export function snapshotFingerprint(input) {
    const names = [];
    scan(input.nodes, 0, FINGERPRINT_DEPTH, names, MAX_FINGERPRINT_NAMES);
    const material = [
        input.url ?? '',
        input.title ?? '',
        String(input.refs ?? 0),
        names.map((node) => node.role + '=' + node.name).join('\u0001'),
    ].join('\u0000');
    return hash(material);
}
/**
 * The no-progress backstop: a vendor we have never seen leaves no signature, so
 * we stop asking "which wall is this" and ask "did anything happen". Deliberately
 * conservative — it needs an identical page AND (a nearly empty page, or a second
 * identical result), so an ordinary click that is not meant to change anything
 * stays quiet.
 * @param input - whether an action just ran, the identical-capture streak, and the ref count.
 * @returns the advisory note, or null when the page is still plausibly alive.
 */
export function detectNoProgress(input) {
    if (!input.afterAction)
        return null;
    if (input.unchangedStreak < 1)
        return null;
    const nearlyEmpty = input.refs <= NO_PROGRESS_MAX_REFS;
    if (!nearlyEmpty && input.unchangedStreak < 2)
        return null;
    return NO_PROGRESS_NOTE;
}
