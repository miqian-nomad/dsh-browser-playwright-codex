/**
 * The browser-side snapshot script. Installed with page.addInitScript and
 * invoked as window.__dshSnapshot(opts). The returned value crosses the
 * evaluate boundary as plain JSON.
 */
export const SNAPSHOT_SCRIPT = String.raw `
;(() => {
  if (window.__dshSnapshot) return // one install per document
  // Refs are stable for an element's whole lifetime and unique across the
  // session: the per-document nonce separates documents (navigations), and
  // the per-document sequence never reuses a number. Re-rendered elements
  // are new nodes, so they mint new refs — a stale ref can never silently
  // match a different element.
  const DOC_NONCE = String(Math.floor(Math.random() * 1e9)).padStart(9, '0')
  let refSeq = 0

  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'br', 'hr', 'svg'])
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'combobox', 'listbox', 'option', 'textbox', 'searchbox', 'slider', 'spinbutton', 'row', 'gridcell'])
  const ROLE_BY_TAG = {
    a: 'link', button: 'button', select: 'combobox', textarea: 'textarea', img: 'img',
    nav: 'navigation', main: 'main', footer: 'contentinfo', header: 'banner',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    ul: 'list', ol: 'list', li: 'listitem', option: 'option', table: 'table', tr: 'row', td: 'cell',
    th: 'columnheader', form: 'form', dialog: 'dialog', article: 'article',
    aside: 'complementary', figure: 'figure', iframe: 'iframe', summary: 'summary',
    section: 'region', p: 'paragraph',
  }
  const INPUT_ROLE = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', search: 'searchbox', hidden: null }
  /** input types that label themselves with their value instead of their text. */
  const INPUT_BUTTON_TYPES = new Set(['button', 'submit', 'reset'])
  // Interactive roles whose DESCENDANTS are content, not a label: a <select>'s
  // options or a table row's cells must not be pasted together into the name.
  const CONTENT_ROLES = new Set(['combobox', 'listbox', 'row', 'gridcell'])

  function roleOf(el) {
    const explicit = el.getAttribute('role')
    if (explicit && explicit.trim()) return explicit.trim().toLowerCase()
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') return INPUT_ROLE[(el.getAttribute('type') || 'text').toLowerCase()] || 'textbox'
    return ROLE_BY_TAG[tag] || 'generic'
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false
    if (el.getAttribute('hidden') !== null || el.getAttribute('aria-hidden') === 'true') return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    // A 'display: contents' box has no rect, but its children lay out
    // normally: keep it, or the whole subtree is pruned with it.
    if (style.display === 'contents') return true
    const rect = el.getBoundingClientRect()
    return rect.width > 0 || rect.height > 0
  }

  function isActionable(el, role) {
    if (el.getAttribute('data-dsh-force-ref') !== null) return true
    const tag = el.tagName.toLowerCase()
    if (tag === 'a' || tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'option' || tag === 'summary') return true
    if (tag === 'input' && role !== null) return true
    if (INTERACTIVE_ROLES.has(role)) return true
    if (el.hasAttribute('tabindex') || el.hasAttribute('contenteditable')) return true
    return false
  }

  function clip(text, max) {
    return text.length > max ? text.slice(0, max) + '…' : text
  }

  function ownText(el, maxText) {
    let out = ''
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.textContent
      else if (node.nodeType === 1 && node.tagName.toLowerCase() === 'br') out += ' '
    }
    const flat = out.replace(/\s+/g, ' ').trim()
    return flat.length > maxText ? flat.slice(0, maxText) + '…' : flat
  }

  function nameOf(el, maxName, maxText, actionable) {
    const aria = el.getAttribute('aria-label')
    if (aria && aria.trim()) return clip(aria.trim(), maxName)
    if (el.id) {
      try {
        const labelEl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
        if (labelEl) {
          const t = (labelEl.textContent || '').replace(/\s+/g, ' ').trim()
          if (t) return clip(t, maxName)
        }
      } catch (_) { /* invalid id selector */ }
    }
    const labelEl = el.closest('label')
    if (labelEl) {
      const t = (labelEl.textContent || '').replace(/\s+/g, ' ').trim()
      if (t) return clip(t, maxName)
    }
    const alt = el.getAttribute('alt')
    if (alt && alt.trim()) return clip(alt.trim(), maxName)
    const placeholder = el.getAttribute('placeholder')
    if (placeholder && placeholder.trim()) return clip(placeholder.trim(), maxName)
    const title = el.getAttribute('title')
    if (title && title.trim()) return clip(title.trim(), maxName)
    const tag = el.tagName.toLowerCase()
    // Button-like controls label themselves with their value: <button>提交</button>
    // and <input type="button|submit|reset" value="提交">. Without this an input
    // button renders as a bare ref with no name.
    // An input button labels itself with its value; a <button> is labelled by
    // its text, which the interactive path below collects from the subtree.
    if (tag === 'input' && INPUT_BUTTON_TYPES.has((el.getAttribute('type') || '').toLowerCase())) {
      const value = (el.getAttribute('value') || el.value || '').trim()
      if (value) return clip(value, maxName)
    }
    // Free-text inputs show their LIVE value (el.value, not the stale HTML
    // attribute) so a snapshot after fill reflects what was typed. Password
    // fields are skipped for privacy; fixed-value types (checkbox "on",
    // hidden, range, color) keep their accessible name only.
    if (tag === 'input' || tag === 'textarea') {
      const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : ''
      const freeText = tag === 'textarea'
        || ['text', 'search', 'tel', 'url', 'email', 'number', 'date', 'time', 'datetime-local', 'month', 'week'].includes(type)
      if (freeText) {
        const value = el.value
        if (value && value.trim()) return clip(value.trim(), maxName)
      }
    }
    // Non-interactive content elements carry their own direct text as the name.
    // An interactive element's accessible name is its whole subtree text, which
    // buildNode collects next; returning '' hands it that job.
    if (actionable) return ''
    return clip(ownText(el, maxText), maxName)
  }

  /**
   * Bounded name taken from an element's DESCENDANTS, used only when an
   * actionable element has no text of its own. Shared markup patterns put the
   * visible label one level down — <a><span>搜索设置</span></a>,
   * <button><span>提交</span></button>, <a><img alt="首页"></a> — and without
   * this fallback those nodes render as a bare [ref=...] with no name, so the
   * model cannot tell which ref carries the label it can see. Depth-first,
   * skips script/style/hidden subtrees, prefers text and falls back to
   * aria-label/alt/title, and is capped so a huge card cannot bloat the tree.
   */
  function descendantName(el, maxName, maxText) {
    const texts = []
    const labels = []
    let total = 0
    let visited = 0
    const walk = (node, depth) => {
      if (total >= maxText || depth > 6 || visited > 400) return
      for (const child of node.childNodes) {
        if (total >= maxText || visited > 400) return
        if (child.nodeType === 3) {
          const text = (child.textContent || '').replace(/\s+/g, ' ').trim()
          if (text) {
            texts.push(text)
            total += text.length + 1
          }
        }
        else if (child.nodeType === 1) {
          const tag = child.tagName.toLowerCase()
          if (SKIP_TAGS.has(tag)) continue
          if (child.getAttribute('hidden') !== null || child.getAttribute('aria-hidden') === 'true') continue
          visited += 1
          walk(child, depth + 1)
        }
      }
    }
    const collectLabel = (node, depth) => {
      if (labels.length > 0 || depth > 6) return
      for (const child of node.children) {
        if (labels.length > 0) return
        if (!isVisible(child)) continue
        const aria = child.getAttribute('aria-label')
        const alt = child.getAttribute('alt')
        const title = child.getAttribute('title')
        const label = (aria && aria.trim()) || (alt && alt.trim()) || (title && title.trim())
        if (label) {
          labels.push(label)
          return
        }
        collectLabel(child, depth + 1)
      }
    }
    walk(el, 0)
    if (texts.length > 0) return clip(texts.join(' ').replace(/\s+/g, ' ').trim(), maxName)
    collectLabel(el, 0)
    return labels.length > 0 ? clip(labels[0], maxName) : ''
  }

  function assignRef(el, state) {
    state.refCount += 1
    // Reuse the ref minted for this element by an earlier snapshot of this
    // document, so refs stay stable across snapshots while the DOM is intact.
    const existing = el.getAttribute('data-dsh-ref')
    if (existing !== null) return existing
    const ref = 'e' + DOC_NONCE + String(++refSeq)
    try { el.setAttribute('data-dsh-ref', ref) } catch (_) { /* foreign objects */ }
    return ref
  }

  function buildNode(el, opts, state, inheritedName) {
    const role = roleOf(el) || 'generic'
    const actionable = isActionable(el, role)
    // Nearest ancestor name, used to fold a child that only repeats it.
    const inherited = typeof inheritedName === 'string' ? inheritedName : ''
    if (opts.interactiveOnly && !actionable) {
      const kids = []
      for (const child of el.children) {
        if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue
        if (!isVisible(child)) continue
        const node = buildNode(child, opts, state, inherited)
        if (node) kids.push(node)
      }
      return kids.length ? { role: 'generic', name: '', children: kids } : null
    }
    state.count += 1
    if (state.count > opts.maxNodes) {
      state.truncated = true
      return null
    }
    let nodeName = nameOf(el, opts.maxNameLength, opts.maxTextLength, actionable)
    if (nodeName === '' && actionable && !CONTENT_ROLES.has(role)) nodeName = descendantName(el, opts.maxNameLength, opts.maxTextLength)
    // A button with no text of its own may still label itself with its value.
    if (nodeName === '' && actionable) {
      const controlTag = el.tagName.toLowerCase()
      if (controlTag === 'button' || (controlTag === 'input' && INPUT_BUTTON_TYPES.has((el.getAttribute('type') || '').toLowerCase()))) {
        const fallbackValue = (el.getAttribute('value') || el.value || '').trim()
        if (fallbackValue) nodeName = clip(fallbackValue, opts.maxNameLength)
      }
    }
    // A <select> shows its current value the way a text input does: the chosen
    // option, not every option it happens to contain.
    if (nodeName === '' && role === 'combobox' && el.tagName.toLowerCase() === 'select' && el.selectedIndex >= 0) {
      const chosen = el.options[el.selectedIndex]
      if (chosen) nodeName = clip((chosen.textContent || '').replace(/\s+/g, ' ').trim(), opts.maxNameLength)
    }
    const childInherited = nodeName !== '' ? nodeName : inherited
    const node = { role, name: nodeName }
    if (actionable) node.ref = assignRef(el, state)
    if (role === 'heading') {
      const m = /^h([1-6])$/.exec(el.tagName.toLowerCase())
      if (m) node.level = Number(m[1])
    }
    if (el.tagName.toLowerCase() === 'input' && (role === 'checkbox' || role === 'radio')) node.checked = !!el.checked
    if (role === 'option') node.selected = !!el.selected
    if (el.disabled) node.disabled = true
    if (role === 'link') {
      const href = el.getAttribute('href')
      if (href && href.trim() && href.indexOf('javascript:') !== 0) node.href = href
    }
    if (role === 'iframe') {
      try {
        if (el.contentDocument && el.contentDocument.body && state.depth < 2) {
          state.depth += 1
          const kids = []
          for (const child of el.contentDocument.body.children) {
            if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue
            const sub = buildNode(child, opts, state)
            if (sub) kids.push(sub)
          }
          state.depth -= 1
          node.children = kids
          return node
        }
      } catch (_) { /* cross-origin frame */ }
      node.children = []
      if (!node.name) node.name = '(frame)'
      return node
    }
    const kids = []
    for (const child of el.children) {
      if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue
      // Collapsed native <select> options have zero layout rects but stay
      // part of the element's accessibility tree: include them regardless.
      const isOption = child.tagName.toLowerCase() === 'option' && el.tagName.toLowerCase() === 'select'
      if (!isOption && !isVisible(child)) continue
      const sub = buildNode(child, opts, state, childInherited)
      if (!sub) continue
      // Fold a child that merely repeats the name an ancestor already carries
      // (e.g. <a><span>搜索设置</span></a>): hoist its subtree and drop the
      // duplicate line. A ref-bearing child is a distinct handle and stays.
      if (sub.ref === undefined && sub.name.length >= 2 && childInherited !== '' && childInherited.indexOf(sub.name) !== -1) {
        for (const grand of sub.children || []) kids.push(grand)
        continue
      }
      kids.push(sub)
    }
    node.children = kids
    if (!actionable && !node.name && !kids.length && !node.checked && !node.selected && !node.disabled) return null
    return node
  }

  window.__dshSnapshot = (opts) => {
    const o = {
      interactiveOnly: !!opts.interactiveOnly,
      maxNodes: opts.maxNodes || 500,
      maxNameLength: opts.maxNameLength || 120,
      maxTextLength: opts.maxTextLength || 300,
    }
    const state = { count: 0, truncated: false, depth: 0, refCount: 0 }
    const nodes = []
    if (document.body) {
      for (const child of document.body.children) {
        if (SKIP_TAGS.has(child.tagName.toLowerCase())) continue
        if (!isVisible(child)) continue
        const node = buildNode(child, o, state)
        if (node) nodes.push(node)
      }
    }
    return { nodes, truncated: state.truncated, totalRefs: state.refCount }
  }

  window.__dshPageData = (opts) => {
    const o = { maxTextChars: opts.maxTextChars || 30000, maxLinks: opts.maxLinks || 300, maxInputs: opts.maxInputs || 200 }
    const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim()
    const links = []
    for (const a of document.querySelectorAll('a[href]')) {
      if (links.length >= o.maxLinks) break
      const label = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
      links.push({ text: label, href: a.getAttribute('href') })
    }
    const inputs = []
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (inputs.length >= o.maxInputs) break
      const tag = el.tagName.toLowerCase()
      let label = ''
      if (el.id) {
        try {
          const labelEl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
          if (labelEl) label = (labelEl.textContent || '').replace(/\s+/g, ' ').trim()
        } catch (_) { /* ignore */ }
      }
      if (!label) {
        const labelEl = el.closest('label')
        if (labelEl) label = (labelEl.textContent || '').replace(/\s+/g, ' ').trim()
      }
      let value = el.value || ''
      if (tag === 'select' && el.selectedOptions && el.selectedOptions[0]) value = el.selectedOptions[0].textContent
      inputs.push({ tag, type: el.getAttribute('type') || '', name: el.getAttribute('name') || '', value, label: label.slice(0, 200), checked: tag === 'input' ? !!el.checked : null })
    }
    return {
      url: location.href,
      title: document.title,
      text: text.length > o.maxTextChars ? text.slice(0, o.maxTextChars) + '…' : text,
      truncated: text.length > o.maxTextChars,
      links,
      inputs,
    }
  }
})();
`;
