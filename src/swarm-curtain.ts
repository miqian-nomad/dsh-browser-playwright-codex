/**
 * 「同一个引擎」的提前启动：从打开网页的第一帧起，画面就是**原版特效自己**的
 * 白底 + 18 个光标在转，全程只有这一套，不再有「自造白幕 → 切到原版」的交接断层。
 *
 * 做法：把随包的 `assets/swarm-rebuild.js`（原版引擎）整段塞进 `addInitScript`，
 * 它在页面自己的脚本之前、<html> 一出现就启动（脚本里的"延后到 <html>"补丁见
 * scripts/swarm-patch.mjs）。所以它比"打开页面→加载完→再注入"早得多，原页面
 * 来不及露脸（用户 2026-11-09 最在意的那"一瞬间原画面"就此压住）。
 *
 * 只在真的要播的那次启动：导航前用 `window.name` 打标记（实测**跨域导航会保留**），
 * addInitScript 读到标记才启动、并立刻清掉。三重保险防"残留标记误启动"：
 *   · 只在顶层文档启动（`window.top === window`），iframe 不另起一套；
 *   · 标记带时间戳，超过 30 秒的旧标记不认（导航失败后残留的那枚会自己过期）；
 *   · 任何"不播"路径都调 dropCurtain，把 name 和引擎一起清干净。
 * 万一标记没落到最终文档（少见的重定向），playSwarm 会检测到"引擎不在"并回退到
 * 旧的"加载后注入"，功能仍可用，只是那一页会先露一下。
 *
 * 为什么不再自画 canvas 假光标：那是第二套引擎，和原版的光标参数再像也是两套，
 * 交接必然"断一下、突然重新开始"（用户反复指出的缝）。用原版自己从第一帧登场，
 * 缝就没了 —— 这正是用户 16:38 选过的「删掉自造的、用原版开场」，这次真正落地。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright-core'

/** 导航前写进 window.name 的标记：新文档第一帧读到它才启动引擎。 */
const TOKEN = '__dsh_swarm__:'

/**
 * 生成注册进 `addInitScript` 的脚本全文。
 *
 * 必须用**字符串拼接**把资产塞进去，不能用模板字符串：资产里有大量反引号和
 * `${...}`，放进外层模板字符串会被当成插值直接炸掉。
 * 每次现读资产：和 playSwarm 里 `readScript()` 一样，改完磁盘立即用新的，不缓存。
 */
export function swarmBootScript(): string {
  const asset = fs.readFileSync(fileURLToPath(new URL('../assets/swarm-rebuild.js', import.meta.url)), 'utf8')
  return (
    'if (window.top === window && typeof window.name === "string" &&\n' +
    '    window.name.indexOf("' +
    TOKEN +
    '") === 0 &&\n' +
    '    Date.now() - Number(window.name.slice(' +
    TOKEN.length +
    ')) < 30000) {\n' +
    '  window.name = "";\n' +
    '  window.__dshSwarmEarly = true;\n' +
    asset +
    '\n}\n'
  )
}

/** 导航前打标记：下一次文档创建时，addInitScript 会把原版引擎提前启动。 */
export async function armCurtain(page: Page): Promise<void> {
  try {
    await page.evaluate((token: string) => {
      window.name = token
    }, TOKEN + Date.now())
  } catch {
    /* 页面还没就绪（about:blank 之前），下一次导航照样会带标记 */
  }
}

/** 清掉导航标记（导航失败时别让它留到下一次普通跳转）。 */
export async function clearCurtainToken(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      window.name = ''
    })
  } catch {
    /* 页面已经走了 */
  }
}

/**
 * 决定"这一页不播"时：把可能已经提前启动的引擎彻底关掉。
 *
 * 这层原是"撤掉自造白幕"，现在没有白幕了 —— 引擎是真的、会一直等放行，所以必须
 * 调它自己的 stop(false)、把宿主立刻摘掉、把滚动还原，否则那一页会永远盖着白。
 * 触发场景：遮罩页不播、CSP 把影子树样式表挡成半成品、oncePerSite 判定跳过、
 * 用户关掉特效等。顺手把标记和几个开关清干净，免得同文档内 toggle/replay 被旧值影响。
 */
export async function dropCurtain(page: Page, _waitForSwarm = false): Promise<void> {
  try {
    await page.evaluate(() => {
      const w = window as unknown as {
        name: string
        __dshSwarmEarly?: boolean
        __dshSwarmGo?: boolean
        __swarmRebuild?: {
          app?: { env?: { scrollTo?: (y: number, x: number) => void } }
          stop?: (reveal?: boolean) => void
        }
        __dshSwarmStart?: { x: number; y: number }
      }
      const api = w.__swarmRebuild
      if (api !== undefined && typeof api.stop === 'function') api.stop(false)
      // 还原滚动（提前启动的引擎在等放行、还没扫描，通常没滚过；保险起见照做）。
      const start = w.__dshSwarmStart
      if (start !== undefined) {
        const env = api?.app?.env
        if (env !== undefined && typeof env.scrollTo === 'function') env.scrollTo(start.y, start.x)
        else window.scrollTo(start.x, start.y)
        delete w.__dshSwarmStart
      }
      // stop(false) 是延时移除，这里立刻摘，免得 AI 紧接着的点击命中测试被盖住。
      for (const host of document.querySelectorAll('swarm-rebuild')) host.remove()
      w.name = ''
      delete w.__dshSwarmEarly
      delete w.__dshSwarmGo
    })
  } catch {
    /* 页面已经走了 */
  }
}
