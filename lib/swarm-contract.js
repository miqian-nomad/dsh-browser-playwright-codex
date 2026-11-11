/**
 * swarm-contract — 这段第三方资产的**接口契约**：插件到底捏着上游脚本的哪几个把手。
 *
 * 为什么要有这个文件（2026-11-10）：
 *
 * 起因是"上游改版，我这边会不会突然失效"。查完事实是：**不会**。上游那份脚本是
 * vendored 进来的（`assets/swarm-rebuild.upstream.js`），SHA-256 在 `scripts/swarm-patch.mjs`
 * 里锁死，上游在 GitHub 上改成什么样，本地这份一个字节都不会动。真正会失效的是另一件事 ——
 * 插件对上游内部结构的依赖**散落在三个文件的字符串里**（`swarm-intro.ts` 里 20 余处
 * `page.evaluate` 的字面量、`swarm-curtain.ts` 的桥、`swarm-patch.mjs` 的匹配片段），
 * 没有任何一处声明"这是我们要的接口"。于是：
 *
 *   - 加一处依赖，没人知道又多了个耦合点；
 *   - 补丁改一处，插件侧不知道自己的前提已经变了；
 *   - `docs/SWARM-CODE.md` 写着"改动 4 处"，实际已经是 7 处 —— 文档对不上代码，
 *     而这份文档正是"上游改版时该查哪里"的唯一依据。
 *
 * 所以这里把三个层次钉死，并交给 `tests/swarm-contract.test.ts` 机械校验：
 *
 *   Tier A（硬接口）  上游自己挂在 window 上的句柄树。补丁一处都没动，插件主路径全走这里。
 *                     上游改了 → 插件立刻坏 → 这是**必须盯住**的部分。
 *   Tier B（兜底口）  `.hud` / `[data-a=*]`。上游原生，但**已被我们的补丁删掉**。
 *                     插件只在"万一有人塞回未打补丁的原版"时才走这些分支。
 *   Tier C（自造桥）  `__dshSwarm*`。我们自己注入的，上游永远不会提供，也不该指望。
 *
 * 契约的用法：**改任何一处依赖，先改这个文件**，再改实现，再看测试红绿。测试会去
 * `assets/swarm-rebuild.upstream.js` 里逐条核对下面的每个名字是否真的存在 —— 上游换人、
 * 改名、删节点，这里第一个报错，而不是等某天浏览器里莫名其妙不播了。
 *
 * 法律面（0.8.1 起）：上游仓库根目录**仍然没有 LICENSE**（默认保留所有权利），
 * 但 Dhvanil Patel 于 2026-11-11 邮件书面许可本项目**打包与修改**，Joel Califa 于
 * 2026-11-08 书面许可并仅要求署名。所以资产可以随包分发，**但授权不是 MIT**：
 * 它是邮件许可，只覆盖本项目，不给第三方通用许可。别把这份资产 fork 成
 * "我们自己的版本" —— fork 不改变任何人拿到的权利，只会多出一份没有许可的副本。
 */
/** 上游出处与入仓指纹。这三项之外的任何东西，都不该成为插件的依赖。 */
export const SWARM_UPSTREAM = {
    /** 上游仓库。注意：根目录没有 LICENSE 文件。 */
    repo: 'DhvanilPatel/swarm-cursors',
    /** 入仓的那份原始文件（**未经补丁**）。diff 的基准。 */
    vendoredFile: 'assets/swarm-rebuild.upstream.js',
    /**
     * 入仓时那份上游文件的 SHA-256。
     * `scripts/swarm-patch.mjs` 的 `UPSTREAM_SHA256` 必须与它逐字符相同（测试会比对），
     * 否则"补丁按哪一版写的"就说不清了。
     */
    sha256: '6a30f19daaa182d52673035feaeae775c398fa426655cc71a87a451fe00c7bfe',
    /** 补丁后的产出（**随包分发的那份**）。 */
    patchedFile: 'assets/swarm-rebuild.js',
    /**
     * 授权状态：`none` = 仓库没有许可证；`permission` = 无许可证文本，但有作者的书面
     * 邮件许可（本项目：Dhvanil 2026-11-11 打包 + 修改；Joel 2026-11-08 效果 + 署名）。
     * 它不是"宽松许可"，第三方不能据此复用。
     */
    license: 'permission',
};
/**
 * Tier A —— 硬接口。上游官方句柄树，补丁完全没碰，插件主路径全走这里。
 *
 * 事实依据（2026-11-10 在 `assets/swarm-rebuild.upstream.js` 里核对过）：
 *   上游用 `const KEY = "__swarmRebuild"; window[KEY] = { toggle() {...}, stop(...) }` 暴露自己，
 *   并把 `app`（engine / env / view / tour）挂在同一个对象上。这一段补丁一字未改。
 */
export const SWARM_API = {
    /** 上游暴露自己的全局名。脚本第二次注入时会自己 `toggle()`。 */
    global: '__swarmRebuild',
    /** 句柄上的方法。 */
    methods: {
        toggle: 'toggle',
        /**
         * 停止。补丁后的脚本里 `stop(false)` = 立刻 destroy（取消 RAF、移除宿主），
         * `stop(true)` = 淡出回真页面（原来 "Go live" 按钮走的路）。
         * **插件一律用 `false`**：要的是立刻让路，不是让用户看淡出。
         */
        stop: 'stop',
    },
    /** `stop(reveal)` 的两种语义。 */
    stopArgs: {
        /** 立即销毁，不留残余覆盖层。插件用这个。 */
        immediate: false,
        /** 淡出到真页面。 */
        reveal: true,
    },
    /** `window.__swarmRebuild.app` 上插件用到的字段。 */
    app: {
        /** 引擎：速度/启动都在这里。 */
        engine: {
            path: 'engine',
            /** 速度，上游初值 `1`；上游 UI 的 `speeds = [1, 2, 3]`，按钮点 N 次即 1+N 倍。**可直接写。** */
            speed: 'speed',
            /** 启动引擎（`app.tour = true` 之后调它才真正开始往下滚）。 */
            start: 'start',
            /** 是否已启动。已是 `true` 就别再 `start()` 一遍。 */
            started: 'started',
        },
        /** 环境探针：整页滚动 / 局部滚动（`overflow:auto` 容器）都靠它。 */
        env: {
            path: 'env',
            /** `() => { ox, oy, sx, sy, vw, vh }`。局部滚动页里 `window.scrollY` 恒为 0，只有它知道真实位置。 */
            geom: 'geom',
            /** `(y, x) => void`，`behavior: 'instant'`。还原滚动位置用。 */
            scrollTo: 'scrollTo',
        },
        /** 视图：影子树的入口。 */
        view: {
            path: 'view',
            /** 影子树（上游以 `mode: 'open'` 创建）。 */
            root: 'root',
        },
        /** 整页模式开关。上游 Tour 按钮只做两件事之一就是这个；补丁删了按钮，所以直接写字段。 */
        tour: 'tour',
    },
    /** 句柄自身的影子树兜底（`app.view.root` 拿不到时用它）。 */
    rootFallback: 'root',
    /** 覆盖层的宿主元素：自定义元素标签，`document.querySelector` 可直接选到。 */
    hostTag: 'swarm-rebuild',
};
/**
 * Tier B —— 兜底口。上游原生，但**已被补丁删除**，插件只在"塞回了未打补丁的原版"时才用到。
 *
 * 2026-11-10 核对 `assets/swarm-rebuild.js`：`data-a=` 从上游的 11 处降到 2 处 ——
 * 控制条整个被删（`scripts/swarm-patch.mjs` 第 1 处改动），剩下两处是
 * `[data-a="sound"]`（有 `if (!b || !this.sfx)` 防护）和一处 `name` 拼接的通用选择器。
 *
 * **所以这一层不是主路径。** 主路径全在 Tier A。这里留着是为了：有人把未打补丁的原版
 * 塞回 `assets/`，插件仍然能用（点按钮），而不是当场白屏。
 */
export const SWARM_DOM = {
    /** 控制条容器。CSS 里定义：`.hud` / `.hud.on` / `.hud .dots` / `.hud .txt` / `.hud .status`。 */
    hud: '.hud',
    /** 头像组（控制条上的小圆点）。 */
    dots: '.hud .dots',
    /** 状态文字。 */
    status: '.hud .status',
    /** 进度条：`<div class="bar"><i></i></div>`。 */
    barFill: '.hud .bar i',
    /** 插件往影子树里插的隐藏规则所带的标记（重试时据此判断"已经插过了"）。 */
    hideStyleAttr: 'data-dsh-swarm-hide',
    /** 隐藏规则本体。用 CSSOM/内联 + 这条规则双层压住，重建的节点也一并压。 */
    hideStyleText: '.hud{display:none!important}',
    /**
     * 控制条按钮。`selector` 是插件实际会用 `querySelector` 去点的那个字符串。
     *
     * `upstreamQuery` 标的是**另一件事**：上游自己的代码里有没有出现过这个选择器。
     * 两者不等价，`close` 就是反例 —— 上游 HTML 里确实渲染了 `<button data-a="close" class="x">✕</button>`，
     * 但它的代码从不 `querySelector('[data-a="close"]')`，点击走事件委托。
     * 也就是说这一条是**我们自己声称有效**的选择器，靠的是 DOM 属性确实存在，而不是上游验证过。
     * 上游哪天把 `data-a` 换成别的属性名、HTML 模板改了而代码没改（反之亦然），差别就在这里。
     */
    buttons: {
        /** 整页自动滚动。插件不点它（改 `app.tour = true`），留着仅为完整性。上游有查询。 */
        tour: { action: 'tour', selector: '[data-a="tour"]', upstreamQuery: true },
        /** 帧速切换（1× → 2× → 3×）。插件直接写 `engine.speed`，不点它。上游有查询。 */
        speed: { action: 'speed', selector: '[data-a="speed"]', upstreamQuery: true },
        /** 声音开关（快捷键 M）。插件从不碰。上游有查询（带 `if (!b || !this.sfx)` 空值防护）。 */
        sound: { action: 'sound', selector: '[data-a="sound"]', upstreamQuery: true },
        /** Go live = `stop(true)`。兜底退出路径之一。上游有查询。 */
        live: { action: 'live', selector: '[data-a="live"]', upstreamQuery: true },
        /** 重播。插件从不碰。上游有查询。 */
        replay: { action: 'replay', selector: '[data-a="replay"]', upstreamQuery: true },
        /** ✕ = `stop(false)`。兜底退出路径之二。**上游不查询它**（事件委托），仅 HTML 属性存在。 */
        close: { action: 'close', selector: '[data-a="close"]', upstreamQuery: false },
    },
    /** 退出时的兜底顺序：先 live 再 close（对应 `stop(true)` / `stop(false)`）。 */
    exitFallbackOrder: ['[data-a="live"]', '[data-a="close"]'],
};
/**
 * Tier C —— 自造桥。插件注入页面、上游永远不会提供的那些全局名。
 *
 * 上游改版跟这一层**无关**（它根本不认识这些名字）。这一层坏的原因通常是插件自己改了
 * 注入时机、或者有人重构时漏了某个赋值 —— 所以它更需要测试，而不是文档。
 */
export const SWARM_BRIDGE = {
    /** `() => void`，插件注入的"立刻退出"入口。**Tier A 的 `stop(false)` 走不通时才用。** */
    stop: '__dshSwarmStop',
    /** `{ x, y }`，播放前的滚动位置。局部滚动页由 `env.geom()` 覆盖掉 window 那份。 */
    start: '__dshSwarmStart',
    /** `true` = 引擎已在 `addInitScript` 阶段提前起来，**绝不能再注入第二遍**（否则白底和光标全部重来）。 */
    early: '__dshSwarmEarly',
    /** `true` = AI 已经在用这个页面，整页滚动循环看到它就停。 */
    aiWorking: '__dshSwarmAiWorking',
    /** `true` = 快照已经拿到手，可以放行扫描。`swarm-patch.mjs` 第 5 处改动等它。 */
    go: '__dshSwarmGo',
};
/**
 * 上游自带的诊断钩子。插件**不依赖**它们，列在这里是为了两件事：
 *   ① 调试时知道这些名字是谁的，别误当成我们的桥；
 *   ② 上游改版核对时，这些名字若消失，说明改动范围比预期大，值得警觉。
 */
export const SWARM_UPSTREAM_DEBUG_HOOKS = ['__swarmShot', '__swarmSfxLog', '__swarmHidden', '__swarmUnhide'];
/**
 * 上游改版应急流程。**这是"有据可依"的落点** —— 不是祈祷上游别改，而是改了好核对。
 *
 * 触发条件：把新的上游文件换进 `assets/swarm-rebuild.upstream.js`（这一步必须是人主动做的）。
 * 本地日常开发**不需要**做任何事：vendored 文件不会自己变。
 *
 * 核对顺序（严格按此序，否则会追错方向）：
 *   1. `npm run swarm:patch` —— SHA 不符会当场拒绝，并报出新旧两个哈希。**先看这一条。**
 *   2. 按新哈希更新 `SWARM_UPSTREAM.sha256` 和 `scripts/swarm-patch.mjs` 的 `UPSTREAM_SHA256`
 *      （两处必须一致，测试会比对）。
 *   3. `node --test tests/swarm-contract.test.ts` —— 它会逐条到新文件里找 Tier A/B 的每个名字。
 *      红的每一条，就是上游这次真动过的地方，一条一条处理。
 *   4. 只有 Tier A 变红才是**必须改代码**的。Tier B 变红通常只需更新选择器（它只是兜底）。
 *      Tier C 变红说明插件自己的桥出了问题，与上游无关。
 *   5. 改完实现后，跑 `npm test` 全量 —— `swarm-intro.test.ts` 会用假 page 校验调用序列。
 *   6. 最后更新 `docs/SWARM-CODE.md`（改了几处、为什么）和 `docs/SWARM-CONTRACT.md` 的指纹段。
 */
export const SWARM_UPGRADE_CHECKLIST = [
    'npm run swarm:patch',
    'sync SWARM_UPSTREAM.sha256 <-> scripts/swarm-patch.mjs UPSTREAM_SHA256',
    'node --test tests/swarm-contract.test.ts',
    'triage red: Tier A = code change, Tier B = selector update, Tier C = our own bug',
    'npm test',
    'update docs/SWARM-CODE.md + docs/SWARM-CONTRACT.md fingerprints',
];
