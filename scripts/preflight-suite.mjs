/**
 * preflight-suite — 「这次测试到底跑完了没有」，只此一份实现。
 *
 * 为什么单独成模块（2026-11-12，MOSS 复核 0.8.1 时抓到的"假绿"通道）：
 *   旧 preflight 只解析 `ℹ fail N`，而摘要那行里的 `fail 0` 是**写死的字符串**；
 *   `ℹ cancelled` 和 `ℹ todo` 一次都没读。于是"被取消 7 条、fail 0"这种局面会**判绿** ——
 *   `node --test` 自己也不把它当失败。CHANGELOG 里 0.7.9 那节记录过真实案例：0.7.8 的 7 条
 *   被打成 cancelledByParent，对外说的"278 通过"里实际只跑了 271 条。
 *
 * 抽出来之后：preflight 用它、守卫测试也用它（喂合成的汇总文本，不需要真跑一遍测试）。
 * 判定原则是"**读不到就不算绿**"：任何一个计数缺失，都当硬错误，而不是当 0。
 */

/** 摘要里必须读到的计数。少一个就说明这个 Node 的输出版本变了，或测试命令没跑起来。 */
const REQUIRED = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']

/**
 * 从 `node --test` 的输出里读汇总计数。
 *
 * 只认行首的 `ℹ <name> <n>` 形式（Node 的 TAP-ish 摘要行）。正文里出现的同名文字
 * （例如某条测试自己的输出）不会被当成计数。
 *
 * @param {string} output - `node --test` 的完整 stdout+stderr。
 * @returns {{ counts: Record<string, number>, missing: string[], cancelledByParent: number | null }}
 */
export function parseSuiteSummary(output) {
  /** @type {Record<string, number>} */
  const counts = {}
  for (const name of REQUIRED) {
    const m = new RegExp('^\\s*\\u2139\\s*' + name + '\\s+(\\d+)\\s*$', 'm').exec(output)
    if (m) counts[name] = Number(m[1])
  }
  const parent = /^\s*\u2139\s*cancelledByParent\s+(\d+)\s*$/m.exec(output)
  const missing = REQUIRED.filter((name) => counts[name] === undefined)
  return { counts, missing, cancelledByParent: parent ? Number(parent[1]) : null }
}

/**
 * 判定一次测试运行是否真的"跑完且全过"。
 *
 * 硬错误的情形（任何一条都足以让 preflight 红）：
 *   1. 计数读不全 —— 读不到就不算绿（旧实现在这里会静默当 0）；
 *   2. `fail > 0`；
 *   3. `cancelled > 0` —— 被取消的测试没有结论，不能算进"通过"；
 *   4. `todo > 0` —— 待办不是通过；
 *   5. 出现了 `cancelledByParent` 且大于 0 —— 那是老 Node 的静默丢弃通道；
 *   6. 恒等式对不上：`tests ≠ pass + fail + cancelled + skipped + todo`；
 *   7. 命令非零退出（即使计数看起来干净）。
 *
 * @param {string} output - `node --test` 的输出。
 * @param {number} [exitCode] - 子进程退出码；非 0 一律当硬错误。
 * @returns {{ problems: string[], okLine: string }}
 */
export function checkSuiteSummary(output, exitCode = 0) {
  const { counts, missing, cancelledByParent } = parseSuiteSummary(output)
  const problems = []

  if (missing.length > 0) {
    problems.push('测试汇总读不到计数：' + missing.join(', ') + '（读不到就不算绿；是不是 `node --test` 没跑起来）')
    return { problems, okLine: '' }
  }

  const t = /** @type {Record<string, number>} */ (counts)
  const total = (t.pass ?? 0) + (t.fail ?? 0) + (t.cancelled ?? 0) + (t.skipped ?? 0) + (t.todo ?? 0)
  if (t.tests !== total) {
    problems.push(
      '测试计数对不上：tests=' +
        t.tests +
        '，但 pass+fail+cancelled+skipped+todo=' +
        total +
        '（差额 ' +
        (t.tests - total) +
        ' 条没有结论）',
    )
  }
  if ((t.fail ?? 0) > 0) problems.push('测试有失败：' + t.fail + ' 条')
  if ((t.cancelled ?? 0) > 0) {
    problems.push('测试被取消：' + t.cancelled + ' 条（被取消的用例没有结论，不许算进通过 —— fail 0 也照样红）')
  }
  if ((t.todo ?? 0) > 0) problems.push('测试标了 todo：' + t.todo + ' 条（todo 不是通过）')
  if (cancelledByParent !== null && cancelledByParent > 0) {
    problems.push('出现 cancelledByParent ' + cancelledByParent + ' 条（老 Node 的静默丢弃通道：它们不出现在 fail 里）')
  }
  if (exitCode !== 0) problems.push('测试命令非零退出（exit ' + exitCode + '），即使汇总数字看着干净')

  const okLine =
    '测试：' +
    t.tests +
    ' / pass ' +
    t.pass +
    ' / fail ' +
    t.fail +
    ' / cancelled ' +
    t.cancelled +
    ' / skipped ' +
    t.skipped +
    ' / todo ' +
    t.todo
  return { problems, okLine }
}
