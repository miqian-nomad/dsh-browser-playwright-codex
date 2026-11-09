import type { Page } from 'playwright-core';
/** 这个域名播过没有。跨所有活着的窗口判断。 */
export declare function hasPlayed(host: string): boolean;
/** 记下这个域名已经播过；ctx 传所属浏览器上下文，不传则用兜底。 */
export declare function markPlayed(host: string, ctx?: object): void;
/** 清空播放记录（设置卡上的「清空记录」用）：内存和磁盘一起清。 */
export declare function resetPlayed(): void;
/**
 * 「一直记住」开关切换时调用：打开就把这趟已有记录立刻落盘（别等关窗，
 * 免得宿主崩溃丢记录）；关掉就删掉磁盘记录，防止以后切回来时幽灵复活
 * （2026-11-09 复核 find A）。这个文件是插件自己写的，删它不动用户数据。
 */
export declare function onPersistPlayedChanged(enabled: boolean): void;
/**
 * 某个浏览器上下文关掉时调用：只忘掉**它自己**那趟播过哪些站。
 * 还有别的窗口活着时，别的窗口的记录一律保留（复核 find B）。
 * persist 打开时把这趟记录落盘，下次接着记。
 * 关单个标签不会走到这里 —— 那是 closeTab，不是 context 关闭。
 */
export declare function forgetOnBrowserClose(ctx?: object): void;
/** 这个页面正在播吗。 */
export declare function isPlaying(page: Page): boolean;
/**
 * 关掉正在播的特效。任何工具动作开始前都调用它 —— 覆盖层本身不接管鼠标
 * （pointer-events: none），所以拦不住点击；但 AI 动手时它该让开，画面才
 * 不会被人当成页面坏了。
 *
 * 失败一律吞掉：页面可能已经关掉、正在跳转，或者根本没播过。
 */
export declare function stopSwarm(page: Page): Promise<void>;
/**
 * 启动页。原来浏览器刚打开时停在 about:blank —— 一张纯白页，除了占位没有
 * 任何用处，用户看见只会问「这是干嘛的」。这里换成一张说明卡：告诉人它已经
 * 就绪、地址栏为什么是 about:blank、以及怎么用。没有外部资源，纯内联样式，
 * 断网也是秒开。
 */
export declare const WELCOME_HTML = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\n<title>\u6D4F\u89C8\u5668\u5DF2\u5C31\u7EEA</title>\n<style>\n  :root { color-scheme: light; }\n  * { box-sizing: border-box; }\n  body {\n    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;\n    background: #f5f6f8; color: #1d1d1f;\n    font: 15px/1.7 system-ui, -apple-system, \"Segoe UI\", \"Microsoft YaHei\", sans-serif;\n  }\n  .card {\n    width: min(560px, 86vw); padding: 38px 40px 34px; background: #fff; border-radius: 18px;\n    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 12px 40px rgba(0,0,0,.08);\n  }\n  .dot { width: 9px; height: 9px; border-radius: 50%; background: #34c759; display: inline-block; margin-right: 9px; vertical-align: middle; }\n  h1 { font-size: 23px; margin: 0 0 6px; letter-spacing: -.01em; }\n  .sub { color: #6b6b70; margin: 0 0 26px; }\n  .row { display: flex; gap: 12px; padding: 13px 0; border-top: 1px solid #ececf0; }\n  .k { color: #8a8a8f; min-width: 96px; font-size: 13px; }\n  .v { flex: 1; font-size: 14px; }\n  code { font-family: ui-monospace, Consolas, monospace; background: #f2f2f5; padding: 1px 6px; border-radius: 5px; font-size: 13px; }\n  .foot { margin: 24px 0 0; color: #9a9aa0; font-size: 12.5px; }\n</style></head><body>\n<div class=\"card\">\n  <h1><span class=\"dot\"></span>\u6D4F\u89C8\u5668\u5DF2\u5C31\u7EEA</h1>\n  <p class=\"sub\">\u60F3\u8BA9\u6211\u6253\u5F00\u54EA\u4E2A\u7F51\u7AD9\uFF0C\u8BF4\u4E00\u53E5\u5C31\u884C\u3002</p>\n  <div class=\"row\"><div class=\"k\">\u5730\u5740\u680F</div><div class=\"v\"><code>about:blank</code> \u2014\u2014 \u6D4F\u89C8\u5668\u5185\u7F6E\u7684\u7A7A\u767D\u9875\uFF0C\u8868\u793A\u8FD8\u6CA1\u53BB\u4EFB\u4F55\u7F51\u7AD9</div></div>\n  <div class=\"row\"><div class=\"k\">\u8FD9\u4E00\u9875</div><div class=\"v\">\u662F\u5149\u6807\u4E00\u7B14\u4E00\u7B14\u753B\u51FA\u6765\u7684\uFF0C\u6309 <code>Esc</code> \u53EF\u4EE5\u7ACB\u5373\u8DF3\u8FC7</div></div>\n  <div class=\"row\"><div class=\"k\">\u767B\u5F55\u72B6\u6001</div><div class=\"v\">\u4FDD\u5B58\u5728\u8FD9\u4E2A\u6D4F\u89C8\u5668\u91CC\uFF0C\u5173\u6389\u7A97\u53E3\u4E5F\u4E0D\u4F1A\u4E22</div></div>\n  <p class=\"foot\">\u7B2C\u4E00\u6B21\u6253\u5F00\u67D0\u4E2A\u7F51\u7AD9\u65F6\uFF0C\u90A3\u9875\u4E5F\u4F1A\u8FD9\u6837\u81EA\u5DF1\u957F\u51FA\u6765\u4E00\u6B21\u3002</p>\n</div></body></html>";
/**
 * 把空白页换成启动卡片，并在上面放一次特效。特效不等它播完（启动不能被
 * 拖住 9 秒），放出去就返回；真有工具动作要执行时 stopSwarm 会先把它关掉。
 */
export declare function showWelcome(page: Page, config: {
    swarm?: {
        enabled?: boolean;
        speed?: number;
        maxMs?: number;
    };
} | undefined): Promise<void>;
/**
 * 这次导航要不要播（只看不费时的条件，用来决定"开场白幕"要不要提前挂）。
 *
 * 注意传的是**目标地址**：导航前的 `page.url()` 还是旧页面，拿它判断会永远不播。
 * 遮罩页那种需要读页面的判断留到注入之后做，那时会顺手把白幕撤掉。
 */
export declare function willPlaySwarm(targetUrl: string, config: Parameters<typeof maybePlaySwarm>[1], headless?: boolean): boolean;
/** 导航之后调用：够条件就播一次，不等它播完（导航照常立刻返回快照）。 */
export declare function maybePlaySwarm(page: Page, config: {
    swarm?: {
        enabled?: boolean;
        oncePerSite?: boolean;
        speed?: number;
        maxMs?: number;
        playOnVeiled?: boolean;
        range?: 'viewport' | 'page';
    };
} | undefined, headless?: boolean): void;
