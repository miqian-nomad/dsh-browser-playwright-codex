# 快照取名 / 折叠 / 工具说明 —— 规范

> 这份文件存在的理由：2026-09-15 前后，取名与折叠规则是**"看见一个现象就补一条规则"**长出来的，
> 于是 select、表格行、按钮 value 之间反复打架，改一次冒一个新毛病。
> 以后**先改这份规范 + 先加验收用例，再改代码**。

配套验收：`node D:\dsh-plugins\_deps\scripts\dsh-browser-verify.mjs`（改完必须出现「全部通过」，总数以脚本输出为准；加 `--live` 会联网采样真实页面）

---

## 一、取名优先级链（nameOf，从高到低，命中即停）

| 顺序 | 来源 | 适用 |
|---|---|---|
| 1 | `aria-label` | 任何元素 |
| 2 | `<label for>` / 最近的 `<label>` | 表单控件 |
| 3 | `alt` / `placeholder` / `title` | 任何元素 |
| 4 | `value`（`el.value` 兜底） | **只限** `<input type="button\|submit\|reset">` |
| 5 | 自由文本输入框的**实时** `el.value`（密码框除外） | `input` / `textarea` |
| 6 | 见第二节 | 可操作元素 |
| 7 | `ownText`（自身直接文字） | 不可操作的内容节点 |

**硬规矩**：`<button>` **永远不用** `value` 取名（它的可访问名字是文字）。
按钮类控件若 1–6 全落空，最后才回退到 `value`。

## 二、可操作元素的最终名字

由 `descendantName` 收集：**深度优先、文档顺序**，先取文字（`maxText` 封顶），
全无文字再取子孙的 `aria-label` / `alt` / `title`，最后 `maxName` 截断。
跳过 `script/style/noscript/template/hidden/aria-hidden` 子树；深度 ≤6，访问 ≤400 个元素。

- **自身文字 + 子孙文字合并**（`<a>尾<span>前</span></a>` → `"尾 前"`）。
- 例外见第四节（容器角色）。

## 三、折叠规则（去掉纯重复行）

父节点名字为 N 时，子节点满足**全部**条件就丢弃（子树的子节点上提到父级）：
1. 子节点**没有 ref**（可点的子节点是独立把手，永不折叠）
2. 子节点名字长度 ≥ 2
3. N 非空，且 **N 包含子节点名字**（`N.indexOf(child.name) !== -1`）

例：`link "多段 按钮"` 下的 `generic "多段"` / `generic "按钮"` 都被折叠。

**有意保留**：`<a><h3>标题</h3></a>` 里的 `h3` 会被折叠（丢掉层级）——优先"不重复"。

## 四、容器角色黑名单（CONTENT_ROLES）

`combobox` / `listbox` / `row` / `gridcell` **不从子孙取名**——它们的子孙是**内容**不是**标签**。

- `<select>` 单独处理：名字 = **当前选项**的文字（对齐"文本框显示当前 value"的既有约定）
- `<tr>` 保持无名，单元格各自带名字

## 五、工具说明（description）写作模板

统一词汇，禁止同义词漂移：

| 一律用 | 禁止 |
|---|---|
| target / trigger | element、thing |
| **shown WITHOUT a ref**（plain text, e.g. `generic "设置"`） | no ref、unlabeled |
| landing note | result note |
| IRON RULE | MUST、请注意 |
| copy the label exactly as rendered | 精确文本 |

每条说明必须含五要素，顺序固定：
1. **做什么**（一句话）
2. **什么时候用**
3. **什么时候别用**（防滥用）
4. **怎么验证**（成功/失败各看什么）
5. **失败路径**（不许盲试、不许降级坐标）

长度预算：**≤1500 字符**；超了先删例子，不删五要素。

## 六、变更流程（防止"越改越多"）

1. **先在这份规范里写清规则**，再在 `dsh-browser-verify.mjs` **加一条用例**，跑一遍确认它是 FAIL
2. 改实现，跑到 verify **全绿**（输出「全部通过」；总数以脚本输出为准）
3. `--live` 采样真实页面，记录四个数：refs / 快照字符数 / 无名可操作元素数 / 重复子行数，与改动前对比
4. 插件代码改动**必须重启 DSH 才生效**——必须主动告知用户，并在重启后用**全新 agent 盲测**说明
5. 说明改动优先于实现改动：说明是唯一让模型用得对的东西

## 七、已知且有意保留的行为（别再当 bug 报）

- 纯图标 / 无 `alt` / 无任何文字的可点元素 → **无名**（页面没给，不编）
- `<input type="submit">` 不带 value → **无名**（默认文案在浏览器内部，取不到）
- `<a><h3>标题</h3></a>` → h3 被折叠
- `<a><button>X</button></a>`（非法 HTML）→ 两个同名 ref，都保留
- 空输入框 → 无名（诚实反映"还没填"）

## 八、剪枝规则（isVisible：什么时候连同整棵子树一起丢）

`isVisible` 返回 false 表示**不再下钻**，整棵子树都会被丢掉，所以只认真正看不见的情况：
`hidden` / `aria-hidden="true"` / `display:none` / `visibility:hidden`。

- **`display: contents` 必须继续下钻**（2026-09-22 加）。这种盒子自己不生成盒子，`getBoundingClientRect()` 恒为 0×0，
  但子元素照常排版。按"宽或高 > 0"判它会连带整棵子树被剪掉：DSH 自己的 Web UI 就是把整个界面挂在这样一个
  包装层底下，于是快照恒为 0 个 ref，而且 `truncated` 还是 false——不是被截断，是压根没进去。
- 其余元素仍按矩形判定：`width > 0 || height > 0`。

> 排查提示：快照为空时先看 `truncated`。**false + 0 个 ref = 剪枝问题**（在 `isVisible` 这一层）；
> **true + 少量 ref = 预算问题**（调 `snapshot.maxNodes`）。两者别混。

