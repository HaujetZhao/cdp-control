# prune 功能设计（按 ref 删减整页 view 区域）

日期：2026-08-08
分支：`feat/prune`
作者：Haujet + Claude

## 背景与动机

agent 用 `view` 感知整页时，长页（如知乎问题页）会有大量无关区域（导航头、推荐卡片、广告）混入，355 个 ref 里大部分是噪声。现有手段：
- 完整 `view` 输出太长，agent 被迫 `head/sed` 截断（违反铁律）。
- `view --ref <n> --ancestor <k>` 可局部看，但 ref 是会话句柄、跨树漂移，且"找回答区父容器"要反复试 `--ancestor`，脆弱。

目标是给 agent 一个**会话级"删减区域"**能力：看过整页后，把不需要的区域按 ref 删掉，之后的整页 `view` 不再输出它们，从而**整页 view 就是干净的**，无需再筛选。

## 决策（已与用户确认）

1. **持久化方式：会话内存元素集合**。prune 把 ref 解析成真实 DOM 元素，存进页面全局 `window.__cdpPrune`（`Set`）。会话内有效；页面刷新清空（元素重建，与 `__cdpRefs` 同生命周期）。
2. **命令形态：独立 `prune` 命令**，一次登记、后续每次整页 `view` 自动生效。
3. **被排除区域：彻底消失**，不保留 `[已排除]` 占位。

## CLI 界面

- `cdp prune <ref1,ref2,...> [--target]` — 解析 ref 为元素，登记进 `__cdpPrune`。
- `cdp prune --clear [--target]` — 清空排除集合。
- `cdp prune`（无参，`[--target]`）— 列出当前已排除区域（每个元素的文本摘要）。
- ref 取自最近一次整页 `view`；跨树编号漂移不影响（存元素而非编号）。

## 注入侧实现

### 新文件 `src/inject/lib/prune.ts`

```ts
// 会话级排除区域集合(元素 Set)。与 __cdpRefs 同生命周期,页面刷新清空。
export type PruneStore = { el: Element; summary: string };
export function registerPrune(refs: number[]): PruneStore[]; // refElement 解析,过滤无效
export function clearPrune(): void;
export function listPrune(): PruneStore[];   // 返回 {el, summary} 摘要
export function pruneSet(): Set<Element> | null; // buildView 读取用
```

`refElement` 复用 `lib/find-root.ts`。注册时抓元素的文本摘要（`grabText`/`ownText` 截断），供 `prune` 无参列出与 `--clear` 前后对比。

### 新注入入口 `src/inject/prune.ts`

`ViewArgs` 之外新增 `PruneArgs { refs?: number[]; clear?: boolean; list?: boolean }`（放 `lib/arg.ts`）。按子命令分支：登记 / 清空 / 列出，`setResult` 返回结构化结果。

### `buildView`（lib/view-core.ts）改造

`simplify` 递归携带 `prunedAncestor` 布尔：进入子节点时若当前元素在 `pruneSet()` 内，则**该分支直接返回空节点、不再下探**（整棵子树消失，也不为其后代登记 ref）。

```ts
function simplify(el, depth, prunedAncestor) {
  const isEl = el instanceof Element;
  const selfPruned = prunedAncestor || (isEl && pruneSet()?.has(el));
  // ... 不输出 selfPruned 的节点:return 一个空占位节点,不含 ref/text/kids
  for (const k of childrenOf(el)) node.kids.push(simplify(k, depth+1, selfPruned));
}
```

被排除元素自身及其后代都不输出、不登记 ref；祖先链（含 root 本身）若被排除则整树空。

### 防御

- 排除导致整树空：`view` 返回 `{ok:true, lines:[]}`，CLI 摘要提示"已排除 N 项，本次整页 view 为空"。
- `prune` 登记时 ref 无效（失效/越界）：跳过该项，汇总报告"跳过 N 个无效 ref"。

## Node 侧实现

- `src/inject-loader.ts`：新增 `pruneExpr`（拼 `__CDP_ARG__`）。
- `src/api.ts`：`prune(target, opts)` 方法，`invoke` 统一走注入入口。
- CLI（`src/cli.ts` / commander）：`prune` 子命令，`--clear` 标志。
- 脚本 API：`cdp.prune(target, {refs} | {clear:true} | undefined)` → `{ok, pruned:[...摘要]}`。

## 文档

- `SKILL.md`：加 `prune` 命令到 Quick Reference + 一段用法（"整页 view 去噪"）。
- `CLAUDE.md`：注入契约加 prune 说明。

## 测试

- `lib/prune.ts` 纯函数（register 过滤无效 ref、clear、list）可单测。
- `buildView` 的跳过逻辑依赖真实 DOM → 浏览器实测：zhihu 问题页 prune 导航头后整页 view 不再含头部。

## 边界与取舍

- 不落盘、不做跨刷新持久化（用户确认选会话内存，最简）。
- 不保留占位（用户确认彻底消失）。
- 排除的是元素子树；若要"排除但留子节点"不做（YAGNI）。
