/**
 * swarm-contract — 把 `src/swarm-contract.ts` 里声明的每一条接口钉到**上游文件的真实内容**上。
 *
 * 这个测试存在的理由很具体：插件有二十多处字符串捏着上游脚本的内部结构（散在
 * `swarm-intro.ts` 的 `page.evaluate` 字面量、`swarm-curtain.ts` 的桥、`swarm-patch.mjs`
 * 的匹配片段），而**没有任何一处声明过"这些是我们要求的接口"**。于是上游改版时，坏的方式
 * 是"某个页面某天不播了"，而不是"某一行报错"。契约文件把这些名字集中声明；这个测试负责
 * 到上游文件里逐条核实它们还在，并且和插件侧、补丁脚本、文档三边对齐。
 *
 * 另一个真实缺陷也在这里治：`docs/SWARM-CODE.md` 写着"改动 4 处"，而 `swarm-patch.mjs`
 * 的 `TRANSFORMS` 早就是 7 处 —— 那份文档正是"上游改版该查哪里"的唯一依据，它一漂移，
 * 整个应急流程就建在假前提上。所以改动数量要对着代码数，不对着记性写。
 *
 * NOTE: 这里的断言**不碰浏览器**，全部是静态核对，所以能在 `npm test` 里天天跑。
 * 真正"播起来对不对"归 `swarm-intro.test.ts`（假 page 校验调用序列）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  SWARM_UPSTREAM,
  SWARM_API,
  SWARM_DOM,
  SWARM_BRIDGE,
  SWARM_UPSTREAM_DEBUG_HOOKS,
} from '../src/swarm-contract.ts'

const read = (rel: string) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
const readBuf = (rel: string) => readFileSync(new URL('../' + rel, import.meta.url))

const upstream = read(SWARM_UPSTREAM.vendoredFile)
const patched = read(SWARM_UPSTREAM.patchedFile)
const patchScript = read('scripts/swarm-patch.mjs')
const intro = read('src/swarm-intro.ts')
const contractDoc = read('docs/SWARM-CONTRACT.md')
const codeDoc = read('docs/SWARM-CODE.md')

/** 补丁脚本里实际有几处改动。`why:` 每个 TRANSFORM 恰好写一条，是数得准的锚点。 */
const transformCount = [...patchScript.matchAll(/^\s{4}why:/gm)].length

// ---------------------------------------------------------------------------
// Tier A：硬接口。上游官方句柄，补丁没碰，插件主路径全走这里。
// ---------------------------------------------------------------------------

test('Tier A: the upstream handle is still exposed through the same KEY mechanism', () => {
  // 上游的暴露方式是一段具体代码：`const KEY = "__swarmRebuild"; window[KEY] = {...}`。
  // 断言 KEY 机制本身，而不只是"文件里有这个字符串"——后者随便一次注释提及就能骗过。
  assert.ok(
    upstream.includes(`const KEY = "${SWARM_API.global}"`),
    `上游不再用 \`const KEY = "${SWARM_API.global}"\` 暴露自己。契约里的 Tier A 全部失效，` +
      '插件的主路径（speed / tour / env.geom / stop）会同时坏掉。去 docs/SWARM-CONTRACT.md 走一遍应急流程。',
  )
  assert.ok(
    new RegExp('window\\[KEY\\]\\s*=\\s*\\{').test(upstream),
    '上游不再往 `window[KEY]` 上挂对象；Tier A 的整棵句柄树失去落点。',
  )
})

test('Tier A: every handle the plugin reaches for still exists upstream', () => {
  // 逐条：语义名 -> 上游文件里必须出现的字面证据。
  // 右列写的是"上游真的会产出这个形状"的最小证据，不是我们的用法。
  const evidence: Array<readonly [string, RegExp | string]> = [
    ['stop(reveal)', /stop\(\s*reveal\b|stop\(false\)|stop\(true\)/],
    ['toggle()', 'toggle()'],
    // engine.speed —— 引擎构造时 `this.speed = 1`，插件的调速就是直接写它。
    ['app.engine.speed', /this\.speed\s*=\s*1/],
    ['app.engine.start()', /start\(\)\s*\{|\.start\(\)/],
    ['app.engine.started', 'started'],
    // env.geom() —— 局部滚动页唯一的位置来源。
    ['app.env.geom()', /geom\(\)\s*\{/],
    // env.scrollTo(y, x) —— 签名必须是 (y, x)，插件按这个顺序调用。
    ['app.env.scrollTo(y, x)', /scrollTo\(\s*y,\s*x\s*\)/],
    ['app.view.root', 'view'],
    ['app.tour', 'tour'],
  ]

  const broken: string[] = []
  for (const [what, needle] of evidence) {
    const found = typeof needle === 'string' ? upstream.includes(needle) : needle.test(upstream)
    if (!found) broken.push(what)
  }
  assert.deepEqual(
    broken,
    [],
    '上游已不再产出这些形状，插件的 Tier A 依赖断了：' +
      broken.join(', ') +
      '。改代码前先确认 docs/SWARM-CONTRACT.md 的 Tier A 分层还成立。',
  )
})

test('Tier A: the overlay host tag is unchanged', () => {
  assert.ok(
    upstream.includes(SWARM_API.hostTag),
    `上游的覆盖层宿主不再是 \`<${SWARM_API.hostTag}>\`。插件用 \`document.querySelector('${SWARM_API.hostTag}')\` ` +
      '直接 remove 宿主（stopSwarm 与 CSP 兜底两处），标签一变这两条静默失效、覆盖层留在页面上。',
  )
})

test('Tier A: stop() distinguishes immediate from reveal — the plugin relies on the difference', () => {
  // stop(false) 和 stop(true) 在上游是两条不同的收尾路径（立即 destroy vs 淡出到真页面）。
  // 插件只用 false。若上游把参数语义翻转，插件会从"立刻让路"变成"淡出 1.2 秒"，
  // 而那 1.2 秒里覆盖层还接着命中测试，后续点击直接超时 —— 2026-11-08 实测过这个坑。
  assert.equal(SWARM_API.stopArgs.immediate, false, '契约里"立即销毁"必须是 false')
  assert.ok(
    /a === "close"\)\s*stop\(false\)|stop\(false\)/.test(upstream),
    '上游不再用 stop(false) 表示"立即销毁"；插件的退出路径要重新核对（见 SWARM-CODE.md 的关闭语义）。',
  )
  assert.ok(
    /a === "live"\)\s*stop\(true\)|stop\(true\)/.test(upstream),
    '上游不再用 stop(true) 表示"淡出到真页面"；Tier B 的 live 兜底含义要重新核对。',
  )
})

// ---------------------------------------------------------------------------
// Tier B：兜底口。上游有，但已经被补丁删掉 —— 这一层"存在"和"生效"是两件事。
// ---------------------------------------------------------------------------

test('Tier B: every control-bar button is really rendered by the upstream HTML', () => {
  // 断言的是**属性存在**（上游 HTML 模板 `<button data-a="X">`），不是"上游代码查询过它"。
  // 这两件事不一样，`close` 就是反例：HTML 里有这个属性，代码里从不 querySelector 它，
  // 点击走事件委托。插件点它是靠属性存在，所以只要属性在就成立。
  const missing: string[] = []
  for (const [name, button] of Object.entries(SWARM_DOM.buttons)) {
    if (!upstream.includes(`data-a="${button.action}"`)) missing.push(`${name} -> data-a="${button.action}"`)
  }
  assert.deepEqual(missing, [], '上游不再渲染这些按钮：' + missing.join(', '))

  assert.ok(upstream.includes(SWARM_DOM.hud), `上游不再有 \`${SWARM_DOM.hud}\` 控制条容器`)
  // 结构证据：进度条是 <div class="bar"><i></i></div>，藏在控制条里。
  assert.ok(/class="bar"><i><\/i><\/div>/.test(upstream), '上游的进度条结构变了（`.bar > i`）')

  // 上游代码自己查询过哪些 —— 与 HTML 属性分开核对。对得上才说明我们对上游的理解没跑偏。
  const queried = new Set([...upstream.matchAll(/\[data-a="([a-z]+)"\]/g)].map((m) => m[1] as string))
  for (const [name, button] of Object.entries(SWARM_DOM.buttons)) {
    assert.equal(
      queried.has(button.action),
      button.upstreamQuery,
      `契约声明 ${name} 的 upstreamQuery=${button.upstreamQuery}，但上游代码里` +
        `${queried.has(button.action) ? '确实' : '并没有'} querySelector('[data-a="${button.action}"])'。` +
        '上游改了查询方式，还是契约记错了？',
    )
  }
})

test('Tier B is a FALLBACK, not a live path: the patch really deletes the control bar', () => {
  // 这一条钉住一个容易搞错的事实：随包那份 `assets/swarm-rebuild.js` 里**没有控制条按钮**。
  // 所以插件里 `querySelector('[data-a="speed"]')` 那类分支永远拿到 null，走的全是 Tier A。
  // 如果有人（未来的我）以为控制条还在、把主路径改回点按钮，动画会安静地不加速。
  //
  // 唯一的例外是 sound：补丁保留 `renderSoundBtn()` 里的 `querySelector('[data-a="sound"]')`
  // 不删，因为上游那段本身带 `if (!b || !this.sfx) return` 空值防护，删它反而要多改一处。
  // 所以它留着的不是按钮，是一句查不到就返回的死代码。
  const stillRendered = Object.entries(SWARM_DOM.buttons)
    .filter(([name]) => name !== 'sound')
    .map(([name, b]) => [name, `data-a="${b.action}"`] as const)

  for (const [name, attr] of stillRendered) {
    assert.ok(
      !patched.includes(attr),
      `补丁后的资产里仍有 ${attr}（${name} 按钮）—— 控制条没被删干净。` +
        '要么补丁的第 1 处改动失效了，要么文件被换过。',
    )
    // 删掉之前，上游里这些是齐的（防止"上游自己悄悄删了"被误读成"我们的补丁干的"）。
    assert.ok(upstream.includes(attr), `上游原本应有 ${attr}，现在没有了 —— 上游结构变了，Tier B 要重新核对`)
  }

  // 补丁后整个文件里 `data-a=` 只剩 2 处：sound 的查询 + 第 4 处改出来的拼接查询。
  const remaining = [...patched.matchAll(/data-a=/g)].length
  assert.equal(
    remaining,
    2,
    `补丁后 data-a= 还有 ${remaining} 处（预期 2 处）。补丁的第 1/2/3/4 处改动可能有一处没生效。`,
  )
})

test("Tier B: the plugin's own hide-hud markers match the contract", () => {
  // 反向钉住：契约里声明了标记与规则文本，实现里必须真的用同一份。
  // 这里只能查字符串（实现是写死在 evaluate 函数体里的字面量，见下一条测试的说明）。
  assert.ok(
    intro.includes(SWARM_DOM.hideStyleAttr),
    `swarm-intro.ts 不再使用 ${SWARM_DOM.hideStyleAttr} —— 契约与实现脱节`,
  )
  assert.ok(
    intro.includes(SWARM_DOM.hideStyleText),
    `swarm-intro.ts 里的隐藏规则不是 ${SWARM_DOM.hideStyleText} —— 契约与实现脱节`,
  )
  assert.ok(intro.includes(SWARM_DOM.hud), 'swarm-intro.ts 不再按 .hud 找控制条 —— 契约与实现脱节')
})

// ---------------------------------------------------------------------------
// Tier C：自造桥。与上游无关，但同样需要钉住 —— 它坏通常是插件自己重构漏了赋值。
// ---------------------------------------------------------------------------

test('Tier C: every bridge global is both written and read inside the plugin', () => {
  const sources = intro + read('src/swarm-curtain.ts') + read('src/page-actions.ts') + patchScript
  const missing: string[] = []
  for (const [name, global] of Object.entries(SWARM_BRIDGE)) {
    const hits = sources.split(global).length - 1
    if (hits === 0) missing.push(`${name} (${global})`)
  }
  assert.deepEqual(missing, [], '这些自造桥在插件里一处都找不到（要么删了没清契约，要么改名了）：' + missing.join(', '))
  // __dshSwarmStop 是 stopSwarm 的实际出口，必须有赋值点（写入方），不只是在别处被读。
  assert.ok(
    new RegExp(SWARM_BRIDGE.stop + '\\s*=').test(intro),
    `${SWARM_BRIDGE.stop} 没有赋值点 —— 它是 stopSwarm 的兜底出口，只读不写等于没有`,
  )
})

test('Tier C: the upstream debug hooks are still labelled as NOT ours', () => {
  // 契约把上游自带的 4 个 __swarm* 钩子单列，是为了调试时别把它们误当成我们的桥。
  // 它们留着还有第二个用处：上游改版时若消失，说明改动范围比预期大。
  const missing = SWARM_UPSTREAM_DEBUG_HOOKS.filter((hook) => !upstream.includes(hook))
  assert.deepEqual(
    missing,
    [],
    '上游不再提供这些诊断钩子：' + missing.join(', ') + ' —— 上游改动面比预期大，值得看一眼',
  )
  // 它们绝不能和我们的桥撞名。
  const bridgeValues: string[] = Object.values(SWARM_BRIDGE)
  for (const hook of SWARM_UPSTREAM_DEBUG_HOOKS) {
    assert.ok(!bridgeValues.includes(hook), `上游钩子 ${hook} 被误登记成了我们的自造桥`)
  }
})

// ---------------------------------------------------------------------------
// 指纹：三处 SHA 必须说同一件事，否则"补丁按哪一版写的"就说不清。
// ---------------------------------------------------------------------------

test('fingerprint: the vendored upstream file still hashes to the contract value', () => {
  const actual = createHash('sha256').update(readBuf(SWARM_UPSTREAM.vendoredFile)).digest('hex')
  assert.equal(
    actual,
    SWARM_UPSTREAM.sha256,
    `入仓的上游文件被换过：实际 ${actual}，契约写 ${SWARM_UPSTREAM.sha256}。` +
      '换文件是**人的主动动作**，必须同步走 docs/SWARM-CONTRACT.md 的应急流程，不能只改这一个常量。',
  )
})

test('fingerprint: the patch script and the contract agree on the upstream hash', () => {
  // 两处各写一份哈希是这个仓库最典型的漂移点（patch 脚本要自校验，契约要对外声明）。
  // 少同步一处，补丁就会对着错误的基线做文本替换。
  const inScript = /UPSTREAM_SHA256\s*=\s*['"]([0-9a-f]{64})['"]/.exec(patchScript)?.[1]
  assert.ok(inScript !== undefined, 'swarm-patch.mjs 里找不到 UPSTREAM_SHA256')
  assert.equal(
    inScript,
    SWARM_UPSTREAM.sha256,
    `swarm-patch.mjs 的 UPSTREAM_SHA256 (${inScript}) 与契约 (${SWARM_UPSTREAM.sha256}) 不一致`,
  )
})

test('fingerprint: the shipped asset is what the patch script produces from the vendored one', () => {
  // `npm run swarm:patch -- --check` 是权威校验，但它要跑子进程；这里做静态的快速版：
  // 补丁后的文件必须比上游大（我们注入的桥与等待逻辑都是净增），且不含控制条（上一条已断言）。
  const upBytes = readBuf(SWARM_UPSTREAM.vendoredFile).length
  const patchedBytes = readBuf(SWARM_UPSTREAM.patchedFile).length
  assert.ok(
    patchedBytes > upBytes,
    `补丁后的资产 (${patchedBytes}B) 不大于上游 (${upBytes}B) —— 补丁可能没生效，或者两份文件被换了位置`,
  )
  // 上游那份必须是**未打补丁**的：它不能含有我们注入的桥。
  assert.ok(
    !upstream.includes(SWARM_BRIDGE.early),
    `上游文件里出现了我们的自造桥 ${SWARM_BRIDGE.early} —— vendored 基准已被污染，diff 不可信`,
  )
  // 反之，补丁后的必须含有它。
  assert.ok(patched.includes(SWARM_BRIDGE.early), `补丁后的资产缺少 ${SWARM_BRIDGE.early} —— 补丁没打上`)
})

// ---------------------------------------------------------------------------
// 文档：契约文档、代码说明、以及补丁脚本自己的说法必须与代码一致。
// ---------------------------------------------------------------------------

test('docs: the change count in SWARM-CODE.md is the real TRANSFORMS length', () => {
  // 这是这条测试诞生的直接原因：文档写"4 处"，代码是 7 处。
  assert.ok(transformCount >= 1, 'swarm-patch.mjs 里数不出 TRANSFORMS（找不到 `why:` 行）')
  const claimed = [...codeDoc.matchAll(/改了什么（(\d+)\s*处/g)].map((m) => Number(m[1]))
  assert.ok(claimed.length > 0, 'docs/SWARM-CODE.md 里找不到"我们改了什么（N 处）"这一行 —— 结构变了，更新本测试')
  for (const n of claimed) {
    assert.equal(
      n,
      transformCount,
      `SWARM-CODE.md 说改了 ${n} 处，swarm-patch.mjs 实际 ${transformCount} 处。` +
        '这份文档是上游改版的核对依据，数字必须对着代码数。',
    )
  }
  // 同段落里"改动只碰这四处"这类文字也会漂。
  const wordNums: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  for (const m of codeDoc.matchAll(/只碰这([一二三四五六七八九十])处/g)) {
    const n = wordNums[m[1] as string]
    assert.equal(n, transformCount, `SWARM-CODE.md 说"只碰这${m[1]}处"（${n}），实际 ${transformCount} 处`)
  }
})

test('docs: SWARM-CONTRACT.md quotes the same fingerprint as the contract', () => {
  assert.ok(
    contractDoc.includes(SWARM_UPSTREAM.sha256),
    'docs/SWARM-CONTRACT.md 没有引用契约里的 SHA-256 —— 上游改版时读者会拿旧的哈希去对',
  )
  assert.ok(contractDoc.includes(SWARM_UPSTREAM.repo), `docs/SWARM-CONTRACT.md 没有写明上游出处 ${SWARM_UPSTREAM.repo}`)
  assert.ok(contractDoc.includes(SWARM_UPSTREAM.patchedFile), 'docs/SWARM-CONTRACT.md 没有写明随包分发的是哪一份')
})

test('docs: every data-a selector named in the contract doc is declared in the contract', () => {
  // 文档里写了的，契约里必须有（否则读者照文档去查，代码里没有这个定义）。
  const declared = new Set<string>(Object.values(SWARM_DOM.buttons).map((b) => b.action))
  const named = new Set([...contractDoc.matchAll(/data-a="([a-z]+)"/g)].map((m) => m[1] as string))
  const orphans = [...named].filter((name) => !declared.has(name))
  assert.deepEqual(orphans, [], 'SWARM-CONTRACT.md 提到了契约里没声明的按钮：' + orphans.join(', '))
})

test('docs: the contract doc still states the licence position it is built on', () => {
  // 整份契约的前提是"上游无许可证、不能 fork、只能本地自用 + 默认关"。这个前提写在文档
  // 显要处，是为了防止未来有人看到 `swarm-contract.ts` 就以为"我们已经 fork 了一份自己的"。
  assert.equal(SWARM_UPSTREAM.license, 'none', '契约把授权标成了非 none —— 若上游真的加了许可证，先改上游事实再改这里')
  assert.ok(
    /没有\s*LICENSE|无许可证|保留所有权利/.test(contractDoc),
    'SWARM-CONTRACT.md 没有写明"上游无 LICENSE"，后来者会误以为这份资产可以随包分发',
  )
  assert.ok(
    /不能\s*fork|不可\s*fork|fork 不改变/.test(contractDoc),
    'SWARM-CONTRACT.md 没有说明"fork 不改变授权"这一点 —— 这正是当初想 fork 时的误区',
  )
})

test('docs: SWARM-CODE.md points at the contract so the upgrade path is discoverable', () => {
  // 从"讲原理"的那份文档，必须能走到"讲接口"的那份。否则应急流程藏在一个没人读的文件里。
  assert.ok(
    codeDoc.includes('SWARM-CONTRACT') || codeDoc.includes('swarm-contract'),
    'docs/SWARM-CODE.md 没有链接到 SWARM-CONTRACT —— 上游改版时读者找不到接口清单',
  )
})
