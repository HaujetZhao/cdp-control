# prune 功能实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 agent 一个会话级「按 ref 删减整页 tree 区域」的 `prune` 命令：看过整页后删掉噪声区域，之后的整页 `tree` 不再输出它们。

**Architecture:** 排除区域以「真实 DOM 元素」存进页面全局 `window.__cdpPrune`（`Set`），`buildTree` 在建树时遇到集合内元素即整棵子树跳过（返回 null、不登记 ref）。Node 侧新增 `prune` 命令走注入入口 `src/inject/prune.ts`，复用 `lib/find-root.ts` 的 `refElement` 把 ref 解析成元素。会话级、页面刷新清空，与 `__cdpRefs` 同生命周期。

**Tech Stack:** TypeScript / esbuild（注入脚本 IIFE）/ commander CLI / node:test 零依赖单测。

**设计文档:** `docs/superpowers/specs/2026-08-08-prune-feature-design.md`

**构建/测试命令:**
- 类型检查+打包: `npm run build`（tsc --noEmit + esbuild 产出 `dist/`）
- 单测: `npm test`（node:test 跑 `tests/*.test.ts`）
- 新增注入入口 `src/inject/prune.ts` 会被 build.mjs 自动打包成 `dist/inject/prune.js`，无需手动改构建脚本。

**现有接线模式（务必照抄）:**
- 注入入口: `src/inject/*.ts` 顶层文件，用 `setResult(...)` + `declare const __CDP_ARG__`（类型在 `lib/arg.ts`）。
- 参数装配: `src/inject-loader.ts` 里 `inject(name, args)` 拼 `var __CDP_ARG__ = <json>;`。每个注入入口一个 `xxxExpr()` 导出。
- API: `src/api.ts` 用 `invoke(target, expr)` 统一执行（`{ok:false}` 自动抛异常）。
- CLI: `src/cdp.ts` 用 `targetCmd(name, desc)` 模板挂 `--target` option，action 末参为 opts。

---

### Task 1: `lib/prune.ts`（会话级排除集合）

**Files:**
- Create: `src/inject/lib/prune.ts`
- Test: `tests/prune.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// tests/prune.test.ts
/**
 * prune.ts — 会话级排除区域集合单测。registerPrune/clearPrune/listPrune 只依赖
 * __cdpRefs(全局数组)与元素对象属性,用假对象即可单测(与 find-root.test.ts 同手法)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerPrune, clearPrune, listPrune, pruneSet } from '../src/inject/lib/prune.ts';

function makeEl(tag: string, text?: string) {
  return { tagName: tag, nodeType: 1, textContent: text || '', parentElement: null, children: [] as any[] };
}

test('registerPrune: 按 ref 登记元素入 __cdpPrune', () => {
  const a = makeEl('div', '头部导航'), b = makeEl('section', '推荐卡片');
  (globalThis as any).__cdpRefs = [a, b];
  const r = registerPrune([0, 1]);
  assert.equal(r.skipped, 0);
  assert.equal(r.pruned.length, 2);
  assert.equal(r.pruned[0].el, a);
  assert.equal(r.pruned[1].el, b);
  assert.equal(r.pruned[0].summary, '头部导航');
  assert.equal(pruneSet()!.size, 2);
  (globalThis as any).__cdpPrune = undefined;
});

test('registerPrune: 无效 ref 跳过并计数', () => {
  (globalThis as any).__cdpRefs = [makeEl('div')];
  const r = registerPrune([0, 5, -1]);
  assert.equal(r.pruned.length, 1);
  assert.equal(r.skipped, 2);
  (globalThis as any).__cdpPrune = undefined;
});

test('registerPrune: 重复登记去重(Set)', () => {
  const a = makeEl('div', 'x');
  (globalThis as any).__cdpRefs = [a];
  registerPrune([0]); registerPrune([0]);
  assert.equal(pruneSet()!.size, 1);
  (globalThis as any).__cdpPrune = undefined;
});

test('clearPrune: 清空集合', () => {
  (globalThis as any).__cdpRefs = [makeEl('div', 'x')];
  registerPrune([0]);
  clearPrune();
  assert.equal(pruneSet()!.size, 0);
});

test('listPrune: 未登记返回空数组;登记后返回摘要', () => {
  clearPrune();
  assert.deepEqual(listPrune(), []);
  const a = makeEl('header', '导航栏');
  (globalThis as any).__cdpRefs = [a];
  registerPrune([0]);
  const l = listPrune();
  assert.equal(l.length, 1);
  assert.equal(l[0].summary, '导航栏');
  (globalThis as any).__cdpPrune = undefined;
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test 2>&1 | grep -A3 "prune"` 
Expected: FAIL，报「Cannot find module '../src/inject/lib/prune'」或函数未定义。

- [ ] **Step 3: 实现 `src/inject/lib/prune.ts`**

```ts
/**
 * prune.ts — 会话级排除区域集合(按 ref 删减整页 tree 区域)。
 * 把 agent 不想要的长页区域(导航/推荐/广告)的「真实 DOM 元素」存进页面全局 __cdpPrune(Set)。
 * buildTree 遇到集合内元素即整棵子树跳过 → 之后的整页 tree 不再输出,无需筛选。
 * 生命周期:与 __cdpRefs 一致,页面刷新(新 document)自动清空。
 */
import { refElement } from './find-root';

export interface PruneEntry { el: Element; summary: string }

/** 排除区域集合(不存在返回 null)。buildTree 读取用。 */
export function pruneSet(): Set<Element> | null {
  return (globalThis as any).__cdpPrune ?? null;
}

function ensureSet(): Set<Element> {
  if (!(globalThis as any).__cdpPrune) (globalThis as any).__cdpPrune = new Set();
  return (globalThis as any).__cdpPrune;
}

function summaryOf(el: Element): string {
  const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
  return (t || el.tagName).slice(0, 40);
}

/** 按 ref 逐个解析为元素并登记进排除集合;无效 ref 跳过。返回登记摘要 + 跳过数。 */
export function registerPrune(refs: number[]): { pruned: PruneEntry[]; skipped: number } {
  const set = ensureSet();
  const pruned: PruneEntry[] = [];
  let skipped = 0;
  for (const r of refs) {
    const el = refElement(r);
    if (!el) { skipped++; continue; }
    if (!set.has(el)) set.add(el);
    pruned.push({ el, summary: summaryOf(el) });
  }
  return { pruned, skipped };
}

/** 清空排除集合。 */
export function clearPrune(): void {
  (globalThis as any).__cdpPrune = new Set();
}

/** 列出当前已排除区域摘要(不含 el 序列化,供 CLI/agent 回顾)。 */
export function listPrune(): PruneEntry[] {
  const set = pruneSet();
  if (!set) return [];
  return [...set].map(el => ({ el, summary: summaryOf(el) }));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test 2>&1 | tail -20`
Expected: PASS，`tests/prune.test.ts` 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/inject/lib/prune.ts tests/prune.test.ts
git commit -m "feat(prune): 会话级排除区域集合 lib/prune.ts(register/clear/list/pruneSet)"
```

---

### Task 2: `buildTree` 跳过被排除子树

**Files:**
- Modify: `src/inject/lib/tree-core.ts`
- Test: 无单测（依赖真实 DOM，走浏览器实测 Task 7）。本任务只改代码。

- [ ] **Step 1: 改造 `simplify` 支持排除跳过**

把 `simplify` 返回值改为 `TreeNode | null`，在建树开始时读一次排除集合，元素命中即返回 null（整棵子树消失、不再下探、不登记 ref）；子节点循环跳过 null；顶层处理 null 根。

在 `src/inject/lib/tree-core.ts` 中，`import` 增加 `import { pruneSet } from './prune';`，并把 `buildTree` 内改动如下：

```ts
export function buildTree(root: Element | ShadowRoot, opts: TreeBuildOpts = {}): TreeNode {
  const visibleOnly = !!opts.visibleOnly;
  const viewport = !!opts.viewport;
  const exclude = pruneSet(); // 会话级排除集合,命中的元素整棵子树跳过

  function simplify(el: Element | ShadowRoot, depth: number): TreeNode | null {
    const isEl = el instanceof Element;
    if (isEl && exclude && exclude.has(el as Element)) return null; // 整棵子树消失(不输出、不登记 ref)
    const tag = isEl ? el.tagName?.toLowerCase() || 'frag' : 'frag';
    // ……(其余与现在一致,不改动)……
    for (const k of childrenOf(el as Element)) {
      const kt = k instanceof Element ? k.tagName.toUpperCase() : '';
      if (DROP.has(kt)) continue;
      const kn = simplify(k, depth + 1);
      if (kn) node.kids.push(kn);   // 跳过被排除的 null
    }
    // ……(其余与现在一致)……
    return node;
  }

  let tree = simplify(root, 0);
  if (!tree) tree = { tag: 'body', isContent: false, text: '', inter: false, ref: undefined, inView: true, view: false, imgAlt: '', shadow: false, kids: [], size: 0, hasText: false, agg: false };
  if (visibleOnly) { tree.kids = tree.kids.filter(k => prune(k)); }
  return tree;
}
```

**注意：** 原 `simplify` 里 `ref` 通过 `(globalThis as any).__cdpRefs` 追加——被排除元素已提前 return，故其下不追加 ref，满足「不登记 ref」。原 `isContent`/`shadow`/`leafValue` 等字段赋值逻辑全部保留，仅函数签名、排除早退、`kids.push` 判空三处改动。

- [ ] **Step 2: 类型检查**

Run: `npm run build 2>&1 | tail -20`
Expected: tsc --noEmit 无错误，esbuild 打包成功。

- [ ] **Step 3: 提交**

```bash
git add src/inject/lib/tree-core.ts
git commit -m "feat(prune): buildTree 遇到被排除元素整棵子树跳过"
```

---

### Task 3: 注入入口 `src/inject/prune.ts` + `PruneArgs`

**Files:**
- Create: `src/inject/prune.ts`
- Modify: `src/inject/lib/arg.ts`

- [ ] **Step 1: `arg.ts` 加 `PruneArgs`**

在 `src/inject/lib/arg.ts` 末尾追加：

```ts
/** prune:按 ref 登记排除区域(会话级),或清空(--clear)/列出(--list)。 */
export interface PruneArgs { refs?: number[]; clear?: boolean; list?: boolean }
```

- [ ] **Step 2: 新建注入入口 `src/inject/prune.ts`**

```ts
/**
 * prune.ts — prune 注入入口(按 ref 删减整页 tree 区域)。
 * 把 agent 不要的区域的 ref 解析成元素登记进 __cdpPrune;之后的整页 tree 不再输出。
 * 契约:读取 __CDP_ARG__(refs 数组 / clear / list),结果写 setResult。
 * 同步入口,footer await 原样通过。
 */
import { setResult } from './lib/result';
import { registerPrune, clearPrune, listPrune } from './lib/prune';
import type { PruneArgs } from './lib/arg';

declare const __CDP_ARG__: PruneArgs;

setResult((() => {
  if (__CDP_ARG__.clear) {
    clearPrune();
    return { ok: true, cleared: true };
  }
  if (__CDP_ARG__.list) {
    return { ok: true, pruned: listPrune().map(p => p.summary) };
  }
  const { pruned, skipped } = registerPrune(__CDP_ARG__.refs || []);
  return { ok: true, pruned: pruned.map(p => p.summary), skipped };
})());
```

- [ ] **Step 3: 类型检查 + 确认被打包成 `dist/inject/prune.js`**

Run: `npm run build 2>&1 | tail -20 && ls dist/inject/ | grep prune`
Expected: 类型无错；`dist/inject/prune.js` 存在。

- [ ] **Step 4: 提交**

```bash
git add src/inject/prune.ts src/inject/lib/arg.ts
git commit -m "feat(prune): 注入入口 prune.ts(登记/清空/列出) + PruneArgs"
```

---

### Task 4: Node 侧接线（inject-loader + api）

**Files:**
- Modify: `src/inject-loader.ts`
- Modify: `src/api.ts`

- [ ] **Step 1: `inject-loader.ts` 加 `pruneExpr`**

在 `src/inject-loader.ts` 末尾（`readExpr` 之后）追加：

```ts
/** prune:按 ref 登记排除区域(会话级);clear 清空;list 列出。 */
export function pruneExpr(refs: number[] | undefined, clear: boolean, list: boolean): string {
  return inject('prune', { refs, clear: clear || undefined, list: list || undefined });
}
```

- [ ] **Step 2: `api.ts` 加 `prune` 方法**

在 `src/api.ts` 的 `import { inject, treeExpr, locateExpr } from './inject-loader';` 改为 `import { inject, treeExpr, locateExpr, pruneExpr } from './inject-loader';`，并在 `tree`/`locate` 方法附近追加：

```ts
export interface PruneOpts { refs?: number[]; clear?: boolean }
/** 会话级排除区域:把 ref 解析成元素登记,之后的整页 tree 不再输出这些元素子树。
 * 无 refs 且非 clear 时列出已排除区域。 */
export async function prune(target: Target, opts: PruneOpts = {}): Promise<any> {
  const list = !opts.refs?.length && !opts.clear;
  return invoke(target, pruneExpr(opts.refs, !!opts.clear, list));
}
```

- [ ] **Step 3: 类型检查**

Run: `npm run build 2>&1 | tail -20`
Expected: 类型无错。

- [ ] **Step 4: 提交**

```bash
git add src/inject-loader.ts src/api.ts
git commit -m "feat(prune): Node 侧 pruneExpr + api.prune"
```

---

### Task 5: CLI 命令

**Files:**
- Modify: `src/cdp.ts`

- [ ] **Step 1: 注册 `prune` 子命令**

在 `src/cdp.ts` 的 `locate` 命令定义之后追加：

```ts
targetCmd('prune', '按 ref 登记排除区域,之后的整页 tree 不再输出这些元素子树(会话级);无参列出已排除,--clear 清空')
  .argument('[refs...]', 'tree 输出的 ref 序号(可逗号/空格分隔多个)')
  .option('--clear', '清空排除集合')
  .action(async (refs, opts) => {
    const t = await needTarget(opts.target);
    const numRefs = (refs || []).flatMap((s: string) => s.split(',')).filter((s: string) => s !== '').map(Number);
    const r = await api.prune(t, { refs: numRefs, clear: !!opts.clear });
    if (r.clear) { console.log('已清空排除集合'); return; }
    if (!r.pruned?.length && !r.skipped) { console.log('当前未排除任何区域(用 prune <ref> 登记,之后整页 tree 不再输出)'); return; }
    if (r.pruned?.length) console.log(`已排除 ${r.pruned.length} 个区域:`);
    (r.pruned || []).forEach((s: string) => console.log(`  · ${s}`));
    if (r.skipped) console.log(`跳过 ${r.skipped} 个无效 ref`);
  });
```

- [ ] **Step 2: 类型检查 + CLI 帮助可读**

Run: `npm run build 2>&1 | tail -20 && node "C:/Users/Haujet/.claude/skills/cdp-browser-control/dist/cdp.js" prune --help`
Expected: 类型无错；`prune` 帮助含「[refs...]」与「--clear」。

- [ ] **Step 3: 提交**

```bash
git add src/cdp.ts
git commit -m "feat(prune): CLI prune 子命令(登记/清空/列出)"
```

---

### Task 6: 全量构建 + 单测通过

**Files:**
- （无新文件，验证产物）

- [ ] **Step 1: 全量构建 + 单测**

Run: `npm run build && npm test 2>&1 | tail -25`
Expected: tsc 无错；`tests/*.test.ts` 全绿（含新增 prune.test.ts）。

- [ ] **Step 2: 记录结果**

在回复中确认：build 通过、测试 N 个全绿、`dist/inject/prune.js` 已生成。

---

### Task 7: 浏览器实测（zhihu 问题页去噪）

**Files:**
- （运行验证，不改代码；结果作为 SKILL/CLAUDE 文档依据）

- [ ] **Step 1: 用 CDP 实测**

用 CDP（端口 9222，已开）。在一个长内容 tab（如之前的知乎问题页 `D246E49E72EA69F0DB203B2BF6D17C8A`，若已关则重新 `open`）上：

```bash
node ".../dist/cdp.js" tree --target <tab>               # 整页,拿到导航头等噪声区域 ref
node ".../dist/cdp.js" prune <导航头ref> --target <tab>   # 登记排除
node ".../dist/cdp.js" tree --target <tab>                # 整页,确认噪声区域不再出现
node ".../dist/cdp.js" prune --target <tab>               # 列出已排除区域
node ".../dist/cdp.js" prune --clear --target <tab>       # 清空
node ".../dist/cdp.js" tree --target <tab>                # 确认排除区域恢复出现
```

Expected: 登记排除后整页 tree 不再含该区域；`--clear` 后恢复；`prune` 无参正确列出摘要。

- [ ] **Step 2: 记录实测结论**

记录：是否按预期跳过、被排除元素的 ref 是否不再登记、clear 是否生效。任何偏差记录为 bug 回到对应 Task 修。

---

### Task 8: 更新文档（SKILL.md + CLAUDE.md）

**Files:**
- Modify: `SKILL.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: `SKILL.md` Quick Reference 加 prune**

在 `SKILL.md` 的子命令表 `locate` 行后加：

```
| `prune <refs...> [--target] [--clear]` | 按 ref 登记排除区域(会话级),之后的整页 tree 不再输出这些元素子树;无参列出已排除,--clear 清空 |
```

并在「区域定位」小节补一段「整页 tree 去噪」用法：看过整页后，把导航头/推荐/广告等噪声区域的 ref 用 `prune` 删掉，之后整页 tree 即干净，无需再 `--selector-file`/`--ref` 筛选。

- [ ] **Step 2: `CLAUDE.md` 注入契约加 prune 说明**

在「注入脚本契约」或 ref 登记表小节补：`__cdpPrune` 会话级排除元素集合，与 `__cdpRefs` 同生命周期（刷新清空）；`buildTree` 遇到集合内元素整棵子树跳过、不登记其下 ref；注入入口 `src/inject/prune.ts`。

- [ ] **Step 3: 提交**

```bash
git add SKILL.md CLAUDE.md
git commit -m "docs: prune 命令(整页 tree 去噪)接入 SKILL.md + CLAUDE.md"
```

---

### Task 9: 收尾 —— 确认全绿后 merge 到 main

**Files:**
- （无）

- [ ] **Step 1: 最终验证**

Run: `npm test 2>&1 | tail -15`
Expected: 全绿。

- [ ] **Step 2: 合并到 main（保留分叉，--no-ff）**

```bash
git checkout main
git merge --no-ff feat/prune -m "merge(feat): 会话级 prune 按 ref 删减整页 tree 区域"
```

Expected: main 出现 merge commit，`--no-ff` 保留分叉线。

- [ ] **Step 3: 清理**

删除已完成的分支：
```bash
git branch -d feat/prune
```
Expected: 分支删除成功（已 merge）。
