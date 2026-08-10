# article 命令 + 展示格式优化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 本计划由主会话内联执行（工作紧密耦合 view-core，全量上下文已在会话中）。

**Goal:** 新增 `article <ref>` 命令（保序不截断的 Markdown 文章），并优化 view 展示：无文本图标按钮 aria 兜底、view 图例、ref 两遍先序编号。

**Architecture:** ① view-core `buildView` 改为两遍（遍一建树+打标记、遍二先序登记 ref），号随树位置单调增；② 新增 `elLabel` 共享辅助（aria→title→直接文本）供 view-core 与 article 用；③ article 用专用保序 DOM 遍历发 Markdown（不截断）；④ view 顶层打印加 `#` 图例。

**Tech Stack:** TypeScript / esbuild（注入入口自动打包）/ node:test。

---

## 任务总览

| Task | 内容 | 文件 |
|---|---|---|
| 1 | 两遍先序 ref 重构 | `view-core.ts`, `view-format.ts` |
| 2 | 图标按钮 aria 兜底（elLabel） | `view-core.ts` |
| 3 | article 命令 | `article.ts`, `arg.ts`, `inject-loader.ts`, `api.ts`, `cdp.ts` |
| 4 | view 图例 | `cdp.ts` |

每任务构建+单测回归后提交。

---

### Task 1：view-core 两遍先序 ref 重构

**Files:**
- Modify: `src/inject/lib/view-format.ts`（ViewNode 接口加 `el/wantRef/wantHidden` 可选字段）
- Modify: `src/inject/lib/view-core.ts`（`buildView` 改两遍；`ViewBuildOpts` 不变）

**Step 1：`view-format.ts` ViewNode 接口加三个可选字段**

在 `ViewNode` 接口（`src/inject/lib/view-format.ts` 第 10-22 行）末尾追加：

```ts
  el?: Element;     // 建树时暂存真实 DOM 元素(遍二登记 ref 用);格式化忽略
  wantRef?: boolean;   // 遍一标记:内容/交互/折叠/shadow 宿主,遍二分配并打印 [ref=N]
  wantHidden?: boolean; // 遍一标记:纯包装含内容,遍二分配但不打印(隐藏容器,info 反查可用)
```

**Step 2：重写 `buildView` 为两遍**

把 `src/inject/lib/view-core.ts` 的 `buildView`（81-183 行）整体替换为：

```ts
/** 从 root 建精简树。opts.visibleOnly:建视图后按视口可见裁剪(沿用 view --visible-only 语义);
 * opts.viewport:对带 ref 的节点算 node.view(输出 [ref=i, visible] 标记),见 lib/view-format.ts。
 * ref 两遍先序:遍一建树+打标记(wantRef/wantHidden)+暂存 el;遍二先序 DFS 一次性分配 ref,
 * 号随树位置单调增(parentRef = 最近已登记祖先)。只追加、不重置——重置由调用方决定(view 入口整页前重置)。 */
export function buildView(root: Element | ShadowRoot, opts: ViewBuildOpts = {}): ViewNode {
  const visibleOnly = !!opts.visibleOnly;
  const viewport = !!opts.viewport;
  const folds: FoldItem[] = [...(opts.folds || []), ...tmpFolds()];
  const foldNote = (el: Element): string | null => {
    for (const f of folds) { try { if (el.matches(f.selector)) return f.note || f.selector; } catch {} }
    return null;
  };
  const subtreeHasContent = (n: ViewNode): boolean => n.isContent || n.kids.some(subtreeHasContent);

  // —— 遍一:建树 + 打标记 + 暂存 el。不登记 __cdpRefs ——
  function simplify(el: Element | ShadowRoot, depth: number): ViewNode | null {
    const isEl = el instanceof Element;
    if (isEl && depth > 0) {
      const note = foldNote(el as Element);
      if (note !== null) {
        const e = el as Element;
        return {
          tag: e.tagName.toLowerCase(), isContent: true, text: '', inter: false, ref: undefined,
          wantRef: true, el: e, inView: true, view: viewport ? isInViewport(e) : undefined,
          imgAlt: '', shadow: !!e.shadowRoot, kids: [], size: 1, hasText: false, agg: false, fold: note,
        };
      }
    }
    const tag = isEl ? el.tagName?.toLowerCase() || 'frag' : 'frag';
    const inter = isEl ? interactive(el as Element) : false;
    const title = isEl ? (el.getAttribute('title') || '') : '';
    let text = isEl ? ownText(el as Element) : '';
    const inView = visibleOnly && isEl ? isInView(el as Element) : true;
    const hasShadow = isEl && inView && !!(el as Element).shadowRoot;
    const node: ViewNode = {
      tag,
      isContent: !!text || (isEl && el.tagName === 'IMG') || inter || hasShadow,
      text, inter, ref: undefined, inView, view: viewport ? isInViewport(el as Element) : undefined,
      wantRef: isEl && inView && (inter || !!text || hasShadow) ? true : undefined,
      el: isEl ? el as Element : undefined,
      imgAlt: isEl && el.tagName === 'IMG' ? (el.getAttribute('alt') || '') : '',
      inputInfo: isEl && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
        ? {
            type: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text') : undefined,
            value: ((el as any).value || '').slice(0, 40),
            placeholder: el.getAttribute('placeholder') || undefined,
          }
        : undefined,
      shadow: hasShadow,
      kids: [], size: 0, hasText: false, agg: false,
    };
    for (const k of childrenOf(el as Element)) {
      const kt = k instanceof Element ? k.tagName.toUpperCase() : '';
      if (DROP.has(kt)) continue;
      const kn = simplify(k, depth + 1);
      if (kn) node.kids.push(kn);
    }
    if (!text && !node.kids.length) { text = strip(grabText(el, 0)).slice(0, 120); node.agg = true; }
    if (!text && inter) {
      const label = elLabel(el as Element);
      if (label) { text = strip(label); node.agg = true; }
      else { text = strip(grabText(el, 0)).slice(0, 80); node.agg = true; }
    } else if (!text && isEl && el.tagName === 'IMG') {
      text = strip(grabText(el, 0)).slice(0, 80); node.agg = true;
    }
    node.text = text;
    node.isContent = !!text || (isEl && el.tagName === 'IMG') || inter || hasShadow;
    node.size = 1 + node.kids.reduce((a, k) => a + k.size, 0);
    if (!text && title && !node.kids.some(k => k.text) && node.size <= 8 && (el as Element).tagName !== 'SVG' && (el as Element).tagName !== 'path' && (el as Element).tagName !== 'USE') {
      node.leafValue = strip(title).slice(0, 40);
      node.isContent = true;
    }
    if (isEl && inView && ref == null && !inter && !text && !hasShadow && !node.inputInfo
        && node.kids.length > 0 && subtreeHasContent(node)) {
      node.wantHidden = true;
      node.hidden = true;
    }
    return node;
  }

  // —— 遍二:先序 DFS 分配 ref + parentRef。wantRef→打印 ref;wantHidden→登记但不打印 ——
  function assign(n: ViewNode, parentRef: number | null): void {
    let childParent = parentRef;
    if (n.wantRef && n.el) {
      n.ref = (globalThis as any).__cdpRefs.length;
      (globalThis as any).__cdpRefs.push({ el: n.el, parentRef });
      childParent = n.ref;
    } else if (n.wantHidden && n.el) {
      (globalThis as any).__cdpRefs.push({ el: n.el, parentRef });
    }
    for (const k of n.kids) assign(k, childParent);
  }

  let v = simplify(root, 0);
  if (!v) v = { tag: 'body', isContent: false, text: '', inter: false, ref: undefined, inView: true, view: false, imgAlt: '', shadow: false, kids: [], size: 0, hasText: false, agg: false };
  assign(v, null);
  if (visibleOnly) { v.kids = v.kids.filter(k => prune(k)); }
  return v;
}
```

> 注意：`node` 里 `ref: undefined` 显式给；`assign` 只对 `wantRef` 写 `n.ref`，`wantHidden` 不写（保持 `node.ref` undefined，formatView 不打印隐藏容器）。`elLabel` 在 Task 2 定义，先建占位。

**Step 3：加 `elLabel` 占位（Task 2 实现）**

在 `view-core.ts` 顶部导出区加临时导出（避免 Task 1 编译失败）：

```ts
/** 交互元素的语义标签:aria-label → title → 直接文本,供无文本图标按钮兜底(view 显示 / article 降级)。 */
export const elLabel = (el: Element): string => {
  const aria = el.getAttribute && el.getAttribute('aria-label');
  if (aria) return aria;
  const t = el.getAttribute && el.getAttribute('title');
  if (t) return t;
  return ownText(el);
};
```

**Step 4：构建 + 单测回归**

```bash
npm run build && npm test
```
预期：build 通过；`view-format`/`view-utils`/`find-root` 等既有单测全绿（未改其纯逻辑）。

**Step 5：提交**

```bash
git add src/inject/lib/view-core.ts src/inject/lib/view-format.ts
git commit -m "refactor(view): buildView 两遍先序登记 ref,编号随树位置单调增"
```

---

### Task 2：图标按钮 aria/title 兜底（elLabel）

**Files:**
- Modify: `src/inject/lib/view-core.ts`（`elLabel` 已是 Task 1 Step 3 的正式实现；确认 `simplify` 的 `inter` 无文本分支走它）

Task 1 的 `simplify` 已把 `if (!text && inter)` 分支改成先 `elLabel`。本任务只需：
- [ ] **Step 1**：确认 Task 1 Step 3 的 `elLabel` 实现（aria→title→ownText）已在 `view-core.ts`，且被 `simplify` 引用。无额外改动。
- [ ] **Step 2**：构建 + 单测回归：`npm run build && npm test`。
- [ ] **Step 3**：提交（如 Task 1 已含此改动则跳过，不单独提交）。

---

### Task 3：article 命令

**Files:**
- Create: `src/inject/article.ts`（保序 DOM 遍历发 Markdown）
- Modify: `src/inject/lib/arg.ts`（`ArticleArgs`）
- Modify: `src/inject-loader.ts`（`articleExpr`）
- Modify: `src/api.ts`（`article` 方法）
- Modify: `src/cdp.ts`（`article` 子命令）

**Step 1：`arg.ts` 加 `ArticleArgs`**

在 `src/inject/lib/arg.ts` 末尾追加：

```ts
/** article:按 ref 提取子树为格式友好的 Markdown 文章(保序、不截断)。ancestor 可选按 ref 定位后爬父。 */
export interface ArticleArgs { ref: number; ancestor?: number }
```

**Step 2：新建 `src/inject/article.ts`**

```ts
/**
 * article.ts — 文章提取注入入口:以 ref 元素为根,沿 childNodes 保序递归遍历,
 * 按 tag 语义发成格式友好的 Markdown(不截断,穿透 shadow)。专用遍历而非复用 buildView,
 * 因为 buildView 把内联子元素(<a>/<b>)拆成独立子节点、丢失句子内位置。
 */
import { setResult } from './lib/result';
import { refElement, climbAncestors } from './lib/find-root';
import { notFoundResult, type OperableArg } from './lib/find';
import { childrenOf, elLabel } from './lib/view-core';
import type { ArticleArgs } from './lib/arg';

declare const __CDP_ARG__: ArticleArgs;

/** 跳过不进入文章内容的标签。 */
const NOISE = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'SVG', 'PATH', 'USE', 'SOURCE', 'PICTURE', 'IFRAME']);
/** 段落块标签:进入后开始一个新段落。 */
const PARA_TAGS = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'LI']);
/** 内联语义标签(不加换行/空行)。 */
const INLINE_STRONG = new Set(['B', 'STRONG']);

/** 取元素直接文本(穿透不进子元素),供链接/图片等用 own 文本。 */
function ownTextOf(el: Element): string {
  const parts: string[] = [];
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) parts.push(n.nodeValue);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

interface MdCtx { atLineStart: boolean }

/** 追加文本,若在上一个块末尾则先补换行。 */
function block(md: string[], ctx: MdCtx, text: string): void {
  if (!ctx.atLineStart && md.length && md[md.length - 1] !== '') md.push('');
  md.push(text);
  ctx.atLineStart = true;
}
function inline(md: string[], s: string): void {
  if (!s) return;
  if (ctxLineStart(md)) { /* 行首已有内容由调用方控制 */ }
  md.push(s);
}
function ctxLineStart(_md: string[]): boolean { return false; }

/** 遍历一个元素的子节点(保序),把文本/元素按其语义 append 到 md。 */
function walkChildren(el: Element, md: string[], ctx: MdCtx): void {
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3) { // 文本节点
      const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (t) md.push(t);
    } else if (n.nodeType === 1) {
      walkEl(n as Element, md, ctx);
    }
  }
}

function walkEl(el: Element, md: string[], ctx: MdCtx): void {
  const tag = el.tagName;
  if (NOISE.has(tag)) return;
  if (tag === 'BR') { md.push('  '); return; }
  if (tag === 'HR') { block(md, ctx, '---'); return; }
  if (/^H[1-6]$/.test(tag)) {
    const lvl = Number(tag[1]);
    const t = ownTextOf(el);
    block(md, ctx, '#'.repeat(lvl) + ' ' + t);
    return;
  }
  if (tag === 'P' || PARA_TAGS.has(tag)) {
    // 段落:收集子内容,空段落跳过
    const sub: string[] = [];
    walkChildren(el, sub, ctx);
    const t = sub.join('').replace(/\s+/g, ' ').trim();
    if (t) block(md, ctx, t);
    return;
  }
  if (tag === 'A') {
    const t = ownTextOf(el) || '';
    const href = el.getAttribute('href') || '';
    md.push(href ? `[${t}](${href})` : t);
    return;
  }
  if (tag === 'IMG') {
    const alt = el.getAttribute('alt') || '';
    const src = el.getAttribute('src') || '';
    md.push(alt || src ? `![${alt}](${src})` : '');
    return;
  }
  if (tag === 'UL' || tag === 'OL') {
    md.push('');
    let i = 1;
    for (const li of Array.from(el.children)) {
      if (li.tagName !== 'LI') continue;
      const sub: string[] = [];
      walkChildren(li as Element, sub, ctx);
      const t = sub.join('').replace(/\s+/g, ' ').trim();
      const marker = tag === 'OL' ? `${i++}.` : '-';
      md.push(`${marker} ${t}`);
      // 嵌套列表:li 内若有 ul/ol,递归(简化:缩进 2 空格)
      for (const c of Array.from(li.children)) {
        if (c.tagName === 'UL' || c.tagName === 'OL') walkEl(c as Element, md, ctx);
      }
    }
    ctx.atLineStart = true;
    return;
  }
  if (tag === 'BLOCKQUOTE') {
    const sub: string[] = [];
    walkChildren(el, sub, ctx);
    const t = sub.join('').replace(/\s+/g, ' ').trim();
    if (t) block(md, ctx, '> ' + t);
    return;
  }
  if (tag === 'PRE' || tag === 'CODE') {
    const t = (el.textContent || '').replace(/\s+$/g, '');
    if (t) block(md, ctx, '```\n' + t + '\n```');
    return;
  }
  if (INLINE_STRONG.has(tag)) {
    const t = ownTextOf(el);
    md.push(t ? `**${t}**` : '');
    return;
  }
  if (tag === 'EM' || tag === 'I') {
    const t = ownTextOf(el);
    md.push(t ? `*${t}*` : '');
    return;
  }
  if (tag === 'CODE') {
    const t = (el.textContent || '').trim();
    md.push(t ? '`' + t + '`' : '');
    return;
  }
  if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    const label = elLabel(el);
    if (label && label !== ownTextOf(el)) md.push(`[${label}]`);
    return;
  }
  // 其它标签(含 DIV/SPAN/SECTION 等):下钻子内容,不加边界
  walkChildren(el, md, ctx);
}

(() => {
  const base = refElement(__CDP_ARG__.ref);
  if (!base) return setResult(notFoundResult({ ref: __CDP_ARG__.ref } as OperableArg));
  const el = climbAncestors(base, __CDP_ARG__.ancestor || 0);
  if (!el) return setResult({ ok: false, err: `ref=${__CDP_ARG__.ref} 向上爬 ${__CDP_ARG__.ancestor || 0} 层后无元素` });
  const md: string[] = [];
  const ctx: MdCtx = { atLineStart: true };
  walkChildren(el, md, ctx);
  const text = md.join('').replace(/\n{3,}/g, '\n\n').trim();
  return setResult({ ok: true, markdown: text, lines: text.split('\n') });
})();
```

> 说明：`inline`/`ctxLineStart` 是占位遗留，可删。真实块拼接靠 `block()` 在块间补空行；行内文本直接 `md.push`，块边界由 `block` 管理。列表/引用/代码的嵌套做简化处理，够用即可（YAGNI）。

**Step 3：`inject-loader.ts` 加 `articleExpr`**

在 `src/inject-loader.ts` 末尾追加：

```ts
/** article:按 ref 提取子树为 Markdown 文章(保序、不截断)。 */
export function articleExpr(ref: number, ancestor?: number): string {
  return inject('article', { ref, ancestor });
}
```

**Step 4：`api.ts` 加 `article` 方法**

在 `src/api.ts`（`info` 方法后）追加：

```ts
/** article:按 view 的 ref 提取子树为格式友好的 Markdown 文章(保序、不截断)。ancestor 可选向上爬父。 */
export async function article(target: Target, ref: number, ancestor?: number): Promise<any> {
  return invoke(target, articleExpr(ref, ancestor));
}
```

**Step 5：`cdp.ts` 加 `article` 子命令**

在 `src/cdp.ts`（`info` 命令后）追加：

```ts
targetCmd('article', '以 ref 为根提取格式友好的 Markdown 文章(保序、不截断;穿透 shadow)')
  .argument('<n>', 'view 输出的 ref 序号(穿透 shadow)')
  .option('--ancestor <k>', '按 ref 定位后向上爬 K 层父级再提取(默认 0)')
  .action(async (n, opts) => {
    const r = await api.article(await needTarget(opts.target), Number(n), opts.ancestor != null ? Number(opts.ancestor) : undefined);
    if (r?.refInvalid) { printRefInvalid(r); return; }
    if (!r?.lines?.length) { console.log('(空文章)'); return; }
    console.log(r.lines.join('\n'));
  });
```

**Step 6：构建 + 单测回归**

```bash
npm run build && npm test
```
预期：`dist/inject/article.js` 自动打包出现；既有单测全绿。

**Step 7：提交**

```bash
git add src/inject/article.ts src/inject/lib/arg.ts src/inject-loader.ts src/api.ts src/cdp.ts
git commit -m "feat(article): 新增 article 命令——ref 提取保序不截断的 Markdown 文章"
```

---

### Task 4：view 图例

**Files:**
- Modify: `src/cdp.ts`（view action 打印前加图例）

**Step 1：加图例常量 + view 打印前输出**

在 `src/cdp.ts` 顶部（`readOptFile` 附近）加：

```ts
/** view 输出顶部图例(解释各标记,Agent 易跳过、不误当内容)。 */
const VIEW_LEGEND = '# [ref=i]=可操作索引 · [ref=i,visible]=当前视口内 · ~"…"=聚合文本 · ▸=已折叠(view <ref> 展开) · [shadow]=shadow DOM';
```

在 `view` 命令 action（第 112 行 `console.log(r.lines.join('\n'));`）前改为：

```ts
    if (!r.lines?.length) { console.log('(空树)'); return; }
    console.log(VIEW_LEGEND + '\n' + r.lines.join('\n'));
```

**Step 2：构建 + 单测回归**

```bash
npm run build && npm test
```

**Step 3：提交**

```bash
git add src/cdp.ts
git commit -m "feat(view): 输出顶部加 # 图例,解释 ref/visible/~聚合/折叠/shadow 标记"
```

---

### Task 5：构建 + 单测 + 浏览器实测

- [ ] **Step 1**：`npm run build && npm test` 全绿。
- [ ] **Step 2**：浏览器实测（CDP，target = 知乎问答页）：
  - `view`：顶部出现 `#` 图例；无文本图标按钮（点赞/分享）显示 aria 兜底；`info <某内容 ref>` 祖先链 ref 随深度递减、有序（html 低位）。
  - `article <回答正文 ref>`：输出保序 Markdown，链接 `[文本](href)`、不截断；对比之前 view 被撕碎的句子现在完整。
  - 回归：`click`/`fill` 等 ref 操作仍正常（自愈 parentRef 链正确）。

### Task 6：更新文档

- [ ] `SKILL.md`：补 `article` 命令条目、图例说明、aria 兜底说明。
- [ ] `CLAUDE.md`：补 `article.ts`（保序 DOM 遍历）、两遍先序 buildView、`elLabel`。
- [ ] 提交并 merge 到 main：`git checkout main && git merge --no-ff feat/article-and-ref-order`。
