import { CAPTCHA_ROLES, CAPTCHA_WORD, CHALLENGE_SIGNATURES, WORDING_COMMAND, WORDING_EXCLUDE, WORDING_TITLE, } from "./challenge-signatures.js";
/** How many accessible names the wording tiers may look at. */
const MAX_NAMES = 60;
/**
 * The widget tier reads deeper than the wording tiers. Measured 2026-10-17 on
 * nopecha.com/demo/hcaptcha: a real hCaptcha iframe named
 * "包含 hCaptcha 安全挑战复选框的小部件" sits below depth 2, so a three-level scan
 * never saw it and the real widget was reported as NO MATCH. Vendor widgets are
 * usually mounted inside a wrapper stack; control labels are not.
 */
const WIDGET_DEPTH = 8;
/** Cap on names the widget tier walks (deeper scan, so a larger budget). */
const MAX_WIDGET_NAMES = 150;
/** A control label is short; a sentence that merely mentions captchas is not. */
const MAX_CONTROL_LABEL = 32;
/**
 * A title that mentions verification only counts on a page with (almost) nothing
 * to click. Measured on real pages 2026-10-17: 百度's actual 安全验证 page has
 * **0** actionable elements, while a Baidu *search result* page titled
 * "安全验证_百度搜索" has 57 and "滑块验证_百度搜索" has 81. Without this gate the
 * title tier fires on any search for those words — which is exactly the query a
 * person investigating captchas types.
 */
const TITLE_WORDING_MAX_REFS = 5;
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
    // The widget tier gets its own, deeper scan (see WIDGET_DEPTH).
    const widgetNames = [];
    scan(snapshot.nodes, 0, WIDGET_DEPTH, widgetNames, MAX_WIDGET_NAMES);
    const headers = snapshot.response?.headers;
    const status = snapshot.response?.status;
    const refs = snapshot.refs;
    /**
     * Some vendors put their header on every response, so the header alone is not a
     * block: DataDome attaches `x-datadome*` to everything (their docs) and Imperva
     * attaches `x-iinfo` to everything. A signature that lists `statuses` must have
     * the status agree, or a perfectly good page is reported as a wall.
     */
    const statusAgrees = (required) => required === undefined || (status !== undefined && required.includes(status));
    // Tier 1 — the vendor's own response metadata. This is their published API:
    // Cloudflare documents cf-mitigated: challenge as the supported way to detect
    // a challenge page, so a rename breaks every customer integration, not just us.
    for (const signature of CHALLENGE_SIGNATURES) {
        if (!statusAgrees(signature.statuses))
            continue;
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
        // No ref-count gate here on purpose. An earlier version required the page to be
        // nearly unusable before a vendor iframe counted, which suppressed a genuine
        // reCAPTCHA / hCaptcha / Turnstile simply because the login page around it had
        // links (measured: a busy login page stopped being recognised at all). Login
        // pages are the main case for this check, so the frame wins: a v3 badge on an
        // ordinary page is reported as "a captcha is embedded here", which is true.
        for (const node of widgetNames) {
            // Frames only. The vendor's own widget is a frame in every real sample measured
            // (reCAPTCHA, hCaptcha, Turnstile, Arkose): the deep scan exists to reach it.
            // Accepting a token on an ordinary node was a regression — an article titled
            // "How hCaptcha works" has h2/p nodes with the vendor word in them, and the
            // wording elsewhere on the page ("verification", "challenge") then corroborated
            // it, so a perfectly ordinary blog post rendered as a captcha wall.
            if (node.role !== 'iframe' && node.role !== 'frame')
                continue;
            if (!tokens.some((token) => token.test(node.name)))
                continue;
            return {
                engine: signature.engine,
                hint: signature.hint,
                tier: 'widget',
                evidence: node.name.slice(0, 60),
            };
        }
    }
    // Tier 3 — wording, weakest of the three. A title is short and written by the
    // interceptor, so it stands almost alone: the one extra condition is that the
    // page must also be unusable (see TITLE_WORDING_MAX_REFS). A caller that does
    // not report a ref count is treated as "nothing to click", because the
    // alternative is silently switching this tier off.
    // Fail closed: a caller that does not report a ref count gets no title tier at all.
    // Leaving the gate open when refs was missing is how the false positive came back
    // (the tests themselves passed a BrowserSnapshot, which has totalRefs but no refs).
    const unusablePage = refs !== undefined && refs <= TITLE_WORDING_MAX_REFS;
    const head = title + ' ' + url;
    if (unusablePage) {
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
    }
    // Control-level wording is not gated the same way: it needs a short label on a
    // control role, which an ordinary results page does not carry.
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
/**
 * The hint appended when a challenge page is recognised. It has to know the
 * window mode: headless has no window to complete a slider in, so telling the
 * user to "finish it in the open window" would be false.
 *
 * @param headless - the mode the provider is running in
 */
export function challengeNote(headless) {
    if (headless) {
        return ('[human verification] The page triggered an anti-bot challenge; it is NOT solvable by automation and must NOT be retried blindly. ' +
            'The browser is running HEADLESS, so there is no window to finish it in — do not wait for a human to click anything here. ' +
            'Stop and tell the user: either switch the window mode to 显示浏览器窗口 in Settings → 浏览器 and let them complete the verification, ' +
            'or handle this site another way. Once a clearance cookie is obtained (in a headful window) it is saved to the profile and keeps working for the session.');
    }
    return CHALLENGE_NOTE;
}
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
/**
 * Appended when a page has nothing to click and almost nothing to read. This is
 * the blind spot the no-progress backstop cannot cover: that tier needs an action
 * to compare before and after, and on a page with zero actionable elements the
 * agent has no action to take — so the emptiest, most wall-like pages used to
 * produce no message at all. Measured 2026-10-17 on 微博's visitor gate: the model
 * received 364 characters, all of them "URL / Title / Refs: 0 / (no visible
 * elements)", and nothing said the page was a gate rather than an empty document.
 */
export const SILENT_PAGE_NOTE = '[nothing here] this page has no clickable elements and almost no text: it may be a gate or visitor check that resolves by itself, a page that is still loading, or a page that needs a person. Wait a moment and take one more browser_snapshot; if it still looks like this, tell the user what you were trying to open and ask them to look at the open window, instead of re-sending the same navigation.';
/** A page with no named node at all counts as "almost no text". Strict on purpose:
 * one heading plus one paragraph is a normal page, not a silent one. */
const SILENT_PAGE_MAX_NAMES = 0;
/**
 * Whether the page is a silent one: nothing to click and (almost) nothing to read.
 * @param input - the action ref count and the accessible tree.
 * @returns the advisory note, or null when the page has content worth reading.
 */
export function detectSilentPage(input) {
    if (input.refs > 0)
        return null;
    // A page with no title at all is a bare document (about:blank, a raw image):
    // calling that "maybe a gate" is noise, not a warning.
    if (input.title !== undefined && input.title.trim() === '')
        return null;
    const names = [];
    // Read as deep as the widget scan: a page whose only text sits six levels down is
    // a normal page, and a depth-4 scan called it "almost no text" (review, P1-3).
    scan(input.nodes, 0, WIDGET_DEPTH, names, SILENT_PAGE_MAX_NAMES + 1);
    return names.length <= SILENT_PAGE_MAX_NAMES ? SILENT_PAGE_NOTE : null;
}
