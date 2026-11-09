/**
 * 把上游那份 `swarm-rebuild.js` 打成本项目发布的那一份。
 *
 * 为什么是"原文件 + 补丁脚本"而不是直接改那个文件：
 * 那份脚本是第三方作品（Dhvanil Patel），授权还没落地。原文件留在仓库里、
 * 逐字节可校验，改动集中在这个脚本里可以一眼看完，也能一条命令还原 —— 谁在
 * 什么时候动了它的哪一行，永远查得到。
 *
 * 用法：
 *   node scripts/swarm-patch.mjs          生成 assets/swarm-rebuild.js
 *   node scripts/swarm-patch.mjs --check  只校验（CI / 测试用），不一致就退出码 1
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = new URL('../', import.meta.url)
const UPSTREAM = fileURLToPath(new URL('assets/swarm-rebuild.upstream.js', ROOT))
const SHIPPED = fileURLToPath(new URL('assets/swarm-rebuild.js', ROOT))

/** 上游文件（commit 3d49e0ac，2026-11-06）的 SHA-256。对不上就说明换过上游，先核对再改补丁。 */
const UPSTREAM_SHA256 = '6a30f19daaa182d52673035feaeae775c398fa426655cc71a87a451fe00c7bfe'

const TRANSFORMS = [
  {
    why: '删掉自带的底部控制条（速度 / Tour / Go live / ✕）——插件是自动播放，它只是噪音',
    find: `<div class="hud">
  <div class="dots"></div>
  <div class="txt"><span class="status">Scanning page…</span></div>
  <div class="bar"><i></i></div>
  <button data-a="tour" title="Auto-scroll while the swarm builds">Tour</button>
  <button data-a="speed" title="Build speed">1×</button>
  <button data-a="sound" class="snd" title="Sound (M)"></button>
  <button data-a="live" class="pri" hidden title="Fade back to the real page">Go live</button>
  <button data-a="replay" hidden title="Wipe and rebuild again">Replay</button>
  <button data-a="close" class="x" title="Exit (Esc)">✕</button>
</div>\`;`,
    replace: '`;',
  },
  {
    why: '控制条没了，但它上面那些节点（状态文字 / 进度条 / 头像组）还被到处写 —— 换成离屏的哑元素，下游代码一行不用动',
    find: `      this.hud = $(".hud");
      this.status = $(".status");
      this.barFill = $(".bar i");
      this.dots = $(".dots");`,
    replace: `      // 控制条已移除（见 scripts/swarm-patch.mjs）。下面四个字段在各处被写，
      // 换成不挂在文档里的哑元素：写入照常成功，但屏幕上什么都不会出现。
      this.hud = $(".hud") || document.createElement("div");
      this.status = $(".status") || document.createElement("span");
      this.barFill = $(".bar i") || document.createElement("i");
      this.dots = $(".dots") || document.createElement("div");`,
  },
  {
    why: '既然不显示，每 200 毫秒给哑元素拼一次 innerHTML 就是白烧 CPU —— 控制条不在文档里就整段跳过',
    find: `    updateHud() {
      const E = this.engine;
      const v = this.view;
      if (!E.ready) return;`,
    replace: `    updateHud() {
      const E = this.engine;
      const v = this.view;
      if (!v.hud.isConnected) return;
      if (!E.ready) return;`,
  },
  {
    why: '播完那一下还要把 Go live / Replay / Tour / Speed 四个按钮设成显示或隐藏 —— 按钮没了，这里会空指针抛错（实测：动画一结束就抛）',
    find: `      v.root.querySelector('[data-a="live"]').hidden = false;
      v.root.querySelector('[data-a="replay"]').hidden = false;
      v.root.querySelector('[data-a="tour"]').hidden = true;
      v.root.querySelector('[data-a="speed"]').hidden = true;`,
    replace: `      // 控制条已移除：逐个找、找到才设，找不到就跳过（原来这里是硬取 .hidden）。
      for (const [name, hidden] of [["live", false], ["replay", false], ["tour", true], ["speed", true]]) {
        const button = v.root.querySelector('[data-a="' + name + '"]');
        if (button) button.hidden = hidden;
      }`,
  },
  {
    why: '扫描会滚一遍页面，和插件的"拍快照"抢：插件要先把快照拿到手再放行（见 page-actions 的 navigate）。开场（空白+光标转）至少停 2.8 秒让人看清，最多等 5 秒，等不到照常开始（快照异常时别白屏太久）',
    find: `      mark("blank");
      if (this.dead) return;
      await this.scan();`,
    replace: `      mark("blank");
      if (this.dead) return;
      // 等插件放行（它要先拍完快照），并且给开场留够时间：白幕→特效这段是
      // "空白 + 光标飞进来打转"，太短会一闪而过（用户实测豆瓣那种快站看不到）。
      // 至少 2.8 秒、最多 5 秒，之后无论有没有信号都开始画，不能把页面卡在空白上。
      {
        const waitFrom = performance.now();
        while (
          (window.__dshSwarmGo !== true || performance.now() - waitFrom < 2800) &&
          !this.dead &&
          performance.now() - waitFrom < 5000
        ) {
          await new Promise((r) => setTimeout(r, 40));
        }
      }
      // 提前注入时 document_start 的 DOM 还没建全，滚动容器可能认错（异步渲染站）。
      // 放行之后页面已 load，重认一次滚动环境；**不动白底颜色**，避免中途变色闪一下。
      if (window.__dshSwarmEarly === true) {
        const oldTarget = this.env.isRoot ? window : this.env.scroller;
        const fresh = detectEnv();
        fresh.host = this.view.host;
        this.env = fresh;
        this.view.env = fresh;
        this.view.measure();
        // bind() 在开场就把 scroll 监听绑死在"当时的" scroller 上。重认后若换了容器，
        // 补一条到新容器，否则容器滚动时世界图层不跟随（2026-11-09 复核 find A）。
        // 旧监听留在原目标上无害：syncWorld() 每次读的都是新 env，幂等。
        const newTarget = fresh.isRoot ? window : fresh.scroller;
        if (newTarget !== oldTarget) {
          const sync = () => { if (!this.view.frozen) this.view.syncWorld(); };
          newTarget.addEventListener("scroll", sync, { passive: true });
          (this.unbinds || (this.unbinds = [])).push(() => newTarget.removeEventListener("scroll", sync, { passive: true }));
        }
      }
      await this.scan();`,
  },
  {
    why: '去掉白底 .5s 淡入：document_start 提前注入时，淡入那半秒里原页面会透出来（用户最介意的"一瞬间原画面"）。设成无过渡再加 on，第一帧就是满不透明的页面底色',
    find: `      this.sfx.intro();
      this.view.bg.classList.add("on");`,
    replace: `      this.sfx.intro();
      // 白底不做 .5s 淡入（见 scripts/swarm-patch.mjs）：第一帧就盖死，别让原页面透出来。
      this.view.bg.style.setProperty("transition", "none", "important");
      this.view.bg.classList.add("on");`,
  },
  {
    why: '把结尾的自启动改成"等 <html> 出现再启动"：插件用 addInitScript 在网页脚本之前注入时，document_start 这一刻 scrollingElement 还是 null，detectEnv 会直接抛错、白底全无。普通 page.evaluate 注入时 <html> 已在，这条分支立即执行，行为不变',
    find: `    debug: { captureModel, detectEnv, Sound },
  };
  start();
})();`,
    replace: `    debug: { captureModel, detectEnv, Sound },
  };
  // document_start 注入时 <html> 还没建好（实测 scrollingElement 为 null）。等解析器
  // 把 <html> 挂上来再启动，就能从第一帧用**原版自己的引擎**盖住页面：白底 + 18 个
  // 光标飞进来打转，全程只有这一套，不再有"自造白幕 → 切换引擎"的断层。
  const _dshBoot = () => {
    if (document.documentElement) { start(); return; }
    const mo = new MutationObserver(() => {
      if (document.documentElement) { mo.disconnect(); start(); }
    });
    mo.observe(document, { childList: true });
  };
  _dshBoot();
})();`,
  },
]

function apply(source) {
  let out = source
  for (const t of TRANSFORMS) {
    const first = out.indexOf(t.find)
    if (first < 0) throw new Error('补丁找不到目标片段：' + t.why)
    if (out.indexOf(t.find, first + 1) >= 0) throw new Error('补丁目标不唯一：' + t.why)
    out = out.slice(0, first) + t.replace + out.slice(first + t.find.length)
  }
  return out
}

const upstream = readFileSync(UPSTREAM, 'utf8')
const sha = createHash('sha256').update(readFileSync(UPSTREAM)).digest('hex')
if (sha !== UPSTREAM_SHA256) {
  console.error(`上游文件被换过：SHA-256 是 ${sha}，补丁是按 ${UPSTREAM_SHA256} 写的。先核对再改补丁。`)
  process.exit(2)
}

let patched
try {
  patched = apply(upstream)
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error))
  process.exit(2)
}

const check = process.argv.includes('--check')
if (check) {
  const current = readFileSync(SHIPPED, 'utf8')
  if (current !== patched) {
    console.error('assets/swarm-rebuild.js 与"上游 + 补丁"的结果不一致。跑 node scripts/swarm-patch.mjs 重新生成。')
    process.exit(1)
  }
  console.log('swarm-patch: ok（上游 ' + UPSTREAM_SHA256.slice(0, 12) + '… + ' + TRANSFORMS.length + ' 处改动）')
} else {
  writeFileSync(SHIPPED, patched)
  console.log(
    'swarm-patch: 已生成 assets/swarm-rebuild.js（' +
      (patched.length / 1024).toFixed(1) +
      ' KB，' +
      TRANSFORMS.length +
      ' 处改动）',
  )
}
