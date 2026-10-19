/**
 * dsh-browser-toggle - Client half.
 *
 * Settings → Plugins card for the browser plugin. Manual __ModuleLoader__
 * shim, same shape as the other dsh-* panels: zero build step, inline
 * React.createElement. Talks to the host /api/browser-playwright/* routes via
 * fetch (GET polling, POST with the x-dsh-plugin CSRF header).
 *
 * Two user settings, both effective without a restart:
 *   1. availability — on/off, rendered with the same Switch the other panels use.
 *   2. 页面识别方式  — a choice between two ways of reading a page. Multi-choice
 *      settings use radio rows here (same pattern as dsh-search-switch's
 *      搜索提供方 card), not a switch: it reads as "pick one", not "turn on".
 *
 * 排版跟官方设置页同一套：--dsw-* 设计令牌 + client-ui-primitives 原子件，
 * 不再自带 font-family、不再写死颜色 / 字号（浅色深色自动跟随）。
 */
window.__ModuleLoader__.load({
    id: 'dsh-browser-playwright-codex',
    factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;
        const React = require('react');
        const h = React.createElement;
        const { useEffect, useState, useRef } = React;

    // ---- 官方排版套件：与设置页其它面板同一套令牌 / 原子件 ----
    // 1) 不再覆盖 font-family：继承外壳的 --dsw-font-family
    //    （-apple-system / Segoe UI / PingFang SC / Microsoft YaHei ...）
    // 2) 颜色一律走 --dsw-alias-*，浅色 / 深色主题自动跟随
    // 3) 按钮 / 圆点 / 开关 / 标签直接用官方 @deepseek-ai/dsh-client-ui-primitives
    //    （静态基座模块，third-party client bundle 可直接 require；取不到时退回同令牌样式）
    const UI = (() => {
      try { return require('@deepseek-ai/dsh-client-ui-primitives') || {} } catch (e) { return {} }
    })()

    const T = {
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      border: 'var(--dsw-alias-border-l2)',
      borderL3: 'var(--dsw-alias-border-l3)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', width: '100%' },
      title: { margin: '0 0 6px', fontSize: 16, fontWeight: 500, lineHeight: '24px', color: T.primary },
      intro: { margin: '0 0 16px', fontSize: 13, lineHeight: '20px', color: T.tertiary },
      list: { display: 'flex', flexDirection: 'column', gap: 8 },
      row: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', border: '0.5px solid ' + T.border, borderRadius: 12 },
      rowTitle: { fontSize: 14, fontWeight: 500, lineHeight: '22px', color: T.primary },
      rowDesc: { fontSize: 12, lineHeight: '18px', color: T.secondary },
      meta: { fontSize: 11, lineHeight: '16px', color: T.tertiary, marginTop: 2 },
      group: { margin: '18px 0 8px', fontSize: 13, fontWeight: 600, lineHeight: '20px', color: T.primary },
      groupCount: { fontWeight: 400, color: T.tertiary },
      footer: { marginTop: 16, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      tip: { fontSize: 12, lineHeight: '18px', color: T.tertiary },
      note: { margin: '6px 0 0', fontSize: 11, lineHeight: '16px', color: T.tertiary },
      msg: { marginTop: 10, fontSize: 12, lineHeight: '18px', minHeight: 18, color: T.error },
    }

    function Btn({ danger, ...props }) {
      const style = danger ? { color: T.error } : undefined
      // 设置页自己的动作按钮是 outline + sm（实测「打开配置文件」就是这一套）——
      // ghost 在这页会显得轻一档，跟旁边的官方按钮不是一路。
      if (UI.Button) return h(UI.Button, { variant: 'outline', size: 'sm', ...props, style })
      return h('button', {
        type: 'button', ...props,
        style: {
          height: 28, padding: '0 10px', border: '0.5px solid ' + T.borderL3, borderRadius: 14,
          background: 'transparent', font: 'inherit', fontSize: 12, lineHeight: '18px',
          color: danger ? T.error : T.primary, cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.4 : 1,
        },
      })
    }

    function Dot({ state }) {
      if (UI.StateDot) return h(UI.StateDot, { state })
      const color = { done: T.success, warning: T.warn, error: T.error }[state] || T.tertiary
      return h('span', { style: { width: 8, height: 8, borderRadius: '50%', flex: 'none', background: color } })
    }

    function Toggle({ checked, onChange, label, disabled }) {
      if (UI.Switch) return h(UI.Switch, { checked, onChange, label, disabled })
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, disabled,
        onClick: () => onChange(!checked),
        style: { width: 36, height: 20, flex: 'none', padding: 2, border: 'none', borderRadius: 10, background: checked ? T.primary : T.borderL3, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 },
      }, h('span', { style: { display: 'block', width: 16, height: 16, borderRadius: '50%', background: 'var(--dsw-alias-label-primary-foreground)', transform: checked ? 'translateX(16px)' : 'none', transition: 'transform 120ms ease' } }))
    }

    /** 官方 Tag：像「已启用 / 已禁用」这类状态小标记（以前是行内一段灰字）。 */
    function Tag(props) {
      if (UI.Tag) return h(UI.Tag, { tone: props.tone || 'outline' }, props.children)
      return h('span', { style: { fontSize: 11, lineHeight: '16px', color: T.tertiary, marginRight: 6 } }, props.children)
    }

    /** 官方 DisclosureRow：长说明默认折叠（首屏只留结论）。 */
    function Notes(props) {
      const [open, setOpen] = useState(false)
      if (UI.DisclosureRow) {
        return h(UI.DisclosureRow, {
          title: props.title,
          open: open,
          expandable: true,
          expandOnRowClick: true,
          onToggle: () => setOpen(!open),
        }, open ? props.children : null)
      }
      return h('div', null, props.children)
    }

    // 单选行：与 dsh-search-switch 的 RadioRow 同一套（role=radio / 选中描边加粗 /
    // 圆点标记 / 键盘可操作），所以两张卡片放在一起看不出是两个人写的。
    function RadioRow({ p, selected, disabled, onPick }) {
      return h('div', {
        role: 'radio',
        'aria-checked': selected,
        'aria-label': p.label,
        tabIndex: disabled ? -1 : 0,
        onClick: () => { if (!disabled) onPick(p.id) },
        onKeyDown: (e) => {
          if (disabled) return
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(p.id) }
        },
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px',
          border: (selected ? '1px' : '0.5px') + ' solid ' + (selected ? T.primary : T.border),
          borderRadius: 12,
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled && !selected ? 0.6 : 1,
        },
      }, [
        h('span', {
          key: 'mark',
          style: {
            width: 16, height: 16, flex: 'none', marginTop: 2, borderRadius: '50%',
            border: '1.5px solid ' + (selected ? T.primary : T.borderL3),
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          },
        }, selected ? h('span', { style: { width: 8, height: 8, borderRadius: '50%', background: T.primary } }) : null),
        h('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
          h('div', { key: 'label', style: S.rowTitle }, p.label),
          p.hint ? h('div', { key: 'hint', style: S.rowDesc }, p.hint) : null,
        ]),
        selected ? h(Dot, { key: 'dot', state: 'done' }) : null,
      ])
    }

        const API = '/api/browser-playwright';
        const HEADER = 'browser-toggle';

        // 两种"看网页"的方式。写成用户能懂的话，不出现 legacy / aria / 引擎 这些词。
        const ENGINE_OPTIONS = [
            {
                id: 'legacy',
                label: '兼容模式',
                hint: '插件自己去找页面上的按钮和输入框。用得最久、测得最多，遇到奇怪的网站最不容易出问题。',
            },
            {
                id: 'aria',
                label: '智能模式',
                hint: '改用浏览器官方的"页面说明书"（和读屏软件看的是同一份）。菜单、弹窗、动态加载多的网站通常更准；万一读不出来，它会自动退回兼容模式。',
            },
        ]

        // 两个"强力工具"：默认关闭，用户想要才打开。写的都是人话，不出现 evaluate/cdp。
        const GATE_ROWS = [
            {
                key: 'allowEvaluate',
                label: '允许在页面里执行任意 JavaScript',
                hint: '打开后 AI 能在任意网页里运行脚本：能读走页面上的任何内容，也能用你的登录状态去点、去填、去提交。真正需要时才打开。',
            },
            {
                key: 'diagnostics',
                label: '诊断工具：控制台消息与网络请求',
                hint: '给排障用：能读出页面控制台的报错和最近的网络请求（URL、状态、失败原因）。平时用不到；遇到"点了没反应"或"背后的请求失败了"再打开。',
            },
            {
                key: 'allowCdp',
                label: '允许原始 CDP 调试协议',
                hint: '给排查疑难页面用：只放行"查看类"和"模拟输入类"命令，读取 Cookie/存储、改网络、动安全设置这类命令一律被拦住。',
            },
        ]

        async function api(path, method, body) {
            // The header goes on reads too: the host now requires it for GET as well, so a GET
            // without it is a 403 (2026-10-16 the CSRF check moved from POST-only to every route).
            const opts = { method, headers: { 'x-dsh-plugin': HEADER } };
            if (method === 'POST') {
                opts.headers['Content-Type'] = 'application/json';
                if (body !== undefined)
                    opts.body = JSON.stringify(body);
            }
            else {
                opts.headers['Cache-Control'] = 'no-store';
            }
            const res = await fetch(API + path, opts);
            return res.json();
        }

        // Which domains the user chose not to see. A view preference only: it lives in this
        // browser's localStorage, never in the deployment's files and never on the host.
        const HIDDEN_KEY = 'dsh-browser-toggle.hidden-logins';
        function readHiddenDomains() {
            try {
                const raw = window.localStorage.getItem(HIDDEN_KEY);
                const parsed = raw === null ? [] : JSON.parse(raw);
                return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
            }
            catch {
                return [];
            }
        }
        function writeHiddenDomains(list) {
            try {
                window.localStorage.setItem(HIDDEN_KEY, JSON.stringify(list));
            }
            catch {
                // private mode / quota: hiding a row is cosmetic, losing the preference is fine
            }
        }
        function BrowserPanel() {
            const [enabled, setEnabled] = useState(null);
            const [engine, setEngine] = useState(null);
            const [engineUserChosen, setEngineUserChosen] = useState(false);
            const [gates, setGates] = useState({ allowEvaluate: null, allowCdp: null, diagnostics: null });
            const [busy, setBusy] = useState(false);
            const [msg, setMsg] = useState('');
            const [logins, setLogins] = useState(null);
            const [showAll, setShowAll] = useState(false);
            const [openGroups, setOpenGroups] = useState([]);
            const [hiddenDomains, setHiddenDomains] = useState(readHiddenDomains());
            const [loginsOpen, setLoginsOpen] = useState(false);
            const mountedRef = useRef(true);

            const refresh = async () => {
                try {
                    const s = await api('/state', 'GET');
                    if (!mountedRef.current) return;
                    if (typeof s.enabled === 'boolean')
                        setEnabled(s.enabled);
                    if (typeof s.engine === 'string')
                        setEngine(s.engine);
                    setEngineUserChosen(s.engineUserChosen === true);
                    setGates({
                        allowEvaluate: typeof s.allowEvaluate === 'boolean' ? s.allowEvaluate : null,
                        allowCdp: typeof s.allowCdp === 'boolean' ? s.allowCdp : null,
                        diagnostics: typeof s.diagnostics === 'boolean' ? s.diagnostics : null,
                    });
                }
                catch (error) {
                    if (mountedRef.current)
                        setMsg('状态获取失败：' + (error?.message ?? String(error)));
                }
            };

            const refreshLogins = async () => {
                try {
                    const r = await api('/logins', 'GET');
                    if (mountedRef.current)
                        setLogins(r && typeof r === 'object' ? (r.logins ?? null) : null);
                }
                catch {
                    if (mountedRef.current)
                        setLogins(null);
                }
            };

            useEffect(() => {
                mountedRef.current = true;
                refresh();
                refreshLogins();
                const timer = setInterval(refresh, 5000);
                // Cookies change far more slowly than switches; polling this less often keeps the
                // settings page from doing pointless work.
                const loginsTimer = setInterval(refreshLogins, 15000);
                return () => {
                    mountedRef.current = false;
                    clearInterval(timer);
                    clearInterval(loginsTimer);
                };
            }, []);

            const applyEnabled = async (next) => {
                if (enabled === null || busy || next === enabled)
                    return;
                setBusy(true);
                setMsg('');
                try {
                    const r = await api('/toggle', 'POST', { enabled: next });
                    if (typeof r.enabled === 'boolean')
                        setEnabled(r.enabled);
                    setMsg(r.changed
                        ? (next ? '已启用：AI 可以替你操作网页。' : '已禁用：AI 不再操作网页，已打开的窗口会自动关闭（登录状态保留）。')
                        : '状态未变化');
                }
                catch (error) {
                    setMsg('切换失败：' + (error?.message ?? String(error)));
                }
                finally {
                    setBusy(false);
                }
            };

            const chooseEngine = async (next) => {
                if (engine === null || busy || next === engine)
                    return;
                setBusy(true);
                setMsg('');
                try {
                    const r = await api('/engine', 'POST', { engine: next });
                    if (typeof r.engine === 'string')
                        setEngine(r.engine);
                    const picked = ENGINE_OPTIONS.find((o) => o.id === r.engine) || {};
                    setEngineUserChosen(true);
                    setMsg(r.changed
                        ? '已切到「' + (picked.label || r.engine) + '」，下一步操作就生效，不用重启。'
                        : '状态未变化');
                }
                catch (error) {
                    setMsg('切换失败：' + (error?.message ?? String(error)));
                }
                finally {
                    setBusy(false);
                }
            };

            const applyGates = async (key, next) => {
                if (gates[key] === null || busy || next === gates[key])
                    return;
                setBusy(true);
                setMsg('');
                // Send both: the host writes one managed block for the pair.
                const payload = {
                    allowEvaluate: gates.allowEvaluate === true,
                    allowCdp: gates.allowCdp === true,
                    diagnostics: gates.diagnostics === true,
                };
                payload[key] = next;
                try {
                    const r = await api('/gates', 'POST', payload);
                    if (r && r.error)
                        throw new Error(r.error.message || r.error.code || 'unknown');
                    setGates({
                        allowEvaluate: r.allowEvaluate === true,
                        allowCdp: r.allowCdp === true,
                        diagnostics: r.diagnostics === true,
                    });
                    setMsg(r.changed
                        ? (next
                            ? '已打开：' + ((GATE_ROWS.find((row) => row.key === key) || {}).label || key) + '。工具会在热重载后出现（约 1-2 秒）；若一直没出现，重启一次 DSH。'
                            : '已关闭。工具会在热重载后消失；若还在，重启一次 DSH。')
                        : '状态未变化');
                }
                catch (error) {
                    setMsg('切换失败：' + (error?.message ?? String(error)));
                }
                finally {
                    setBusy(false);
                }
            };

            const state = enabled === null ? 'ongoing' : (enabled ? 'done' : 'idle');
            const gateState = (key) => (gates[key] === null ? 'ongoing' : (gates[key] ? 'done' : 'idle'));
            const gatesOn = GATE_ROWS.filter((row) => gates[row.key] === true).length;
            const statusLabel = enabled === null ? '读取中…' : (enabled ? '已启用' : '已禁用');
            const current = ENGINE_OPTIONS.find((o) => o.id === engine) || null;

            return h('div', { style: S.page }, [
                h('h2', { key: 'title', style: S.title }, '浏览器'),
                h('p', { key: 'intro', style: S.intro },
                    '让 AI 用你的登录状态替你上网办事（查后台、填表、抓列表）。这里的改动立刻生效，不需要重启。'),
                h('div', { key: 'row', style: S.row }, [
                    h(Dot, { key: 'dot', state }),
                    h('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
                        h('div', { key: 'label', style: S.rowTitle }, '允许 AI 操作网页'),
                        h('div', { key: 'desc', style: S.rowDesc }, [
                            h(Tag, { key: 'status' }, statusLabel),
                            '　关闭后已打开的窗口会自动关闭，登录状态会保留。',
                        ]),
                    ]),
                    h(Toggle, {
                        key: 'toggle',
                        checked: enabled === true,
                        onChange: applyEnabled,
                        disabled: enabled === null || busy,
                        label: '允许 AI 操作网页',
                    }),
                ]),
                h('div', { key: 'group', style: S.group }, '页面识别方式'),
                h(Notes, { key: 'groupNotes', title: '说明' },
                    h('p', { style: S.note },
                        '决定它怎么"看"一个网页：页面上有哪些能点的、能填的。两种都能正常用，选哪个看你常去的网站。')),
                h('div', { key: 'engines', style: { ...S.list, marginTop: 8 } }, ENGINE_OPTIONS.map((o) =>
                    h(RadioRow, {
                        key: o.id,
                        p: o,
                        selected: engine === o.id,
                        disabled: engine === null || busy,
                        onPick: chooseEngine,
                    }))),
                h('div', { key: 'footer', style: S.footer }, [
                    h(Btn, { key: 'refresh', onClick: refresh, disabled: busy }, '刷新状态'),
                    current
                        ? h('span', { key: 'cur', style: S.tip },
                            '当前：' + current.label + (engineUserChosen ? '（你选的）' : '（默认）'))
                        : null,
                ]),
                h('div', { key: 'gatesGroup', style: S.group }, '强力工具（默认关闭）'),
                h(Notes, { key: 'gatesNotes', title: '说明' },
                    h('p', { style: S.note },
                        '这两个开关控制的是"能力"，不是效果微调：打开"任意 JavaScript"就等于把页面里的东西都交给 AI。'
                        + '插件包里默认关闭 —— 因为包是发给每个安装者的，默认打开等于替所有人做了这个决定；'
                        + '这里打开的是你自己机器上的选择，记在你自己机器的配置层里。')),
                h('div', { key: 'gates', style: { ...S.list, marginTop: 8 } }, GATE_ROWS.map((row) =>
                    h('div', { key: row.key, style: S.row }, [
                        h(Dot, { key: 'dot', state: gateState(row.key) }),
                        h('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
                            h('div', { key: 'label', style: S.rowTitle }, row.label),
                            h('div', { key: 'desc', style: S.rowDesc }, row.hint),
                        ]),
                        h(Toggle, {
                            key: 'toggle',
                            checked: gates[row.key] === true,
                            onChange: (next) => applyGates(row.key, next),
                            disabled: gates[row.key] === null || busy,
                            label: row.label,
                        }),
                    ]))),
                h('div', { key: 'gatesFooter', style: S.footer },
                    gates.allowEvaluate === null && gates.allowCdp === null
                        ? h('span', { key: 'unknown', style: S.tip }, '当前：读取不到（这个 profile 里的插件版本还没上报闸门状态）')
                        : h('span', { key: 'sum', style: S.tip }, '当前：' + (gatesOn === 0 ? '都关着' : gatesOn + ' 个开着'))),
                h('div', {
                    key: 'loginsGroup',
                    style: { ...S.group, cursor: 'pointer', userSelect: 'none' },
                    onClick: () => setLoginsOpen((open) => !open),
                }, '已登录的站点（只给你自己看）'
                    + (logins === null || logins.sites === undefined
                        ? ''
                        : '　· ' + logins.sites.length + ' 个域 · ' + logins.sites.reduce((acc, site) => acc + site.cookies, 0) + ' 个 cookie')
                    + (loginsOpen ? '　▾ 点击收起' : '　▸ 点击展开')),
                loginsOpen ? h(Notes, { key: 'loginsNotes', title: '说明' },
                    h('p', { style: S.note },
                        '只列**这台浏览器真的访问过**的域（你在 DSH 里打开过的页面），第三方统计/广告域已排除 ——'
                        + '别人的 cookie 属于你当时浏览的那个站，不代表你登录了它。判据是 OWASP 的会话特征：'
                        + 'httpOnly 且（会话级 或 值像令牌），名字不作为依据。'
                        + '每一行的说明来自网页自己的标题，或一份离线对照表（认不出的就直接显示域名，不编）。'
                        + '这里不显示 cookie 的名字和值；名单只存在于本机内存、不写磁盘；也没有任何工具能让 AI 看到它。')) : null,
                loginsOpen === false
                    ? null
                    : logins === null
                    ? h('div', { key: 'loginsUnknown', style: S.tip },
                        '读取不到：这个 profile 里的插件版本还没上报，或还没打开过浏览器。')
                    : (() => {
                        const pool = showAll ? logins.sites : logins.sites.filter((s) => s.likely);
                        const visible = pool.filter((s) => hiddenDomains.indexOf(s.domain) < 0);
                        const hiddenCount = pool.length - visible.length;
                        // 同一家公司的域折叠成一行：真实名单里京东系二十来个域各自占一行，小半屏都是它。
                        const byGroup = new Map();
                        const items = [];
                        for (const site of visible) {
                            const key = site.group ? site.group.key : null;
                            if (key === null) {
                                items.push({ kind: 'single', site });
                                continue;
                            }
                            let group = byGroup.get(key);
                            if (group === undefined) {
                                group = { kind: 'group', key, label: site.group.label, sites: [] };
                                byGroup.set(key, group);
                                items.push(group);
                            }
                            group.sites.push(site);
                        }
                        // 组里只剩一个域就没有折叠的意义，退回单行。
                        for (let i = items.length - 1; i >= 0; i -= 1) {
                            if (items[i].kind === 'group' && items[i].sites.length === 1)
                                items[i] = { kind: 'single', site: items[i].sites[0] };
                        }
                        const sum = (list, pick) => list.reduce((acc, s) => acc + pick(s), 0);
                        const rowFor = (site, indented) => h('div', {
                            key: site.domain,
                            style: indented ? { ...S.row, paddingLeft: 18 } : S.row,
                        }, [
                            h('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
                                h('div', { key: 'label', style: S.rowTitle }, [
                                    site.likely ? h(Tag, { key: 'tag' }, '推测登录') : null,
                                    // 说明优先：光看域名认不出来是这个功能最初的痛点。
                                    site.alias || site.title || site.domain,
                                ]),
                                h('div', { key: 'desc', style: S.rowDesc },
                                    (site.alias ? site.domain + '　' : '')
                                    + (site.title && site.title !== site.alias ? '「' + site.title + '」　' : '')
                                    + site.cookies + ' 个 cookie（httpOnly ' + site.httpOnly
                                    + ' / 会话 ' + site.sessionLike
                                    + ' / 值像令牌 ' + site.tokenLike + '）'
                                    + (site.signals.length > 0 ? '　' + site.signals.join(' · ') : '')),
                            ]),
                            h(Btn, {
                                key: 'hide',
                                onClick: () => {
                                    const next = hiddenDomains.concat([site.domain]);
                                    setHiddenDomains(next);
                                    writeHiddenDomains(next);
                                },
                            }, '隐藏'),
                        ]);
                        const renderItem = (item) => {
                            if (item.kind === 'single') return rowFor(item.site, false);
                            const open = openGroups.indexOf(item.key) >= 0;
                            const anyLikely = item.sites.some((s) => s.likely);
                            return h('div', { key: 'group-' + item.key }, [
                                h('div', { key: 'head', style: S.row }, [
                                    h('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
                                        h('div', { key: 'label', style: S.rowTitle }, [
                                            anyLikely ? h(Tag, { key: 'tag' }, '推测登录') : null,
                                            item.label + '（' + item.sites.length + ' 个域）',
                                        ]),
                                        h('div', { key: 'desc', style: S.rowDesc },
                                            sum(item.sites, (s) => s.cookies) + ' 个 cookie　httpOnly '
                                            + sum(item.sites, (s) => s.httpOnly) + '　会话 '
                                            + sum(item.sites, (s) => s.sessionLike) + '　值像令牌 '
                                            + sum(item.sites, (s) => s.tokenLike)),
                                    ]),
                                    h(Btn, {
                                        key: 'toggle',
                                        onClick: () => {
                                            setOpenGroups(open
                                                ? openGroups.filter((k) => k !== item.key)
                                                : openGroups.concat([item.key]));
                                        },
                                    }, open ? '收起' : '展开'),
                                ]),
                                open
                                    ? h('div', { key: 'members' }, item.sites.map((s) => rowFor(s, true)))
                                    : null,
                            ]);
                        };
                        return h('div', { key: 'loginsBody' }, [
                            h('div', { key: 'list', style: { ...S.list, marginTop: 8 } },
                                visible.length === 0
                                    ? h('div', { key: 'none', style: S.tip },
                                        hiddenCount > 0
                                            ? '这一页都被你隐藏了。'
                                            : '还没发现登录过的站点（用这个浏览器登录过网站后，这里会出现）。')
                                    : items.map(renderItem)),
                            h('div', { key: 'loginsFooter', style: S.footer }, [
                                h('span', { key: 'src', style: S.tip },
                                    (logins.source === 'live' ? '实时（浏览器开着）' : '上次快照（浏览器当前没开）')
                                    + '　' + new Date(logins.capturedAt).toLocaleTimeString()
                                    + '　你在 DSH 里访问过 ' + logins.total + ' 个域，其中 '
                                    + logins.likelyTotal + ' 个像登录态'
                                    + (logins.thirdPartyTotal > 0
                                        ? '；另有 ' + logins.thirdPartyTotal + ' 个第三方域（统计/广告）已排除'
                                        : '')
                                    + (logins.attribution === 'unfiltered'
                                        ? '（这次没拿到浏览器打开的页面列表，未做第一方过滤：下面可能有第三方域）'
                                        : '')),
                                h(Btn, {
                                    key: 'all',
                                    onClick: () => setShowAll(!showAll),
                                }, showAll
                                    ? '只看像登录态的 ' + logins.likelyTotal + ' 个'
                                    : '显示其余 ' + (logins.total - logins.likelyTotal) + ' 个'),

                                hiddenCount > 0
                                    ? h(Btn, {
                                        key: 'reset',
                                        onClick: () => {
                                            setHiddenDomains([]);
                                            writeHiddenDomains([]);
                                        },
                                    }, '恢复显示 ' + hiddenCount + ' 个被隐藏的')
                                    : null,
                            ]),
                        ]);
                    })(),
                msg ? h('div', { key: 'msg', style: S.msg }, msg) : null,
            ]);
        }

        function apply(ctx) {
            ctx.effect(() =>
                ctx.slots.inject('settings.section', () =>
                    ctx.slots.register(
                        { name: 'settings.section', id: 'browser-toggle', order: 106, label: () => '浏览器' },
                        BrowserPanel,
                    ),
                ),
            );
        }

        exports.apply = apply;
        exports.inject = ['slots'];
        return module.exports;
    },
});
