/**
 * Pure snapshot rendering: model-facing tree text. No I/O, no clock — these
 * functions run on live calls and on session replay alike.
 * @module dsh-browser-playwright-codex/snapshot-render
 */
/** Render one node line into the accumulating line list. */
function renderNode(node, depth, lines) {
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
    if (node.ref !== undefined)
        flags.push('ref=' + node.ref);
    if (flags.length > 0)
        line += ' [' + flags.join(', ') + ']';
    if (node.href !== undefined)
        line += ' -> ' + node.href;
    lines.push(line);
    for (const child of node.children)
        renderNode(child, depth + 1, lines);
}
/**
 * Render a node tree as indented lines, one element per line.
 * @param nodes - the snapshot's root nodes.
 * @returns the rendered tree text.
 */
export function renderSnapshotTree(nodes) {
    const lines = [];
    for (const node of nodes)
        renderNode(node, 0, lines);
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
