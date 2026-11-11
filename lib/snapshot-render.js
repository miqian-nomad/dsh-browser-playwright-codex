/**
 * Pure snapshot rendering: model-facing tree text. No I/O, no clock — these
 * functions run on live calls and on session replay alike.
 * @module dsh-browser-playwright-codex/snapshot-render
 */
/**
 * Query parameters that only feed analytics or the site's own ranking pipeline.
 * They make a rendered href several times longer than the link it names and the
 * model never needs them: the ref (not the URL) is what clicks.
 */
const TRACKING_PARAMS = new Set([
    'gclid',
    'dclid',
    'fbclid',
    'msclkid',
    'yclid',
    'spm',
    'scm',
    'share_token',
    'rsv_spt',
    'rsv_iqid',
    'rsv_bp',
    'rsv_idx',
    'rsv_enter',
    'rsv_pq',
    'rsv_t',
    'rsv_dl',
    'rsv_sug1',
    'rsv_sug2',
    'rsv_sug3',
    'rsv_sug4',
    'rsv_sug5',
    'rsv_sug6',
    'rsv_sug7',
    'rsv_sug8',
    'rsv_sug9',
    'rsv_sug10',
    'sa',
    'usm',
    'rqid',
    'rsf',
]);
/** Default cap for a rendered href, in characters. */
export const MAX_HREF_LENGTH = 160;
/**
 * Path shapes that mark a redirect-wrapping URL — a link that does not point at
 * its destination but at the site's own click-tracking endpoint, which forwards
 * there. Search engines wrap every organic result this way (Bing `/ck/a?...`,
 * Google `/url?q=...`, Facebook `l.php?u=...`). The real destination is encoded
 * in a long query parameter, so the rendered href is 160 characters of base64
 * that says nothing the link's own name does not — and it repeats for every
 * result on the page.
 *
 * This is a generic category (a tracking endpoint on the same origin as the
 * page), not a per-site special case. When one matches we render a short marker
 * instead of the wrapped URL: the ref is what clicks, and the link's name plus
 * any destination node already carry the meaning.
 */
const REDIRECT_WRAPPERS = [/\/ck\/a\?/i, /\/url\?q=/i, /l\.php\?u=/i];
/** Clip a string to a display budget, marking the cut. */
function clip(value, maxLength) {
    return value.length <= maxLength ? value : value.slice(0, maxLength - 1) + '…';
}
/**
 * Trim a href for display: drop analytics parameters and clip the whole thing.
 * The snapshot's refs remain the interaction handle, so this only affects what
 * the model reads, never what a click does.
 *
 * @param href - the raw href from the accessibility tree
 * @param maxLength - display budget in characters
 * @returns the shortened href
 */
export function trimUrlForDisplay(href, maxLength = MAX_HREF_LENGTH) {
    // A redirect-wrapping href (search-engine click tracker) is 160 characters of
    // encoded destination that says nothing the link's name does not. Render a
    // short marker instead; the ref is what clicks, so this never changes where a
    // click lands — only what the model reads.
    if (REDIRECT_WRAPPERS.some((re) => re.test(href))) {
        return '→ (redirect wrapper)';
    }
    const hashAt = href.indexOf('#');
    const hash = hashAt >= 0 ? href.slice(hashAt) : '';
    const head = hashAt >= 0 ? href.slice(0, hashAt) : href;
    const queryAt = head.indexOf('?');
    if (queryAt < 0)
        return clip(head + hash, maxLength);
    const base = head.slice(0, queryAt);
    const kept = head
        .slice(queryAt + 1)
        .split('&')
        .filter((pair) => pair !== '')
        .filter((pair) => {
        let key = pair.split('=')[0] ?? '';
        try {
            key = decodeURIComponent(key);
        }
        catch {
            /* keep the raw key: an undecodable one is not a known tracker */
        }
        key = key.toLowerCase();
        return !key.startsWith('utm_') && !TRACKING_PARAMS.has(key);
    });
    return clip(base + (kept.length > 0 ? '?' + kept.join('&') : '') + hash, maxLength);
}
/**
 * A wrapper element with no name, ref, state or link of its own. Keeping it
 * would push every real element one level deeper and repeat the word "generic"
 * for every <div> on the page; dropping it keeps the structure the model needs
 * (nesting of things that have names) without the noise.
 */
function isTransparentWrapper(node) {
    return (node.role === 'generic' &&
        node.name === '' &&
        node.ref === undefined &&
        node.href === undefined &&
        node.level === undefined &&
        node.checked === undefined &&
        node.selected === undefined &&
        node.disabled === undefined &&
        node.value === undefined);
}
/** Render one node line into the accumulating line list. */
function renderNode(node, depth, lines, seenHrefs) {
    if (isTransparentWrapper(node)) {
        for (const child of node.children)
            renderNode(child, depth, lines, seenHrefs);
        return;
    }
    const indent = '  '.repeat(depth);
    let line = indent + '- ' + node.role;
    if (node.name !== '')
        line += ' "' + node.name + '"';
    const flags = [];
    if (node.level !== undefined)
        flags.push('level=' + String(node.level));
    if (node.checked === true)
        flags.push('checked');
    if (node.selected === true)
        flags.push('selected');
    if (node.disabled === true)
        flags.push('disabled');
    // The current value of a text entry field: without it the model cannot see
    // what a fill actually left behind, which read as "no visible change".
    if (node.value !== undefined && node.value !== '')
        flags.push('value=' + node.value);
    if (node.ref !== undefined)
        flags.push('ref=' + node.ref);
    if (flags.length > 0)
        line += ' [' + flags.join(', ') + ']';
    if (node.href !== undefined) {
        // Same href, second and later occurrence within ONE snapshot: the URL is
        // already printed at its first occurrence, so repeat only a pointer to it.
        // Every ref and element stays — this trims bytes, never click targets. Only
        // absolute URLs are deduped (a bare "/docs" can name different pages).
        const abs = /^https?:\/\//i.test(node.href);
        const firstRef = abs ? seenHrefs.get(node.href) : undefined;
        if (firstRef !== undefined && firstRef !== node.ref) {
            line += ' -> (same as ' + firstRef + ')';
        }
        else {
            line += ' -> ' + trimUrlForDisplay(node.href);
            if (abs && node.ref !== undefined)
                seenHrefs.set(node.href, node.ref);
        }
    }
    lines.push(line);
    for (const child of node.children)
        renderNode(child, depth + 1, lines, seenHrefs);
}
/**
 * Render a node tree as indented lines, one element per line.
 * @param nodes - the snapshot's root nodes.
 * @returns the rendered tree text.
 */
export function renderSnapshotTree(nodes) {
    const lines = [];
    // href -> ref of its first occurrence in THIS snapshot. Same href second and
    // later renders as "(same as <ref>)" instead of repeating the URL. Scoped to
    // one snapshot on purpose: a fresh snapshot after navigation re-prints URLs.
    const seenHrefs = new Map();
    for (const node of nodes)
        renderNode(node, 0, lines, seenHrefs);
    return lines.join('\n');
}
/**
 * Render a complete snapshot: header facts plus the tree.
 * @param snapshot - the bounded accessibility snapshot.
 * @returns the model-facing snapshot text.
 */
export function renderSnapshot(snapshot) {
    const tree = renderSnapshotTree(snapshot.nodes);
    const header = 'URL: ' +
        snapshot.url +
        '\n' +
        'Title: ' +
        snapshot.title +
        '\n' +
        'Refs: ' +
        String(snapshot.totalRefs) +
        (snapshot.truncated ? ' (truncated)' : '');
    return header + '\n\n' + (tree === '' ? '(no visible elements)' : tree);
}
/** Render one diff entry line: +/-/~ prefix plus role, name, flags, parent chain. */
function renderDiffEntry(prefix, entry) {
    const parts = [];
    if (entry.role !== undefined)
        parts.push(entry.role);
    if (entry.name !== undefined && entry.name !== '')
        parts.push('"' + entry.name + '"');
    if (entry.flags !== undefined && entry.flags.length > 0)
        parts.push('[' + entry.flags.join(', ') + ']');
    if (entry.flagsDelta !== undefined && entry.flagsDelta.length > 0)
        parts.push('[delta: ' + entry.flagsDelta.join(', ') + ']');
    parts.push('ref=' + entry.ref);
    if (entry.parentRef !== undefined)
        parts.push('parent=' + entry.parentRef);
    return prefix + ' ' + parts.join(' ');
}
/**
 * Render an incremental snapshot diff as model-facing lines: `+` for added,
 * `-` for removed, `~` for changed, each line carrying its nearest ancestor
 * ref so the model keeps tree context without a full re-render. A navigation
 * reset renders as a marker line: the delta is void and the full snapshot
 * that follows is authoritative.
 * @param diff - the incremental delta produced by the provider.
 * @returns the rendered diff text.
 */
export function renderSnapshotDiff(diff) {
    const lines = [];
    if (diff.navigationReset) {
        lines.push('(navigation reset: full snapshot follows)');
    }
    else {
        for (const entry of diff.added)
            lines.push(renderDiffEntry('+', entry));
        for (const ref of diff.removed)
            lines.push('- ' + ref);
        for (const entry of diff.changed)
            lines.push(renderDiffEntry('~', entry));
    }
    lines.push('same: ' + String(diff.same));
    return lines.join('\n');
}
