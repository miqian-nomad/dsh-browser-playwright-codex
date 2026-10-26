/**
 * 白名单的网络层守卫：把「只能访问这些站点」变成**路上的一道闸**，而不是只在调用入口
 * 打一次勾。
 *
 * 起因（2026-10-26 实测）：入口检查只覆盖 navigate / 点击带 href 的链接 / 切标签 / 开标签。
 * 页面自己 `location.href = 'http://别的站点'`、meta refresh、302 跳转、表单提交，全都
 * 绕过白名单——实测把名单设成 `127.0.0.1` 后，页面脚本一跳就落在了 `localhost` 上。
 * 入口检查在这里永远追不上：那些导航不是插件发起的。
 *
 * 做法：接管这个 context 的每一条请求（context.route），按主机名判定。
 *   - **文档请求**（导航、iframe）：不在名单里 → 掐断，并记下来。调用方在动作收尾时
 *     用它把「我点了但页面没动」变成一条明确的 URL_NOT_ALLOWED，而不是一次静默。
 *   - **数据请求**（xhr / fetch / eventsource）：不在名单里 → 掐断。页面脚本不该拿着
 *     这个浏览器的身份去白名单外的站点取数据。
 *   - 其余子资源（script / img / css / font / media）：放行。它们几乎是页面渲染的刚需
 *     （CDN、头像、字体），且不带目标站点的凭据；拦掉只会让页面看起来是坏的。
 *
 * 只在配置了名单时才接管：空名单的语义是「任意站点」，此时接管路由纯属拖慢每一页
 * （Playwright 的路由会关掉 HTTP 缓存）。
 *
 * @module dsh-browser-playwright-codex/navigation-guard
 */
import type { BrowserContext } from 'playwright-core';
/** One request the guard refused, in the shape callers report it. */
export interface BlockedRequest {
    /** Full requested URL. */
    url: string;
    /** Hostname that was not in the allow-list. */
    host: string;
    /** Playwright resourceType: document, xhr, script, … */
    resourceType: string;
    /** True for a navigation-level block (a document request). */
    document: boolean;
    /** Epoch milliseconds. */
    at: number;
}
/**
 * Refuse every request to a host outside the allow-list for one context.
 *
 * Installed once per context, before the first navigation. When the configured
 * list is empty nothing is installed: "any host" must not pay the routing cost.
 * @param context - the context to guard.
 * @param allowedDomains - reads the live allow-list.
 * @param onBlocked - called for each refused request; the caller keeps the last
 *   document-level block and turns it into an error for the action that caused it.
 * @returns true when a guard was installed, false when the list is empty.
 */
export declare function installHostGuard(context: BrowserContext, allowedDomains: () => readonly string[], onBlocked: (blocked: BlockedRequest) => void): Promise<boolean>;
