# 设计：操作后自动反馈（含 tab 变化）+ tree 可见性标签

日期：2026-08-08
状态：待实现（新上下文按此实现）

## 背景 / 动机

多轮子代理实测暴露两个交互缺口：

1. **操作后不知道页面变了什么**：点"显示评论"后新增了内容、点赞后数字变了，agent 不知道，得额外多轮去 `tree` 复看。
2. **点链接新开 tab 后不知道开了哪个**：很多站卡片是 `target=_blank`，点完原 tab 的 `location` 没变，agent 得额外 `list` 才能确认落点。

**目标**：一次操作命令，返回「页面新增内容 tree + tab 变化摘要」，让 agent 一轮拿到结果，不再需要主动 `tree`/`list` 补查。

另外：tree 增加"在视区可见"标记，让 agent 知道目标元素在不在屏上、要不要先滚动。

---

## 一、tree 可见性标签（A）

- 给 tree 里带 ref 的节点加"在视区"标记，只标记**可见的小部分**（token 开销小）。
- 格式：在视区可见 → `[ref=53·屏]`；否则 → `[ref=53]`。
- 用途：agent 看到 `[ref=N]` 未标 `·屏`，就知道它不在当前屏幕、要先 `tree --scroll-to-load` 或滚动后再操作（很多懒加载内容只有滚动到才出现/才可操作）。
- 实现：
  - `TreeNode` 加 `view?: boolean`（见 `lib/tree-format.ts`）。
  - 建树时若开 viewport 标记，对带 ref 的节点算一个**便宜的** `isInViewport(el)`：仅 `getBoundingClientRect` 与视口相交 + 宽高>0，**不查 getComputedStyle**（省开销）。存进 `node.view`。
  - `formatTree` 的 `refTag`：`node.view === true ? ' [ref='+n.ref+'·屏]' : ' [ref='+n.ref+']'`。
  - 独立于 visible-only（visible-only 的裁剪仍用更严格的 `isInView` + prune，不相干）。

## 二、ref 语义澄清（B）

- 现状（**确认不改**）：每次 `tree` 清空 `window.__cdpRefs` 从 0 重建；局部 `tree --ref X --ancestor k` 出来的 ref 是 0、1、2…，**会顶掉打开页面时的全局 ref**。
- 文档讲清即可：局部 tree 后想再按全局 ref 操作，需重新整页 tree。反馈树也是独立的（ref 从 0 重排），agent 用反馈树里的 ref 操作新增内容。

## 三、建树 core 抽取（前置重构）

反馈要复用 tree 的建树，须把 tree.ts 的 DOM 采集逻辑抽成共享模块。

- 新建 `src/inject/lib/tree-core.ts`，把 tree.ts 里的 `DROP / strip / ownText / grabText / childrenOf / interactive / isInView / isInViewport / prune / simplify` 抽进去。
- 导出：
  ```ts
  export interface TreeBuildOpts { visibleOnly?: boolean; viewport?: boolean }
  export function buildTree(root: Element | ShadowRoot, opts?: TreeBuildOpts): TreeNode
  ```
  - `viewport: true` → 对带 ref 的节点算 `node.view`（见 A）。
  - `visibleOnly: true` → 建树后 prune（沿用现有语义）。
- `tree.ts` 改成：`buildTree(root, { visibleOnly, viewport: true })` + `markText` + `formatTree`。
- `lib/tree-format.ts`：`TreeNode` 加 `view?: boolean`；`refTag` 渲染 `·屏`。

## 四、操作后自动反馈（C+D，核心）

### 4.1 触发与开关

- **默认开启**，作用于所有操作命令：`click` / `fill` / `focus` / `hover` / `press-key`（含滚动，如 PageDown）。
- 操作后**等 ~1s** 让异步内容（评论区/懒加载）出现。
- 加 `--no-feedback` 关闭（个别高频率操作不想等 1s 时用）。

### 4.2 内容反馈（注入侧，MutationObserver）

- 注入脚本里：装 `MutationObserver`（childList + characterData + attributes）→ 执行动作 → `await sleep(1000)` → 断开 → 收集**新增内容块**。
- "新增内容块"= 本次操作期间 `addedNodes` 中、没有元素祖先也在本次新增集合里的**顶层新增元素**。
- **tree 全部新增内容块**（用户选定）：对每个顶层新增元素 `formatTree(buildTree(el, {viewport:true}))`，拼接。跳过错过的空/纯属性变化（characterData/attributes 只进摘要）。
- 摘要：`新增 N 个内容块` + 值得注意的文本变化（如点赞数字 `41 → 42`）。

### 4.3 tab 变化（Node 侧，CDP /json/list）

- **操作前**记录 tab 列表（`list()`，含 targetId/title/url）。
- 操作 + 等待之后**再次 list**，diff：
  - `opened`：本次新出现的 tab（新开的，含 title/url/targetId）。
  - `closed`：本次消失的 tab。
- 目的：agent 点完链接直接知道"新开了哪个 tab、开了什么页"，可直接去 `tree --target <新tab>`，不必先 `list`。

### 4.4 组合返回（统一结构）

```js
{
  ok: true,
  tag: "div",                // 动作结果(如 click 的 tag)
  feedback: {
    lines: [ ... ],          // 新增内容块的 tree 行(可空)
    summary: "新增 3 个内容块; 点赞 41→42",   // 简摘要
    tabs: { opened: [{id,title,url}], closed: [{id,title,url}] }
  }
}
```

- CLI 打印：先动作结果，再换行打印 `lines`，再打印 `summary` 与 `tabs` 变化。
- 脚本 API：返回上述对象，agent 直接读。
- `--no-feedback` 时：`feedback` 为 `null`，动作结果照旧（不等待、不观察、不 diff tab）。

### 4.5 异步注入

沿用已支持的 async 注入契约：`build.mjs` footer 已是 `;(async()=>{const r=await globalThis.__cdpResult;...})()`，`Runtime.evaluate` 开了 `awaitPromise`。动作入口把整段包成 `setResult((async()=>{...})())`，内部 `await sleep(1000)` 后 setResult。

---

## 五、实现文件清单

| 文件 | 改动 |
|---|---|
| `src/inject/lib/tree-core.ts` | 新：从 tree.ts 抽 buildTree + isInViewport |
| `src/inject/lib/tree-format.ts` | TreeNode 加 `view`；refTag 渲染 `·屏` |
| `src/inject/lib/feedback.ts` | 新：装/收 MutationObserver + 新增内容 tree + 摘要 |
| `src/inject/tree.ts` | 改用 tree-core + viewport 标记 |
| `src/inject/click.ts` `fill.ts` `focus.ts` `hover.ts` | 用 feedback 包裹，async + setResult(promise)，读 `__CDP_ARG__.noFeedback` |
| `src/api.ts` | click/fill/focus/hover/pressKey 外层加 tab 快照+diff+合并 feedback；opts 加 noFeedback |
| `src/cdp.ts` | refOpt 命令 + press-key 加 `--no-feedback`；打印 feedback |
| `src/inject-loader.ts` / `lib/arg.ts` | 参数透传（noFeedback / feedback 相关） |
| `SKILL.md` / `CLAUDE.md` | 文档：可见性标签、操作反馈、tab 变化、ref 语义 |

## 六、测试与验收

- 单测（纯逻辑）：`tree-format` 的 `·屏` 渲染（view 分支）；新增内容 tree 拼接（若抽成纯函数）。
- 浏览器验收：
  1. `tree` 整页：在视口的 ref 带 `·屏`。
  2. 知乎 `click` 显示评论 → 等 1s 自动 tree 出新增评论 + 摘要。
  3. `click` 点开新 tab 的链接 → feedback.tabs.opened 含新 tab（title/url），agent 直接去操作。
  4. `press-key` 滚动 → 反馈懒加载内容。
  5. `--no-feedback` 关闭，动作照旧不等待。
  6. 回归：普通 tree/click/logs 在 async footer 下正常。

## 七、注意 / 风险

- 每个操作命令默认 +1s 等待 + 反馈输出，会变慢、输出变大——这是用户选定"默认全开"的取舍；`--no-feedback` 兜底。
- 无限流页面滚动可能触发大量新增 → feedback 全部新增可能很大；必要时可加上限（先不做，留到实测超限再说）。
- tab diff 在 Node 层做，操作命令的注入（浏览器）只负责内容反馈，两层各自独立、由 api 层合并。
