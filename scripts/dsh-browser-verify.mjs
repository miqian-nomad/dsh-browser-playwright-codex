#!/usr/bin/env node
/**
 * dsh-browser-verify — 一条命令跑完 dsh-browser-playwright 的快照取名/折叠与
 * click/hover 两种定位模式的回归。改任何取名规则或工具说明后必须跑通它。
 *
 * 跑法（包内即自包含，无需 _deps）:
 *   node scripts/dsh-browser-verify.mjs [--live]
 *   --live  额外在 news.baidu.com 上采样真实页面的统计（会联网）
 * 退出码 0 = 全绿；1 = 有失败项。
 *
 * 期望值不写死在这里：工具面从 lib/contract.js 推导，所以新增或调整工具时
 * 只有 contract.ts 需要改，这份脚本不会因为"数字过期"而假报警。
 */
import http from 'node:http';
import { Config as ConfigSchema, PlaywrightProvider } from '../lib/playwright.js';
import { renderSnapshot } from '../lib/snapshot-render.js';

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ok   ' + name); }
  else { failures.push(name); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
function has(tree, fragment) { return tree.indexOf(fragment) !== -1; }
function lineAfter(tree, fragment) {
  const lines = tree.split('\n');
  const i = lines.findIndex(l => l.includes(fragment));
  return i >= 0 ? (lines[i + 1] || '') : '(not found)';
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>v</title></head><body>
<h1>verify</h1>
<a href="/1"><span>折叠链接</span></a>
<a href="/2"><div><span>多层折叠</span></div></a>
<a href="/3"><h3>标题链接</h3></a>
<button value="v">按钮文字</button>
<input type="button" value="输入按钮">
<select><option>甲</option><option selected>乙</option></select>
<a href="/4"><img src="x.png" alt="图标链接"></a>
<a href="/5"><img src="x.png" alt="图标"><span>图文链接</span></a>
<a href="/6">尾<span>前</span></a>
<button><span>多段</span><span>按钮</span></button>
<a href="/7"><span aria-hidden="true">装饰</span><span>真名</span></a>
<table><tr><td>单元格</td></tr></table>
<button id="reveal">显示详情</button>
<button id="closebtn" aria-label="关闭弹层"><span>×</span></button>
<div id="detail" style="display:none">详情 <a href="/d">详情链接</a></div>
<span id="settings">设置</span>
<div id="panel" style="display:none"><a href="/a">菜单甲</a><a href="/b">菜单乙</a></div>
<div id="contentsWrap" style="display:contents"><a href="/dc">内容链接</a></div>
<span class="dup">重复项</span><span class="dup">重复项</span>
<button id="del">删除记录</button><div id="row">记录存在</div>
<button id="ask">弹提示</button>
<script>
document.getElementById('settings').addEventListener('mouseenter', () => { document.getElementById('panel').style.display = 'block'; });
document.getElementById('settings').addEventListener('mouseleave', () => { document.getElementById('panel').style.display = 'none'; });
document.getElementById('reveal').addEventListener('click', () => {
  document.getElementById('detail').style.display = 'block';
  document.getElementById('reveal').textContent = '详情已显示';
});
document.getElementById('closebtn').addEventListener('click', () => { document.title = 'closed'; });
document.getElementById('del').addEventListener('click', () => {
  if (window.confirm('确定删除这条记录吗？')) { document.getElementById('row').style.display = 'none'; }
});
document.getElementById('ask').addEventListener('click', () => { window.alert('操作成功'); });
</script></body></html>`;

const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(HTML); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ = 'http://127.0.0.1:' + server.address().port + '/';
const provider = new PlaywrightProvider(ConfigSchema({ launch: { headless: true, persistent: false, navigationTimeoutMs: 20000 }, idleTimeoutMs: 0 }));
const session = await provider.acquire('verify');

console.log('[1] 快照取名与折叠');
const s0 = await session.navigate(URL_, 'load');
const tree = renderSnapshot(s0);
check('折叠直接子节点 (a>span)', has(tree, 'link "折叠链接" [ref=') && !lineAfter(tree, 'link "折叠链接"').includes('折叠链接'));
check('折叠多层包裹 (a>div>span)', has(tree, 'link "多层折叠" [ref=') && !has(tree, 'generic "多层折叠"'));
check('标题链接折叠 (有意取舍)', has(tree, 'link "标题链接" [ref=') && !has(tree, 'heading "标题链接"'));
check('<button> 取文字不取 value', has(tree, 'button "按钮文字" [ref=') && !has(tree, 'button "v" [ref='));
check('<input type=button> 取 value', has(tree, 'button "输入按钮" [ref='));
check('<select> 显示当前选项', has(tree, 'combobox "乙" [ref=') && has(tree, 'option "甲" [ref='));
check('纯图标链接折叠 img', has(tree, 'link "图标链接" [ref=') && !has(tree, 'img "图标链接"'));
check('图文链接保留 img', has(tree, 'link "图文链接" [ref=') && has(tree, 'img "图标"'));
check('自身+子孙文字合并', has(tree, 'link "尾 前" [ref='));
check('多段文字折叠干净', has(tree, 'button "多段 按钮" [ref=') && !has(tree, 'generic "多段"'));
check('aria-hidden 子文字被跳过', has(tree, 'link "真名" [ref=') && !has(tree, '装饰'));
check('表格行不从单元格取名', has(tree, 'row [ref=') && has(tree, 'cell "单元格"'));
check('display:contents 容器继续下钻（0×0 不得剪掉子树）', has(tree, 'link "内容链接" [ref='));

console.log('[2] 悬停：ref 模式 / text 模式 / 错误路径');
const settingsRef = (function find(ns) { for (const n of ns) { if (n.ref && n.name === '设置') return n.ref; const h = find(n.children || []); if (h) return h; } })(s0.nodes);
check('「设置」确实没有 ref', settingsRef === undefined);
const h1 = await session.hoverText('设置');
check('text 模式悬停成功且指出目标', has(h1.landingNote || '', '设置') && /\+\d+/.test(h1.landingNote || ''));
function treeHas(nodes, name) { return (nodes || []).some(n => n.name === name || treeHas(n.children, name)); }
check('悬停揭示出菜单项', treeHas(h1.nodes, '菜单甲'));
const h2 = await session.hoverText('重复项');
check('同名时提示 FIRST of N', has(h2.landingNote || '', 'FIRST of 2'));
let hoverErr = '';
try { await session.hoverText('不存在的标签'); } catch (e) { hoverErr = e.code; }
check('找不到时报 HOVER_TARGET_NOT_FOUND', hoverErr === 'HOVER_TARGET_NOT_FOUND');

console.log('[3] 点击：ref 模式 / text 模式 / 错误路径');
const revealRef = (function find(ns) { for (const n of ns) { if (n.ref && n.name === '显示详情') return n.ref; const h = find(n.children || []); if (h) return h; } })(s0.nodes);
const c1 = await session.clickText('显示详情');
check('text 模式点击让页面真的变', (c1.totalRefs || 0) > (s0.totalRefs || 0) && has(renderSnapshot(c1), '详情已显示'));
const c2 = await session.click(revealRef);
check('ref 模式仍可用', has(renderSnapshot(c2), '[ref='));
const c3 = await session.clickText('重复项');
check('同名点击提示 FIRST of 2', has(c3.landingNote || '', 'FIRST of 2'));
let clickErr = '';
try { await session.clickText('不存在的按钮'); } catch (e) { clickErr = e.code; }
check('找不到时报 CLICK_TARGET_NOT_FOUND', clickErr === 'CLICK_TARGET_NOT_FOUND');
let ariaNote = '';
let ariaHit = false;
try { ariaNote = ((await session.clickText('关闭弹层')).landingNote || ''); ariaHit = true; } catch (e) { ariaNote = 'ERR ' + String(e.message || e); }
const ariaEffect = await session.evaluate('document.title');
check('text 模式能按 aria-label 命中（且真的点到了）', ariaHit && ariaEffect === 'closed', ariaNote.slice(0, 90) + ' | title=' + ariaEffect);

const leftover = await session.evaluate("document.querySelectorAll('[data-dsh-label-target]').length");
check('页面无 label 残留', leftover === 0);

console.log('[4] 原生弹窗：挂起 + 独立工具回应');
const findRef = (ns, name) => { for (const n of ns) { if (n.ref && n.name === name) return n.ref; const h = findRef(n.children || [], name); if (h) return h; } return undefined; };
const rowDisplay = () => session.evaluate("getComputedStyle(document.getElementById('row')).display");

// a) 没有待处理弹窗时，回应必须被拒
let noDlgErr = '';
try { await session.resolveDialog(true); } catch (e) { noDlgErr = e.code || String(e.message).slice(0, 40); }
check('没有待处理弹窗时拒绝回应（NO_DIALOG）', noDlgErr === 'NO_DIALOG', noDlgErr);

// b) 触发弹窗：动作不卡死，弹窗如实上报为待处理，且还没人决定
const sDel = await session.snapshot({});
const delRef = findRef(sDel.nodes, '删除记录');
const t0 = Date.now();
const pendSnap = await session.click(delRef);
const elapsed = Date.now() - t0;
const pendNote = pendSnap.dialogNote || '';
check('触发弹窗的动作不卡死（<3s）', elapsed < 3000, elapsed + 'ms');
check('弹窗如实上报为待处理', /confirm/i.test(pendNote) && /PENDING/i.test(pendNote) && pendNote.includes('确定删除这条记录吗'), pendNote.slice(0, 120));
// 注意：弹窗挂起期间页面被阻塞，这里**不能**去碰页面（rowDisplay 会卡死）。
// "还没人决定"改在取消之后验证：记录仍在即证明期间没有发生任何接受。

// c) 挂起期间取快照必须立刻返回（不能去碰被阻塞的页面）
const tBlock = Date.now();
const blockedSnap = await session.snapshot({});
const t1ms = Date.now() - tBlock;
check('挂起期间快照立刻返回（<2s）', t1ms < 2000, t1ms + 'ms');
check('挂起期间的快照也提示待处理', /PENDING/i.test(blockedSnap.dialogNote || ''), (blockedSnap.dialogNote || '').slice(0, 90));

// d) 取消 → 页面解锁，动作未执行
const disSnap = await session.resolveDialog(false);
check('取消后写明 DISMISSED', /DISMISSED/.test(disSnap.landingNote || ''), (disSnap.landingNote || '').slice(0, 110));
check('取消后记录还在', (await rowDisplay()) !== 'none');
const afterDismiss = await session.snapshot({});
check('取消后页面解锁（快照可用）', (afterDismiss.totalRefs || 0) > 0);

// F1~F4：红队发现的三类「卡死 / 绕过守门」，逐条固化成用例
const withTimeout = (p, ms, tag) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT ' + tag)), ms))]);
let ct1 = null;
try { ct1 = await withTimeout(session.clickText('删除记录'), 6000, 'clickText'); }
catch (e) { ct1 = { dialogNote: 'ERR ' + String(e.message || e).slice(0, 40) }; }
check('F1 clickText 自己触发弹窗时不卡死', !/TIMEOUT/.test(ct1.dialogNote || ''), (ct1.dialogNote || '').slice(0, 90));
await session.resolveDialog(false).catch(() => { });

const sF = await session.snapshot({});
await session.click(findRef(sF.nodes, '删除记录'));
let swRes = '';
try { await withTimeout(session.switchTab(0), 5000, 'switchTab'); swRes = 'no-throw'; } catch (e) { swRes = e.code || String(e.message).slice(0, 24); }
check('F2 挂起时 switchTab 被拒而不是卡死', swRes === 'DIALOG_PENDING', swRes);
let otRes = '';
try { await withTimeout(session.openTab(URL_, 'load'), 5000, 'openTab'); otRes = 'no-throw'; } catch (e) { otRes = e.code || String(e.message).slice(0, 24); }
check('F3 挂起时 openTab 被拒而不是卡死', otRes === 'DIALOG_PENDING', otRes);
let ctbRes = '';
try { await withTimeout(session.closeTab(0), 5000, 'closeTab'); ctbRes = 'no-throw'; } catch (e) { ctbRes = e.code || String(e.message).slice(0, 24); }
check('F4 挂起时 closeTab 被拒（不得隐式取消）', ctbRes === 'DIALOG_PENDING', ctbRes);
check('F4 之后弹窗仍然挂起（没被偷偷取消）', /PENDING/.test(((await session.snapshot({})).dialogNote) || ''));
await session.resolveDialog(false);

// e) 再弹一次 → 接受 → 动作真的执行
const sDel2 = await session.snapshot({});
await session.click(findRef(sDel2.nodes, '删除记录'));
const accSnap = await session.resolveDialog(true);
check('接受后写明 ACCEPTED', /ACCEPTED/.test(accSnap.landingNote || ''), (accSnap.landingNote || '').slice(0, 110));
check('接受后动作真的执行了（记录被删）', (await rowDisplay()) === 'none');

// f) alert 同样挂起、同样要独立回应
const sAsk = await session.snapshot({});
await session.click(findRef(sAsk.nodes, '弹提示'));
const askSnap = await session.snapshot({});
check('alert 同样挂起上报', /alert/i.test(askSnap.dialogNote || '') && /PENDING/i.test(askSnap.dialogNote || ''), (askSnap.dialogNote || '').slice(0, 90));
await session.resolveDialog(true);
check('alert 回应后页面解锁', ((await session.snapshot({})).totalRefs || 0) > 0);

// F7：畸形信号不得遗弃 promise（旧实现会 unhandledRejection 崩宿主 / 卡死）
const sSig = await session.snapshot({});
let sig7 = 'ok';
try { await withTimeout(session.click(findRef(sSig.nodes, '删除记录'), true), 6000, 'bogusSignal'); }
catch (e) { sig7 = 'ERR ' + String(e.message).slice(0, 30); }
check('F7 畸形信号不卡死也不崩', sig7 === 'ok', sig7);
await session.resolveDialog(false).catch(() => { });

// F6：persistent 模式下多个会话共享同一页，别人的挂起弹窗不得被接管
const fakePage = {};
provider.pendingDialogs.set(fakePage, { dialog: null, type: 'confirm', message: 'x', owner: 'owner-A' });
check('F6 别的 owner 拿不到别人的挂起弹窗', provider.takePendingDialog(fakePage, 'owner-B') === undefined);
check('F6 本人 owner 可以拿到', (provider.takePendingDialog(fakePage, 'owner-A') || {}).owner === 'owner-A');
provider.pendingDialogs.delete(fakePage);

console.log('[5] 工具面：新增 browser_dialog，删除 acceptDialog');
const toolMod = await import('../lib/tool.js');
const contractMod = await import('../lib/contract.js');
const reg = [];
const toolConfig = toolMod.Config({});
// The plugin checks its own surface against contract.ts at load time, so the
// fake registry has to answer schemas() the way the real one does.
toolMod.apply(
  {
    browser: { acquire: async () => ({}) },
    get: () => undefined,
    tools: { register: (t) => reg.push(t), schemas: () => reg },
  },
  toolConfig,
);
const expectedTools = contractMod.registeredToolNames(toolConfig.toolPrefix, {
  allowEvaluate: toolConfig.allowEvaluate,
  allowCdp: toolConfig.allowCdp,
  extractConfigured: toolConfig.extract?.provider !== undefined && toolConfig.extract?.model !== undefined,
  registerDisabledTools: toolConfig.registerDisabledTools,
});
const byName = (n) => reg.find((t) => t.name === n);
check('存在 browser_dialog', byName('browser_dialog') !== undefined);
check('browser_dialog 有 accept 参数', !!byName('browser_dialog') && !!(byName('browser_dialog').parameters.properties || {}).accept);
check('browser_click 不再有 acceptDialog', !!byName('browser_click') && !('acceptDialog' in (byName('browser_click').parameters.properties || {})));
check(
  '工具面与 contract 一致（' + expectedTools.length + ' 个）',
  reg.length === expectedTools.length && expectedTools.every((n) => byName(n) !== undefined),
  'count=' + reg.length + ' expected=' + expectedTools.length,
);

const t1 = await session.tabs();
check('tabs 每项带 active 且只有一个 true', t1.every(t => typeof t.active === 'boolean') && t1.filter(t => t.active).length === 1);
const activeBefore = (t1.find(t => t.active) || {}).index;
await session.openTab(URL_ + '?second', 'load');
const t2 = await session.tabs();
const activeNow = (t2.find(t => t.active) || {}).index;
check('新开的标签页成为 active', t2.length === t1.length + 1 && activeNow === t2.length - 1 && activeNow !== activeBefore);

if (process.argv.includes('--live')) {
  console.log('[7] 真实页面采样 (news.baidu.com)');
  try {
    const live = await session.navigate('https://news.baidu.com/', 'load');
    const t = renderSnapshot(await session.snapshot({}));
    const unnamed = (t.split('\n').filter(l => /^- (link|button|menuitem|tab|combobox|textbox|checkbox|radio|switch|option|slider|spinbutton) \[ref=/.test(l.trim()))).length;
    console.log('  info refs=' + live.totalRefs + ' chars=' + t.length + ' unnamedActionable=' + unnamed);
    check('真实页可快照', live.totalRefs > 0);
  } catch (e) { console.log('  info 联网采样失败: ' + String(e.message || e).slice(0, 120)); }
}

await provider.dispose();
server.close();
console.log('');
console.log(failures.length === 0 ? ('全部通过 (' + pass + ' 项)') : ('失败 ' + failures.length + ' 项 / 共 ' + (pass + failures.length) + ' 项: ' + failures.join(', ')));
process.exit(failures.length === 0 ? 0 : 1);
