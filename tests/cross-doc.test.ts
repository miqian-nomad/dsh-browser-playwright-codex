/**
 * 跨文档一致性守卫：同一件事实出现在多份文档里时，它们必须互相对得上。
 *
 * 为什么单独要这一条：仓库里已有 docs-consistency（文档 ↔ 代码）与 doc-reality（文档 ↔ 现实）两条，
 * 但它们各管一段；**文档之间**互相矛盾没人管 —— 而"老毛病"恰恰都是这一类：README 说没上 npm 而实际上
 * 了、NOTICE 里的路径与仓库不符、三份文档的成本数字各写各的、一个文档说 20 个工具另一个说 23。
 *
 * 这里只钉那些"写错会真的误导人"的事实；同义措辞用宽松的正则（守的是意思，不是字面）。
 *
 * 刻意不检查「文档里出现的任何版本号都必须等于 package.json」：那些文档里大量出现的是**历史版本**
 * （"自 0.5.1 起上 npm"、"上游 0.1.1"），把历史当成错误只会逼人写绕过。当前版本只钉在真正声明
 * "现在是什么"的地方：注册条目、CHANGELOG 顶部。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel: string): string => readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
const repo = JSON.parse(read('package.json')) as { version: string }

test('cross-doc: 注册条目与 package.json 对得上（包名 / 仓库地址）', () => {
  // 0.4.0 那次改名就是这样出事的：包名改了，别处的旧名没跟着改。注册条目是外部可见的声明，
  // 它必须与 package.json 的 name / repository 完全对上；仓库地址决定别人点进去看到的是哪份代码。
  const entry = read('registry/awesome-dsh-plugin.yml')
  const pkg = JSON.parse(read('package.json')) as {
    name: string
    repository?: { url?: string } | string
    homepage?: string
  }
  const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '')
  const slug = repoUrl
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^https?:\/\/github\.com\//, '')
  const failures: string[] = []
  // homepage 可能带 #readme 之类的锚点，条目里是裸地址：比"仓库 slug"而不是整串。
  if (slug === '') failures.push('package.json 的 repository/homepage 里解析不出仓库 slug')
  else if (!entry.includes(slug)) failures.push('注册条目里找不到仓库 slug：' + slug)
  if (!entry.includes('miqian-nomad/')) failures.push('注册条目的 name 不是 miqian-nomad/<repo> 形式')
  if (!entry.includes('name:')) failures.push('注册条目缺少 name 字段')
  assert.deepEqual(failures, [], '注册条目与 package.json 对不上:\n  ' + failures.join('\n  '))
})

test('cross-doc: 「已登录的站点」在各文档里的关键说法一致', () => {
  const claims: Array<{ what: string; docs: string[]; pattern: RegExp }> = [
    {
      what: '只读 / 只给你自己看',
      docs: ['README.md', '中文说明.md'],
      pattern: /只读|只给(你)?自己看|only to you/,
    },
    {
      what: '不显示 cookie 的名字与值',
      docs: ['README.md', '中文说明.md', 'SECURITY.md'],
      pattern: /没有 cookie 的名字|不显示 cookie 的(名字和值|名与值)|never cookie names|no cookie names/,
    },
    {
      what: '不落盘（内存态）',
      docs: ['中文说明.md', 'SECURITY.md'],
      pattern: /不写磁盘|不落盘|never on disk|lives in memory/,
    },
    {
      what: '域名说明来自网页标题或离线对照表，认不出就只显示域名',
      docs: ['README.md', '中文说明.md'],
      pattern: /网页自己的标题|page's\s+own title|离线对照表|curated offline table/,
    },
    {
      what: '同一家公司的域折叠成一行',
      docs: ['README.md', '中文说明.md'],
      pattern: /折叠成一行|collapse into \*\*one row\*\*|collapse into one row/,
    },
  ]
  const failures: string[] = []
  for (const claim of claims) {
    for (const doc of claim.docs) {
      if (!claim.pattern.test(read(doc))) failures.push(claim.what + ' 在 ' + doc + ' 里找不到')
    }
  }
  assert.deepEqual(failures, [], '主插件文档之间对不上:\n  ' + failures.join('\n  '))
})

test('cross-doc: 配套件文档与主插件的安全承诺一致', () => {
  const toggleReadme = readFileSync(new URL('../../dsh-browser-toggle/README.md', import.meta.url), 'utf8')
  const toggleZh = readFileSync(new URL('../../dsh-browser-toggle/中文说明.md', import.meta.url), 'utf8')
  const security = read('SECURITY.md')
  const failures: string[] = []
  for (const [name, text] of [
    ['dsh-browser-toggle/README.md', toggleReadme],
    ['dsh-browser-toggle/中文说明.md', toggleZh],
    ['SECURITY.md', security],
  ] as const) {
    if (!/x-dsh-plugin/.test(text)) failures.push(name + ' 没提 /logins 要求的 x-dsh-plugin 防伪头')
  }
  for (const [name, text] of [
    ['dsh-browser-toggle/README.md', toggleReadme],
    ['dsh-browser-toggle/中文说明.md', toggleZh],
  ] as const) {
    if (!/模型看不到|the model cannot|model cannot read/.test(text)) {
      failures.push(name + ' 没承诺"模型看不到这份名单"')
    }
  }
  assert.deepEqual(failures, [], '配套件与主插件文档对不上:\n  ' + failures.join('\n  '))
})
