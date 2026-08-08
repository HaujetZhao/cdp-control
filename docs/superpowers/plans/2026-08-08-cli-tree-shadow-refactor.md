# CLI commander 重构 + tree 结构忠实度修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 tree 输出的三个结构忠实度问题(聚合文本标记 / 递归 shadow 穿透 / commander 重构 CLI),同步文档后 merge 回 main。

**Architecture:** 三块独立、可分阶段回测的改动:(1) `tree.ts`+`tree-format.ts` 给聚合文本加 `~` 标记;(2) `find-root.ts` 递归穿透 shadow;(3) `cdp.ts` 用 commander 重写 CLI、`cdp.js` 改为 dist 自包含 bundle、删除 parseArgs。

**Tech Stack:** TypeScript + esbuild + commander(v12)。Node ≥21。测试用 `node --test --experimental-strip-types`(零运行时依赖,直跑 `tests/*.test.ts`)。

**关键约定:**
- 注入侧 DOM 逻辑(tree 聚合标记、find-root 递归穿透)不写单测,靠**浏览器实测**(CDP 9222,页面 `bili` tab 还开着)。
- 纯函数(tree-format 聚合标记)写单测;find-root 的 `shadowContexts` 依赖全局 document,按 CLAUDE.md 不单测。
- commit 不带 `Co-Authored-By` 署名。
- 每次改完必须 `npm run build` 重建 dist 再回测。

---

## Task 1: 坑 1 —— tree 聚合文本加 `~` 标记

**Files:**
- Modify: `src/tree.ts`(simplify 置 `agg`)
- Modify: `src/inject/lib/tree-format.ts`(TreeNode 加 `agg`、输出 `~`)
- Test: `tests/tree-format.test.ts`(新增聚合标记断言)

- [ ] **Step 1: TreeNode 接口加 `agg` 可选字段**

`src/inject/lib/tree-format.ts` 第 10-13 行的 `TreeNode` 接口加 `agg?: boolean;`:

```ts
export interface TreeNode {
  tag: string; isContent: boolean; text: string; inter: boolean; imgAlt: string;
  kids: TreeNode[]; size: number; hasText: boolean; leafValue?: string;
  agg?: boolean;   // 新增:显示文本来自 innerText/grabText 兜底(聚合文本)而非直接文本节点
}
```

- [ ] **Step 2: `simplify` 标记聚合文本来源**

`src/tree.ts`:节点构造处(第 58-64 行)补 `agg: false`,并在第 70/71 行两个兜底分支置 `agg: true`。改动后相关段落:

```ts
    const node: TreeNode = {
      tag, isContent: !!text || (isEl && el.tagName === 'IMG') || inter,
      text, inter, imgAlt: isEl && el.tagName === 'IMG' ? (el.getAttribute('alt') || '') : '',
      kids: [], size: 0, hasText: false, agg: false,
    };
    ...
    if (!text && !node.kids.length) { text = strip(grabText(el, 0)).slice(0, 120); node.agg = true; }
    if (!text && (inter || (isEl && el.tagName === 'IMG')) && (el as HTMLElement).innerText) { text = strip((el as HTMLElement).innerText).slice(0, 80); node.agg = true; }
    node.text = text;
```

- [ ] **Step 3: `leafLabel` / `inlineLabel` 输出 `~` 前缀**

`src/inject/lib/tree-format.ts`:两个 label 函数里,凡输出**该节点自身**的引用文本时,若 `n.agg` 则前缀 `~`:

```ts
  const leafLabel = (n: TreeNode) => {
    let l = n.tag;
    if (n.tag === 'img' && n.imgAlt) l += ' "' + n.imgAlt.slice(0, 40) + '"';
    else if (n.text) l += ' "' + (n.agg ? '~' : '') + n.text.slice(0, 60) + '"';
    return l;
  };
  const inlineLabel = (n: TreeNode) => {
    if (n.tag === 'img' && n.imgAlt) return 'img "' + n.imgAlt.slice(0, 20) + '"';
    if (n.leafValue) { const v = firstTxt(n.kids); return '"' + n.leafValue + (v ? ' ' + v : '') + '"'; }
    return '"' + (n.agg ? '~' : '') + leafText(n).slice(0, 24) + '"';
  };
```

- [ ] **Step 4: 新增聚合标记单测**

`tests/tree-format.test.ts` 追加一个用例:

```ts
test('formatTree: 聚合文本节点(agg)输出 ~ 前缀,字面文本不加', () => {
  const agg = mk({ tag: 'a', isContent: true, text: '首页', inter: true, agg: true, size: 1 });
  const lit = mk({ tag: 'a', isContent: true, text: '下载', inter: true, size: 1 });
  const root = mk({ tag: 'nav', isContent: false, size: 3, kids: [agg, lit] });
  markText(root);
  assert.deepEqual(formatTree(root), ['nav', '  a ~"首页"', '  a "下载"']);
});
```

- [ ] **Step 5: 跑单测确认通过**

Run: `npm test`
Expected: 全部 PASS(含新增聚合标记用例;现有断言因 `agg` 未设不受影响)。

- [ ] **Step 6: 重建 + 浏览器回测**

Run: `npm run build` 后,`node dist/cdp.js tree --target bili | grep -n "首页"`
Expected: 导航 `a ~"首页"`(首页文本在子 span → 聚合 → 应显示 `~`);再 `--xpath "//*[contains(@class,'video-info')]"` 看视频信息区多为字面无 `~`。

- [ ] **Step 7: Commit**

```bash
git add src/tree.ts src/inject/lib/tree-format.ts tests/tree-format.test.ts
git commit -m "feat(tree): 聚合文本(innerText/grabText 兜底)加 ~ 标记,区分字面/聚合文本"
```

---

## Task 2: 坑 2 —— find-root 递归 shadow 穿透

**Files:**
- Modify: `src/inject/lib/find-root.ts`(`shadowContexts` / `xpathRoot`)

- [ ] **Step 1: `shadowContexts` 改为递归收集所有 shadowRoot(任意深度)**

`src/inject/lib/find-root.ts` 的 `shadowContexts` 从「document + 各 shadowRoot 顶层子元素」改为「document + 所有元素(任意深度)的 shadowRoot」,按 DFS 预序排列(宿主文档序在前)。替换实现:

```ts
/** 收集 shadow 穿透所需的求值上下文:document + 所有元素的 shadowRoot(递归,任意深度)。
 *  DFS 预序(宿主文档序在前)。xpath 相对路径 `//tag` 从每个 context 出发向下搜该层 light DOM;
 *  嵌套 shadow 各自成为独立 context,从而实现任意深度穿透。 */
export function shadowContexts(): (Document | ShadowRoot)[] {
  const ctxs: (Document | ShadowRoot)[] = [document];
  const seen = new Set<Node>([document]);
  const stack: Node[] = [document];
  while (stack.length) {
    const n = stack.pop()!;
    if (n instanceof Element && n.shadowRoot && !seen.has(n.shadowRoot)) { seen.add(n.shadowRoot); ctxs.push(n.shadowRoot); }
    if (n instanceof Element || n instanceof Document || n instanceof DocumentFragment)
      for (const c of Array.from(n.children)) if (!seen.has(c)) { seen.add(c); stack.push(c); }
  }
  return ctxs;
}
```

`xpathRoot` 保持「对每个 context 求 `FIRST_ORDERED_NODE_TYPE` 取首个非空命中」。`ShadowRoot` 是 `DocumentFragment`,可作为 `document.evaluate` 的 context;`xpathRoot` 的 `node.nodeType === 1` 判断兼容(命中的是 Element)。`findRoot` 返回与调用方不变。

- [ ] **Step 2: 重建 + 浏览器回测**

Run: `npm run build`,然后:
- `node dist/cdp.js tree --target bili --xpath "//bili-comment-renderer" | head -5`
  Expected: 首条为 `a "林韵子墨"`(文档序第一条,不再是最后一条 `bili_15248316234`)。
- `node dist/cdp.js tree --target bili --xpath "//bili-comments//bili-comment-renderer" | head -5`
  Expected: 也能命中(首条评论),不再报「未命中」。

- [ ] **Step 3: Commit**

```bash
git add src/inject/lib/find-root.ts
git commit -m "feat(find-root): xpath 递归穿透任意深度 shadow DOM,深层元素稳定取文档序首个命中"
```

---

## Task 3: 坑 3 —— commander 重构 CLI + dist 自包含 bundle

### Task 3a: 依赖与构建

**Files:**
- Modify: `package.json`(加 commander)
- Modify: `build.mjs`(cdp.js 单独 bundle)

- [ ] **Step 1: 装 commander**

Run: `npm install commander@^12`

- [ ] **Step 2: `build.mjs` 让 cdp.js 单独 bundle**

Node 侧从「全部转译不打包」改为「`src/cdp.ts` 单独 `bundle: true` 打成 `dist/cdp.js`(含 commander + 全部 src 模块,dist 自包含);其余 `src/*.ts` 仍转译保留」。替换 Node 侧段落:

```js
  // —— Node 侧:cdp.js 入口 bundle(commander + 全部 src 模块,自包含);其余模块转译保留 ——
  const nodeEntries = readdirSync(src).filter(f => f.endsWith('.ts') && f !== 'cdp.ts');
  if (nodeEntries.length) {
    console.log(`▶ Node 侧(转译):${nodeEntries.join(', ')} → dist/`);
    await build({
      entryPoints: nodeEntries.map(f => join(src, f)),
      outdir: dist, bundle: false, format: 'cjs', platform: 'node', target: 'node21', sourcemap: false,
    });
  }
  console.log('▶ Node 侧(入口 bundle): cdp.ts → dist/cdp.js');
  await build({
    entryPoints: [join(src, 'cdp.ts')],
    outfile: join(dist, 'cdp.js'),
    bundle: true, format: 'cjs', platform: 'node', target: 'node21', sourcemap: false,
    external: ['node:fs', 'node:path'],
    logLevel: 'info',
  });
```

- [ ] **Step 3: 空跑验证构建**

Run: `npm run build`
Expected: 通过,生成 `dist/cdp.js`(此时 cdp.ts 还没改 commander,旧逻辑仍 bundle 成功)。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json build.mjs
git commit -m "build: cdp.js 改为 dist 自包含 bundle(commander 打进单文件),其余模块转译保留"
```

### Task 3b: 重写 `src/cdp.ts` 为 commander

**Files:**
- Rewrite: `src/cdp.ts`

**关键设计:** `--target` 用 per-command option(每个需要 target 的命令各自 `.option('-t, --target')`),这样既支持既有写法 `tree --target bili`,又能在 action 里读 `opts.target`。`needTarget(opts.target)` 接收 action 里解析出的 target 值。

- [ ] **Step 1: 用 commander 重写整个 `src/cdp.ts`**

完整新文件(命令统一 kebab-case;`help`/`--help`/`-h` 交 commander;保留全部命令含 run/logs/listen):

```ts
/**
 * cdp.ts — 通过 CDP 控制本地浏览器的脚本入口(commander CLI)。
 * 编译产物为 dist/cdp.js(esbuild bundle,含 commander,dist 自包含)。
 * 运行 `node dist/cdp.js <子命令>`;require 本文件时导出 api。
 */
import { program } from 'commander';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { sleep } from './transport';
import { coreApi } from './api';
import { logs, cmdListen, daemonHealthy, LOGS_PORT, pidFilePath as joinPidPath } from './monitor';
import { ensureBrowser } from './browser';

const api = { ...coreApi, logs, ensure: ensureBrowser };

/** 读 --xpath-file/--selector-file 内容(去首尾空白)。 */
function readOptFile(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  try { return readFileSync(file, 'utf8').trim(); }
  catch (e: any) { throw new Error(`读取参数文件失败: ${file} — ${e.message}`); }
}

/** 带 target 的命令统一拿目标并打印提示。target 为该命令 option 解析出的值。 */
async function needTarget(target?: string): Promise<any> {
  const t = await api.resolve(target ?? undefined);
  console.error(`→ target: ${t.title || ''} ${t.url}`);
  return t;
}

/** 需要 target 的命令模板:给子命令挂 --target option。 */
function targetCmd(name: string, desc: string) {
  return program.command(name).description(desc).option('-t, --target <匹配>', '目标 tab(id/url/title 子串)');
}

// —— 不需要 target 的命令 ——
program
  .name('cdp')
  .version('1.0.0')
  .description('CDP 浏览器控制(取代 chrome-devtools MCP)');

program.command('ensure')
  .description('确保浏览器已通过 CDP 就绪(自动探测 Edge/Chrome),可选 --url 直接导航')
  .option('--url <url>', '打开指定网页')
  .action(async (opts) => {
    const r = await api.ensure(opts.url);
    const lines: string[] = [r.started ? '模式: 冷启动(本次由 ensure 启动浏览器)' : '模式: 热启动(浏览器本就已通过 CDP 就绪)', `浏览器: ${r.browser || '未知'}`];
    lines.push(r.userData ? `用户数据目录: ${r.userData}` : '用户数据目录: 未知(可设环境变量 CDP_USER_DATA 指定)');
    if (r.url) { lines.push(`已打开: ${r.url}`); lines.push(`targetId: ${r.targetId}`); }
    else lines.push('已连接: 未导航');
    console.log(lines.join('\n'));
  });

program.command('list').description('列出所有 page tab(含手动开的)')
  .action(async () => {
    const list = await api.list();
    if (list.length === 0) { console.log('(没有 page tab)'); return; }
    const line = (t: any) => `${t.id}  ${t.title || '(无标题)'}  ${t.url}`;
    console.log(list.map((t: any, i: number) => `${i + 1}. ${line(t)}`).join('\n'));
  });

program.command('open').argument('<url>', '要打开的网址').description('新开一个 tab')
  .action(async (url) => { const tid = await api.open(url || 'about:blank'); console.log(`已打开: ${url}\ntargetId: ${tid}`); });

program.command('close').argument('<target>', '目标匹配').description('关闭 tab')
  .action(async (tgt) => { const t = await api.resolve(tgt); await api.close(t); console.log(`已关闭: ${t.title || t.url}`); });

program.command('listen').description('启动/前台运行控制台监听 daemon')
  .action(async () => { await cmdListen(); });

program.command('listen-stop').description('停止控制台监听 daemon')
  .action(async () => {
    try { await fetch(`http://127.0.0.1:${LOGS_PORT}/shutdown`, { method: 'POST' }); } catch {}
    let stopped = false; const t0 = Date.now();
    while (Date.now() - t0 < 3000) { if (!(await daemonHealthy(LOGS_PORT))) { stopped = true; break; } await sleep(200); }
    if (!stopped) { const pf = joinPidPath(); if (existsSync(pf)) { const pid = Number(readFileSync(pf, 'utf8')); try { process.kill(pid); stopped = true; } catch {} try { unlinkSync(pf); } catch {} } }
    console.log(stopped ? '已停止监听 daemon' : '未发现运行中的监听 daemon');
  });

program.command('run').argument('<file>', '脚本文件').description('执行自动化脚本(脚本里用全局 cdp API,可顶层 await)')
  .action(async (file) => {
    const abs = pathResolve(file); const code = readFileSync(abs, 'utf8');
    (globalThis as any).cdp = api;
    const BUILTIN_ALLOW = new Set(['os', 'path', 'fs', 'child_process', 'crypto', 'util', 'stream', 'url']);
    const safeRequire = (id: string): any => { if (BUILTIN_ALLOW.has(id)) return require(id); throw new Error(`脚本不可 require '${id}',仅允许 Node 内建: ${[...BUILTIN_ALLOW].join('/')}`); };
    const fn = new Function('cdp', 'require', `return (async () => {\n${code}\n})();`);
    await fn(api, safeRequire);
  });

// —— 需要 target 的命令(每个挂 --target option,action 末参为 opts,含 opts.target) ——
targetCmd('navigate', '导航到 url').argument('<url>', '网址')
  .action(async (url, opts) => { await api.navigate(await needTarget(opts.target), url); console.log(`已导航到: ${url}`); });

targetCmd('eval', '在页面执行 JS,返回 JSON 值').argument('<js...>', '要执行的 JS')
  .action(async (js, opts) => { const code = (js as string[]).join(' '); console.log(JSON.stringify(await api.eval(await needTarget(opts.target), code), null, 2)); });

targetCmd('snapshot', '提取可交互元素清单(标签/文本/选择器/坐标)')
  .action(async (opts) => { const v = await api.snapshot(await needTarget(opts.target)); if (!Array.isArray(v) || !v.length) { console.log('(没有可交互元素)'); return; } console.log(v.map((e: any, i: number) => `${i + 1}. [${e.tag}] "${e.text || e.placeholder || ''}"  ${e.href || ''}  sel=${e.selector}`).join('\n')); });

targetCmd('tree', '结构树:整页 body 的文本+结构紧凑层级树(可选 --selector/--xpath 只建指定区域)')
  .option('--selector <sel>', 'CSS 选择器')
  .option('--selector-file <file>', '从文件读 selector')
  .option('--xpath <xp>', 'XPath(shadow 穿透,任意深度)')
  .option('--xpath-file <file>', '从文件读 xpath')
  .action(async (opts) => {
    const sel = opts.selector ?? readOptFile(opts['selector-file']);
    const xp = opts.xpath ?? readOptFile(opts['xpath-file']);
    const r = await api.tree(await needTarget(opts.target), { selector: sel, xpath: xp });
    if (!r.lines?.length) { console.log('(空树)'); return; }
    console.log(r.lines.join('\n'));
  });

targetCmd('click', '点击元素').argument('<selector>', 'selector')
  .action(async (sel, opts) => { const r = await api.click(await needTarget(opts.target), sel); console.log(`已点击: ${sel} (${r.tag})`); });

targetCmd('fill', '填输入框并触发 input/change').argument('<selector>', 'selector').argument('<value>', '值')
  .action(async (sel, val, opts) => { await api.fill(await needTarget(opts.target), sel, val); console.log(`已填入: ${sel} ← ${val}`); });

targetCmd('focus', '聚焦元素').argument('<selector>', 'selector')
  .action(async (sel, opts) => { const r = await api.focus(await needTarget(opts.target), sel); console.log(`已聚焦: ${sel} (${r.tag})`); });

targetCmd('get-focus', '查看当前焦点元素在哪')
  .action(async (opts) => { const f = await api.getFocus(await needTarget(opts.target)); if (!f) { console.log('(当前无焦点元素)'); return; } console.log(`焦点在: [${f.tag}] "${f.text || ''}" ${f.id ? '#' + f.id : ''} sel=${f.selector}`); });

targetCmd('press-key', '按键/组合键,如 Enter、Ctrl+Shift+A、Tab').argument('<key>', '按键')
  .action(async (key, opts) => { await api.pressKey(await needTarget(opts.target), key); console.log(`已按键: ${key}`); });

targetCmd('hover', '鼠标移到元素上').argument('<selector>', 'selector')
  .action(async (sel, opts) => { await api.hover(await needTarget(opts.target), sel); console.log(`已悬停: ${sel}`); });

targetCmd('outline', '页面大纲:标题层级 + 关键链接')
  .action(async (opts) => { const o = await api.outline(await needTarget(opts.target)); console.log(`标题: ${o.title}\nURL: ${o.url}\n`); console.log('— 标题层级 —'); console.log(o.headings.map((h: any) => '  '.repeat(Math.max(0, h.level - 1)) + `H${h.level}: ${h.text}  sel=${h.selector}`).join('\n') || '(无标题)'); console.log('\n— 关键链接 —'); console.log(o.links.map((l: any, i: number) => `${i + 1}. ${l.text}  ${l.href}`).join('\n') || '(无)'); });

targetCmd('content', '提取主内容文本(去导航/页脚)')
  .action(async (opts) => { const c = await api.content(await needTarget(opts.target)); console.log(`标题: ${c.title}\nURL: ${c.url}\n`); console.log(c.text || '(无正文)'); });

targetCmd('shot', '截图').option('-f, --file <file>', '输出文件')
  .action(async (opts) => { const file = await api.shot(await needTarget(opts.target), opts.file); console.log(`已截图: ${file}`); });

targetCmd('logs', '读 target 控制台日志(常驻 daemon,支持过滤)')
  .option('--level <level>', '过滤级别,如 error,warn')
  .option('--since <ms>', '仅最近 N 毫秒,单位毫秒')
  .option('--json', 'JSON 输出')
  .action(async (opts) => {
    const t = await needTarget(opts.target); const entries = await api.logs(t, { level: opts.level, since: opts.since });
    if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return; }
    if (!entries.length) { console.log(`(无控制台日志 · ${t.title || t.url})`); return; }
    console.log(`→ ${t.title} ${t.url}`);
    for (const e of entries) { const ts = new Date(e.ts).toTimeString().slice(0, 8); const loc = (e.line != null) ? ` (${e.line}:${e.col ?? ''})` : ''; const argsText = (e.args || []).map((a: any) => a == null ? 'undefined' : (typeof a === 'string' ? a : JSON.stringify(a))).join(' '); console.log(`[${ts}][${e.level}] ${argsText}${loc}`); }
  });

program.parseAsync(process.argv).catch((err: any) => { console.error(`错误: ${err.message}`); process.exit(1); });

export = api;
```

> 注意:`export = api` 保留「require 本文件得 api」契约。CLI 分发交给 `program.parseAsync`(bundle 后 `require.main === module` 判断不可靠,故不用它,而是无条件 parse)。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 无 TS 错误(commander 类型解析正常)。

- [ ] **Step 3: 重建 + CLI 冒烟**

Run: `npm run build`,然后:
- `node dist/cdp.js help` → 显示用法
- `node dist/cdp.js tree --help` → 显示 tree 命令帮助(修复坑 3 根源)
- `node dist/cdp.js list` → 列出 tab
- `node dist/cdp.js tree --target bili --xpath "//h1"` → 视频标题
- `node dist/cdp.js get-focus --target bili` / `node dist/cdp.js press-key Tab --target bili` → kebab-case 命令可用
Expected: 全部正常;`--help` 正确显示每命令帮助。

- [ ] **Step 4: Commit**

```bash
git add src/cdp.ts
git commit -m "refactor(cli): 用 commander 重构 CLI,命令统一 kebab-case,--target 全局化,--help 逐命令生效"
```

### Task 3c: 删除 parseArgs 及相关单测

**Files:**
- Delete: `src/cli-args.ts`
- Delete: `tests/cli-args.test.ts`

- [ ] **Step 1: 删除两文件**

```bash
git rm src/cli-args.ts tests/cli-args.test.ts
```

- [ ] **Step 2: 全量测试 + 构建**

Run: `npm test` 与 `npm run build`
Expected: 其余测试 PASS;构建成功。

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: 移除被 commander 取代的 parseArgs 与其单测"
```

---

## Task 4: 同步文档

**Files:**
- Modify: `SKILL.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新 `SKILL.md`**

1. 命令名改 kebab-case:`get_focus→get-focus`、`press_key→press-key`(全文,含命令表格与示例)。
2. `--help`/`-h` 说明:每命令支持 `--help` 看自身用法。
3. tree 聚合文本标记:引用文本前缀 `~` 表示聚合文本(来自 innerText/grabText 兜底,反查须用 `contains(.,'…')` 而非 `text()`)。
4. xpath 穿透说明:改为「递归穿透任意深度 shadow DOM,深层元素稳定取文档序首个命中」。
5. 构建交付:注明 `dist/cdp.js` 为自包含 bundle(拷走 dist 即可运行,无需 npm install)。

- [ ] **Step 2: 更新 `CLAUDE.md`**

1. 构建段:Node 侧说明改为「`src/cdp.ts` 单独 bundle(commander + 全部 src 模块)→ dist/cdp.js;其余 src/*.ts 转译」,加 commander 依赖说明。
2. 测试段:删除「cli-args(parseArgs)」覆盖项。
3. 注入契约/返回契约不变。

- [ ] **Step 3: Commit**

```bash
git add SKILL.md CLAUDE.md
git commit -m "docs: 同步 SKILL.md/CLAUDE.md 的命令名、--help、聚合标记、xpath 穿透与构建说明"
```

---

## Task 5: 回归 + merge

- [ ] **Step 1: 全量回归**

Run: `npm run build` 与 `npm test`
Expected: 构建通过、全部测试 PASS。

- [ ] **Step 2: 最终浏览器冒烟(三块修复一起验)**

Run:
- `node dist/cdp.js tree --target bili | grep "首页"` → 出现 `a ~"首页"`(坑1)
- `node dist/cdp.js tree --target bili --xpath "//bili-comment-renderer" | head -4` → 首条 `林韵子墨`(坑2)
- `node dist/cdp.js tree --help` → 显示帮助(坑3)

- [ ] **Step 3: merge 回 main**

```bash
git checkout main
git merge refactor/cli-tree-shadow
```

- [ ] **Step 4: 确认合并干净**

Run: `git log --oneline -1`
Expected: main 指向合并提交;无冲突。
