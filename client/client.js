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
            const [headless, setHeadless] = useState(null);
            const [headlessUserChosen, setHeadlessUserChosen] = useState(false);
            const [showAll, setShowAll] = useState(false);
            const [openGroups, setOpenGroups] = useState([]);
            const [hiddenDomains, setHiddenDomains] = useState(readHiddenDomains());
            const [loginsOpen, setLoginsOpen] = useState(false);
            const [disk, setDisk] = useState(null);
            const [diskPicked, setDiskPicked] = useState({ 'browser-cache': true, 'temp-residue': true, 'updater-residue': true, 'attachment-cache': false });
            const [diskPreview, setDiskPreview] = useState(null);
            const [diskResult, setDiskResult] = useState(null);
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
                    if (typeof s.headless === 'boolean') setHeadless(s.headless);
                    setHeadlessUserChosen(s.headlessUserChosen === true);
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
                refreshDisk();
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

            const chooseWindow = async (nextHeadless) => {
                if (headless === null || busy || nextHeadless === headless) return;
                setBusy(true);
                setMsg('');
                try {
                    const r = await api('/window', 'POST', { headless: nextHeadless });
                    if (r && r.error) throw new Error(r.error.message || r.error.code || 'unknown');
                    if (typeof r.headless === 'boolean') setHeadless(r.headless);
                    setHeadlessUserChosen(true);
                    setMsg(r.changed
                        ? (nextHeadless
                            ? '已切到后台运行（无头）。下次操作时重开浏览器；标签页会关闭，登录状态保留。'
                            : '已切到显示窗口。下次操作时重开浏览器；标签页会关闭，登录状态保留。')
                        : '状态未变化');
                } catch (error) {
                    setMsg('切换失败：' + (error?.message ?? String(error)));
                } finally {
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

            const fmt = (bytes) => {
                if (typeof bytes !== 'number') return '—';
                if (bytes < 1024) return bytes + ' B';
                const units = ['KB', 'MB', 'GB'];
                let value = bytes / 1024;
                let unit = 0;
                while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
                return value.toFixed(value >= 100 ? 0 : 1) + ' ' + units[unit];
            };

            const refreshDisk = async () => {
                try {
                    const d = await api('/disk/stat', 'GET');
                    if (mountedRef.current && d && !d.error) setDisk(d);
                } catch (error) {
                    if (mountedRef.current) setMsg('磁盘统计失败：' + (error?.message ?? String(error)));
                }
            };

            const runDisk = async (dryRun) => {
                if (busy) return;
                const targets = Object.keys(diskPicked).filter((id) => diskPicked[id]);
                if (targets.length === 0) { setMsg('先勾选要清理的项目'); return; }
                setBusy(true);
                setMsg('');
                try {
                    const r = await api('/disk/clean', 'POST', { targets, dryRun });
                    if (r && r.error) throw new Error(r.error.message || r.error.code || 'unknown');
                    if (dryRun) {
                        setDiskPreview(r);
                        setDiskResult(null);
                    } else {
                        setDiskPreview(null);
                        setDiskResult(r);
                        setMsg('已释放 ' + fmt(r.freedBytes) + '（跳过 ' + (r.perTarget || []).reduce((n, t) => n + ((t.skipped && t.skipped.length) || 0), 0) + ' 项）');
                        refreshDisk();
                    }
                } catch (error) {
                    setMsg('清理失败：' + (error?.message ?? String(error)));
                } finally {
                    setBusy(false);
                }
            };

            const skipSummary = (report) => {
                if (!report || !Array.isArray(report.perTarget)) return '';
                const reasons = {};
                for (const t of report.perTarget) for (const s of (t.skipped || [])) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
                const parts = Object.keys(reasons).map((k) => k + ' ' + reasons[k]);
                return parts.length > 0 ? '　跳过：' + parts.join('、') : '';
            };

            const state = enabled === null ? 'ongoing' : (enabled ? 'done' : 'idle');
            const gateState = (key) => (gates[key] === null ? 'ongoing' : (gates[key] ? 'done' : 'idle'));
            const gatesOn = GATE_ROWS.filter((row) => gates[row.key] === true).length;
            const statusLabel = enabled === null ? '读取中…' : (enabled ? '已启用' : '已禁用');
            const current = ENGINE_OPTIONS.find((o) => o.id === engine) || null;

            const GATE_SHORT = {
                allowEvaluate: '页面里的任意 JavaScript',
                allowCdp: '原始 CDP 调试协议',
                diagnostics: '控制台消息 / 网络请求',
            };
            const ENGINE_SHORT = { legacy: '最稳，奇怪网站也不容易出错', aria: '更准，复杂页面优先' };

            return h('div', { style: S.page }, [
                h('h2', { key: 'title', style: S.title }, '浏览器'),
                h('p', { key: 'intro', style: S.intro },
                    '让 AI 用你的登录状态替你上网办事。这里的改动立刻生效，不需要重启。'),

                // ---- 主开关 ----
                h('div', { key: 'row', style: S.row }, [
                    h(Dot, { key: 'dot', state }),
                    h('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
                        h('div', { key: 'label', style: S.rowTitle }, '允许 AI 操作网页'),
                        h('div', { key: 'desc', style: S.rowDesc },
                            h(Tag, { key: 'status' }, statusLabel),
                            '关闭后窗口会关掉，登录状态保留。'),
                    ]),
                    h(Toggle, {
                        key: 'toggle',
                        checked: enabled === true,
                        onChange: applyEnabled,
                        disabled: enabled === null || busy,
                        label: '允许 AI 操作网页',
                    }),
                ]),

                // ---- 页面读取方式 ----
                h('div', { key: 'engineGroup', style: S.group }, [
                    '页面读取方式',
                    h('span', { key: 'cur', style: S.groupCount },
                        current ? '　当前：' + current.label : '　读取中…'),
                ]),
                h('div', { key: 'engines', style: { ...S.list, marginTop: 8 } },
                    ENGINE_OPTIONS.map((o) => h(RadioRow, {
                        key: o.id,
                        p: { id: o.id, label: o.label, hint: ENGINE_SHORT[o.id] || '' },
                        selected: engine === o.id,
                        disabled: engine === null || busy,
                        onPick: chooseEngine,
                    }))),
                h(Notes, {
                    key: 'engineNotes',
                    title: '两种模式到底差在哪',
                    children: h('div', null, ENGINE_OPTIONS.map((o) => h('p', { key: o.id, style: S.note },
                        o.label + '：' + o.hint))),
                }),

                // ---- 浏览器窗口（有头 / 无头） ----
                h('div', { key: 'windowGroup', style: S.group }, [
                    '浏览器窗口',
                    h('span', { key: 'cur', style: S.groupCount },
                        headless === null ? '　读取中…' : (headless ? '　当前：后台运行（无头）' : '　当前：显示窗口（有头）')
                        + (headlessUserChosen ? '（你选的）' : '')),
                ]),
                h('div', { key: 'windows', style: { ...S.list, marginTop: 8 } }, [
                    h(RadioRow, {
                        key: 'headful',
                        p: { id: 'headful', label: '显示浏览器窗口', hint: '能看见、能随时接手；登录和验证码可以自己处理' },
                        selected: headless === false,
                        disabled: headless === null || busy,
                        onPick: () => chooseWindow(false),
                    }),
                    h(RadioRow, {
                        key: 'headless',
                        p: { id: 'headless', label: '后台运行（无头）', hint: '更快、不弹窗；但你看不见它，登录/验证码只能远程处理' },
                        selected: headless === true,
                        disabled: headless === null || busy,
                        onPick: () => chooseWindow(true),
                    }),
                ]),
                h(Notes, {
                    key: 'windowNotes',
                    title: '切换窗口模式会发生什么',
                    children: h('div', null, [
                        h('p', { key: 'reopen', style: S.note },
                            '有头/无头是启动参数，不能原地切换：下次操作时会关掉旧窗口、按新模式重开。标签页和未提交的表单会丢，登录状态会先导出、不会丢。'),
                        h('p', { key: 'risk', style: S.note },
                            '无头模式下插件"看得见、能接管"的前提不成立——验证码/二次验证只有提示，没人能在窗口里替你点。只在无人值守、且你接受这个代价时用。'),
                    ]),
                }),

                // ---- 工具权限 ----
                h('div', { key: 'gateGroup', style: S.group }, [
                    '工具权限',
                    h('span', { key: 'sum', style: S.groupCount },
                        gatesOn === 0 ? '　全部关闭' : '　' + gatesOn + ' / ' + GATE_ROWS.length + ' 已开启'),
                ]),
                h('div', { key: 'gates', style: { ...S.list, marginTop: 8 } },
                    GATE_ROWS.map((row) => h('div', { key: row.key, style: S.row }, [
                        h(Dot, { key: 'dot', state: gateState(row.key) }),
                        h('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
                            h('div', { key: 'label', style: S.rowTitle }, row.label),
                            h('div', { key: 'desc', style: S.rowDesc }, GATE_SHORT[row.key] || row.hint),
                        ]),
                        h(Toggle, {
                            key: 'toggle',
                            checked: gates[row.key] === true,
                            onChange: (next) => applyGates(row.key, next),
                            disabled: gates[row.key] === null || busy,
                            label: row.label,
                        }),
                    ]))),
                h(Notes, {
                    key: 'gateNotes',
                    title: '这些开关具体放行什么',
                    children: h('div', null, [
                        h('p', { key: 'evaluate', style: S.note },
                            '页面里执行任意 JavaScript：能读走页面内容，也能用你的登录状态去点、去填、去提交。真正需要时才打开。'),
                        h('p', { key: 'cdp', style: S.note },
                            '原始 CDP 协议：只放行查看类和模拟输入类命令；读 Cookie/存储、改网络、动安全设置一律被拦。排查疑难页面用。'),
                        h('p', { key: 'diagnostics', style: S.note },
                            '控制台消息 + 网络请求：能读出页面报错和最近的请求（URL、状态、失败原因）。平时用不到，遇到"点了没反应"再打开。'),
                        h('p', { key: 'effect', style: S.note },
                            '工具在热重载后出现或消失（约 1-2 秒）；若一直没变，重启一次 DSH。'),
                    ]),
                }),

                h('div', { key: 'diskGroup', style: S.group }, [
                    '缓存与磁盘',
                    h('span', { key: 'sum', style: S.groupCount },
                        disk === null ? '　统计中…' : '　可清理 ' + fmt(disk.totalBytes)),
                ]),
                h('div', { key: 'diskList', style: { ...S.list, marginTop: 8 } },
                    (disk === null ? [] : disk.items).map((item) => h('div', { key: item.id, style: S.row }, [
                        h('div', {
                            key: 'check',
                            role: 'checkbox',
                            'aria-checked': diskPicked[item.id] === true,
                            'aria-label': item.label,
                            tabIndex: 0,
                            onClick: () => setDiskPicked({ ...diskPicked, [item.id]: !diskPicked[item.id] }),
                            onKeyDown: (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setDiskPicked({ ...diskPicked, [item.id]: !diskPicked[item.id] });
                                }
                            },
                            style: {
                                width: 16, height: 16, flex: 'none', borderRadius: 4, cursor: 'pointer',
                                border: '1.5px solid ' + (diskPicked[item.id] ? T.primary : T.borderL3),
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                            },
                        }, diskPicked[item.id] ? h('span', { style: { width: 8, height: 8, borderRadius: 2, background: T.primary } }) : null),
                        h('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
                            h('div', { key: 'label', style: S.rowTitle }, item.label),
                            h('div', { key: 'desc', style: S.rowDesc },
                                fmt(item.bytes) + '　' + item.files + ' 个文件'
                                + (item.note ? '　' + item.note : '')),
                        ]),
                    ]))),
                h('div', { key: 'diskActions', style: S.footer }, [
                    h(Btn, { key: 'rescan', onClick: refreshDisk, disabled: busy }, '重新统计'),
                    h(Btn, { key: 'preview', onClick: () => runDisk(true), disabled: busy || disk === null }, '先预演'),
                    diskPreview
                        ? h(Btn, { key: 'clean', onClick: () => runDisk(false), disabled: busy }, '确认清理 ' + fmt(diskPreview.freedBytes))
                        : null,
                ]),
                diskPreview
                    ? h('div', { key: 'diskPreview', style: S.tip },
                        '预演：将释放 ' + fmt(diskPreview.freedBytes) + skipSummary(diskPreview) + '（点了确认才会真删）')
                    : null,
                diskResult
                    ? h('div', { key: 'diskResult', style: S.tip },
                        '已释放 ' + fmt(diskResult.freedBytes) + skipSummary(diskResult))
                    : null,

                // ---- 已登录站点（默认收起） ----
                h('div', {
                    key: 'loginsGroup',
                    style: { ...S.group, cursor: 'pointer', userSelect: 'none' },
                    onClick: () => setLoginsOpen((open) => !open),
                }, [
                    '已登录的站点',
                    h('span', { key: 'count', style: S.groupCount },
                        logins === null || logins.sites === undefined
                            ? '　读取中…'
                            : '　' + logins.sites.length + ' 个域 · '
                              + logins.sites.reduce((acc, site) => acc + site.cookies, 0) + ' 个 cookie'),
                    h('span', { key: 'hint', style: { ...S.groupCount, marginLeft: 8 } },
                        loginsOpen ? '点击收起' : '点击展开'),
                ]),
                loginsOpen ? h(Notes, { key: 'loginsNotes', title: '这份名单怎么来的' },
                    h('p', { style: S.note },
                        '只列这台浏览器真的访问过的域；第三方统计/广告域已排除。判据是 OWASP 的会话特征，'
                        + '名字不作为依据；不显示 cookie 的名字和值，名单只在本机内存，AI 看不到。')) : null,
                loginsOpen === false
                    ? null
                    : logins === null
                    ? h('div', { key: 'loginsUnknown', style: S.tip },
                        '读取不到：这个 profile 里的插件版本还没上报，或还没打开过浏览器。')
                    : (() => {
                        const pool = showAll ? logins.sites : logins.sites.filter((s) => s.likely);
                        const visible = pool.filter((s) => hiddenDomains.indexOf(s.domain) < 0);
                        const hiddenCount = pool.length - visible.length;
                        const byGroup = new Map();
                        const items = [];
                        for (const site of visible) {
                            const key = site.group ? site.group.key : null;
                            if (key === null) { items.push({ kind: 'single', site }); continue; }
                            let group = byGroup.get(key);
                            if (group === undefined) {
                                group = { kind: 'group', key, label: site.group.label, sites: [] };
                                byGroup.set(key, group);
                                items.push(group);
                            }
                            group.sites.push(site);
                        }
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
                                    site.alias || site.title || site.domain,
                                ]),
                                h('div', { key: 'desc', style: S.rowDesc },
                                    (site.alias ? site.domain + '　' : '')
                                    + (site.title && site.title !== site.alias ? '「' + site.title + '」　' : '')
                                    + site.cookies + ' 个 cookie'),
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
                            return h('div', { key: 'group-' + item.key }, [
                                h('div', { key: 'head', style: S.row }, [
                                    h('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
                                        h('div', { key: 'label', style: S.rowTitle },
                                            item.label + '（' + item.sites.length + ' 个域）'),
                                        h('div', { key: 'desc', style: S.rowDesc },
                                            sum(item.sites, (s) => s.cookies) + ' 个 cookie'),
                                    ]),
                                    h(Btn, {
                                        key: 'toggle',
                                        onClick: () => setOpenGroups(open
                                            ? openGroups.filter((k) => k !== item.key)
                                            : openGroups.concat([item.key])),
                                    }, open ? '收起' : '展开'),
                                ]),
                                open ? h('div', { key: 'members' }, item.sites.map((s) => rowFor(s, true))) : null,
                            ]);
                        };
                        return h('div', { key: 'loginsBody' }, [
                            h('div', { key: 'list', style: { ...S.list, marginTop: 8 } },
                                visible.length === 0
                                    ? h('div', { key: 'none', style: S.tip },
                                        hiddenCount > 0 ? '这一页都被你隐藏了。' : '还没发现登录过的站点。')
                                    : items.map(renderItem)),
                            h('div', { key: 'loginsFooter', style: S.footer }, [
                                h('span', { key: 'src', style: S.tip },
                                    (logins.source === 'live' ? '实时' : '上次快照')
                                    + (logins.attribution === 'unfiltered' ? '（未做第一方过滤）' : '')),
                                h(Btn, {
                                    key: 'all',
                                    onClick: () => setShowAll(!showAll),
                                }, showAll ? '只看像登录态的' : '显示其余 ' + (logins.total - logins.likelyTotal) + ' 个'),
                                hiddenCount > 0
                                    ? h(Btn, {
                                        key: 'reset',
                                        onClick: () => { setHiddenDomains([]); writeHiddenDomains([]); },
                                    }, '恢复 ' + hiddenCount + ' 个被隐藏的')
                                    : null,
                            ]),
                        ]);
                    })(),

                msg ? h('div', { key: 'msg', style: S.msg }, msg) : null,
                h('div', { key: 'foot', style: S.footer }, [
                    h(Btn, { key: 'refresh', onClick: refresh, disabled: busy }, '刷新状态'),
                ]),
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
