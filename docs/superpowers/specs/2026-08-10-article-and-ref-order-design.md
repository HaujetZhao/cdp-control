# article 命令 + 展示格式优化 设计文档

日期：2026-08-10
状态：已批准（用户授权全权实现）

## 背景

`view` 的紧凑树对**人**友好，但对**服务 Agent 读正文**有几个结构性短板：正文被内联链接撕碎、布局 div 噪声压过内容、截断不一致且正文被腰斩、无文本图标按钮匿名、标记无图例、ref 编号不随树位置单调。

本设计解决五项：新增 `article` 命令（Markdown、不截断）、无文本图标按钮 aria/title 兜底、view 图例、ref 两遍先序编号。

## 目标

1. `article <ref>`：以 ref 为根，输出格式友好的 Markdown 文章，**不截断**。
2. 无文本图标按钮：`aria-label → title → grabText` 兜底，view 与 article 一致。
3. view 顶部 `#` 图例行，解释各标记。
4. ref 编号随树位置单调增（两遍先序），`info` 链有序。
5. 实现放新分支，分阶段提交，最后 merge 到 main。

## 非目标

- 不重构 `view` 的树形输出本身（内联链接回行等留待后续）。
- 不做自动"导航/广告"识别器——article 靠 ref 圈定正文根，跳过无语义纯包装与无 aria 的交互元素即可。
- 不保留向后兼容、不写 migration、不加 fallback（遵循项目激进重构原则）。

## 架构

### article：`src/inject/article.ts`（专用保序 DOM 遍历）

- **不用 buildView**：`buildView` 的 simplify 把元素自身直接文本合并成 blob、内联子元素（`<a>`/`<b>`）拆成独立子节点，**丢失内联顺序**（`<p>前 <a>链</a> 后</p>` 变 `前后`+链接），对文章致命。故用**专用 DOM 遍历**，直接沿 `childNodes` 保序走，忠实还原内联位置。
- 递归遍历 `refElement` 子树，按 tag 语义发 Markdown；Text 节点与子元素天然保序。穿透 shadow（复用 `childrenOf`）。
- 新 CLI 子命令 `article <ref>`，Node 侧 `api.article(target, {ref})`，走统一 `invoke`。
- 入口用 `setResult` + `__CDP_ARG__`（新增 `ArticleArgs{ref, ancestor?}`）。
- 无截断：直接读完整文本，不做任何 `slice`。

#### Markdown 映射

| DOM/节点 | 输出 |
|---|---|
| `h1..h6` | `#..######` |
| `p`/纯文本容器 | 段落（空行分隔） |
| `a` | `[ownText](href)` |
| `img` | `![alt](src)`（alt/src 兜底） |
| `ul`/`ol` | `-` / `1.`（嵌套缩进） |
| `blockquote` | `> ` 前缀 |
| `pre`/`code` | ``` 代码块 |
| 交互元素（无语义文本） | 有 `aria-label/title` → `[按钮: label]`；否则跳过 |
| 纯包装层（无文本/无交互） | 不输出，但下钻子树 |
| `DROP` 集 | 跳过 |

穿透 shadow（复用 `childrenOf`）。链接文本用 own 文本（非子树聚合，避免最外层容器命中全量文本）。

### #3 图标按钮：`view-core.ts` 兜底顺序

`simplify` 交互元素无直接文本时（现 :158 行 `grabText`），改为 `aria-label → title → grabText`。新增共享辅助 `elLabel(el)`（view-core 导出），view 与 article 共用，行为一致。

### #4 图例：`view` 入口（Node 侧）

view 输出顶部加一行 `#` 注释图例，解释 `[ref=i]`、`[ref=i,visible]`、`~"…"`（聚合文本）、`▸`（已折叠）、`[shadow]`（shadow DOM）、`input[...]`。单行、`#` 打头，Agent 易跳过、不会误当内容。只加在 `view` 命令顶层打印（反馈/自愈块不加）。

### #5 两遍先序 ref：`view-core.ts` 重构 `buildView`

- **遍一**：`simplify` 只建树、不登记 ref。对节点打标记：
  - `wantRef`：`isEl && inView && (inter || text || hasShadow)`（现 :122 条件）
  - `wantHidden`：`isEl && inView && 纯包装 && subtreeHasContent`（现 :171 条件；`subtreeHasContent` 遍一自底向上算）
  - 折叠节点（现 :98）同样 `wantRef`，不递归。
- **遍二**：先序 DFS 一次性分配：`ref = __cdpRefs.length`，push `{el, parentRef}`；`parentRef` = 本遍最近已登记祖先（先序保证祖先先于后代）。`hidden` 节点保留 `node.hidden=true`、`node.ref` 仍为 undefined（view 不打印，`info` 反查可用）。
- 保留「只追加、不重置」：view 入口重置，局部/反馈/自愈从当前长度继续（遍二从 `__cdpRefs.length` 起步）。

结果：`html/body/#root` 低位、内容号随树位置递增，`info 1` 链有序。

## 数据流

```
article <ref>
  → api.article (Node, invoke)
    → inject/article.ts: refElement → 保序 DOM 遍历 → Markdown 文本 → setResult
```

```
view / article / 反馈 / 自愈
  → buildView (遍一建树+标记 → 遍二先序登记 ref)
```

## 错误处理

- `article` ref 失效 → 复用 `notFoundResult`/`recoverRef` 自愈语义（与 click/find 一致）。
- ref 未解析 → `{ok:false, err}`，走统一 `invoke` 抛异常。

## 测试

- **浏览器实测**（DOM 依赖，遵循项目规范，不写单测）：`view` 图例、`article` 知乎回答保序与不截断、图标按钮 aria、`info` 链有序、ref 先序单调。
- **构建 + 既有单测回归**：`npm test` 全绿（view-format/view-utils 等不受影响）；`npm run build` 通过。

## 文档分工

- `SKILL.md`：补 `article` 命令、图例说明、aria 兜底说明。
- `CLAUDE.md`：补 `article.ts`（保序 DOM 遍历）、两遍先序 buildView 说明、`elLabel`。
