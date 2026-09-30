# 原生弹窗（dialog）规范 —— 待处理状态模式

> 采用 **Playwright 官方 MCP** 的做法（`@playwright/mcp` 的 `browser_handle_dialog`）。
> 此前我们试过两种自创方案（自动取消 + 报告 / 回显原文才能接受），都不停地冒新漏洞。
> 根因：**把"决定"和"触发"塞进同一次调用**，安全只能靠比对参数，于是永远能被绕过。
> 现在的形状是**结构上不存在捷径**。

## 一、三种状态（实测对比）

| | ① 无监听器（最初） | ② 监听器+自动取消（上一版） | ③ 监听器+挂起（本版） |
|---|---|---|---|
| 弹窗命运 | Playwright **自动吃掉** | 被我们取消 | **留着，等人决定** |
| 触发它的 click | 正常返回 | 正常返回 | **永远卡住**（所以必须赛跑） |
| 页面 JS | 正常 | 正常 | **被阻塞**（实测 `page.evaluate` 卡死） |
| 模型看得到吗 | ❌ 看不到 | ✅ 看到，但已被替你决定 | ✅ 看到，且**还没人决定** |
| 谁能决定接受 | 没人 | 只有那次点击（靠比对文字） | **任意一次后续调用** |

实验数据（本机实测）：
```
A 无监听器          -> click 正常返回 / 工单还在（弹窗已被自动取消）
B 监听器但不处理     -> click 卡住 4s 未返回 / 页面 JS 被阻塞 / 拿到 "confirm ... 确定删除工单 #1024 吗？"
B 之后手动 dismiss   -> 那个 click 才正常返回
```

## 二、设计

1. **挂起**：弹窗出现时**不 accept、不 dismiss**，登记为 per-page 的"待处理弹窗"（类型 + 原文 + dialog 对象）。
2. **赛跑**：会弹窗的动作（click / clickText / press / navigate）与"弹窗出现"赛跑；
   弹窗一冒出来，动作**立刻返回**并把弹窗内容交给模型（原动作继续挂着，等被回应）。
3. **短路**：已有待处理弹窗时，其它动作**不执行**，直接返回"有待处理弹窗"。
   —— 注意此时**绝不能去页面取快照**（`page.evaluate` / `page.title()` 都会被弹窗阻塞）。
4. **独立工具**：`browser_dialog({ accept, promptText? })` 回应它；没有待处理弹窗时报 `NO_DIALOG`。

## 三、威胁模型

- **资产**：不可撤销的动作（删数据 / 付款 / 提交 / 覆盖文件）
- **对抗者**：图省事的模型（想在一次调用里既点击又接受）
- **攻击路径**：把"接受"塞进触发它的那次调用里，跳过错失文本核对
- **阻断点（机制）**：
  1. 接受能力**不在** click 上——参数层面就没有这条捷径；
  2. 要接受，必须存在一个**已被上报过的待处理弹窗**；没有就报 `NO_DIALOG`；
  3. 弹窗内容必然先于决定出现在模型上下文里（上一步的返回）
- **残余风险**：模型可以不问用户就自己接受（靠 `codex-rules` 第四条约束）；
  页面文案与真实后果不一致时无法识别

## 四、护栏类型

| 要求 | 类型 |
|---|---|
| 没有待处理弹窗 → `browser_dialog` 报错，不接受任何东西 | **机制** |
| `browser_click` 上**没有**任何接受弹窗的参数 | **机制** |
| 弹窗一律默认挂起（既非接受也非取消） | **机制** |
| 回合与弹窗赛跑，动作不会卡死到超时 | **机制** |
| 接受/取消后在结果里写明 `ACCEPTED` / `DISMISSED` + 原文 | **机制** |
| 必须先取得用户对该动作的授权 | 说明 |
| 必须在回复里说明自己处理了什么弹窗 | 说明 |

## 五、对用户手动操作的影响（诚实说明）

- 你在那个窗口里**手动点出来的弹窗也会"挂着"**，页面会停在那儿等你点。
  （改动前它会被悄悄取消——你可能会觉得"这网站怎么点不动"。现在老实停着，更好。）
- 唯一的例外没有：**所有** `alert`/`confirm`/`prompt`/`beforeunload` 一律挂起。

## 六、实现要点

- `PlaywrightProvider`：`pendingDialogs`(Map page→记录)、`dialogWaits`(Map page→等待者集合)、
  `armDialogGuard()` 只登记+唤醒等待者；`pendingDialogFor()` / `clearPendingDialog()` / `armDialogWait()`
- `PlaywrightSession.runAction(page, action)`：短路 → 赛跑 → 返回 `{ blocked }`
- `PlaywrightSession.blockedSnapshot(page)`：弹窗挂起时的替身快照（**只用本地缓存**，不碰页面）
- `resolveDialog(accept, promptText)`：回应、等页面解锁、再取真实快照
- `tool.js`：新增 `browser_dialog`；**删除** `acceptDialog`

## 七、验收

`node D:\dsh-plugins\dsh-browser-playwright-codex\scripts\dsh-browser-verify.mjs`（或 `npm run verify`）第 `[4]`/`[5]` 组：
挂起如实上报 / 动作不卡死 / 挂起期间快照立刻返回 / 无弹窗时 `NO_DIALOG` /
取消后页面解锁 / 接受后动作真的执行 / click 上不再有 `acceptDialog`

## 八、待办

- `prompt` 的返回值回填（现在只支持 `promptText` 传入）
