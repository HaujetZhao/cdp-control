# 顶层重整:tree(感知)· ref(索引)· selector(匹配)· fold(降噪)

> 日期:2026-08-09。状态:已与用户确认方向,分阶段实现。
> 用户定调:"以 tree 作为核心感知,以 ref 作为操作索引,以 selector 作为后台匹配。"

## 1. 现状与问题

当前定位体系是**三套并列**:ref(会话句柄,刷新失效)+ selector(genSel)+ xpath(genXpath + fontoxpath 穿透求值版)。问题:

- **xpath 是第三套定位器**,维护成本最高(fontoxpath 重依赖 + 自写 shadowFacade + normalizeXpath/splitAxis 一整套纯逻辑),却与 ref+selector 高度重叠。
- **ref 失效要 agent 自己猜**该 tree 哪个容器(SKILL.md 反复叮嘱"用更高层级 ref"),认知负担重。
- **stash 鸡肋**:存 DOM 元素、刷新即丢、只能"藏"不能"折叠",无法跨会话。agent 真正需要的是**持久化折叠规则**(每次打开知乎都自动收起顶栏)。

## 2. 目标模型(收敛)

| 角色 | 重整后 |
|---|---|
| 前台索引 | **ref**(唯一) |
| 后台匹配 | **selector**(唯一;xpath 退役) |
| 降噪 | **fold**(持久 selector 规则,跨会话;取代 stash) |
| 韧性 | **ref 祖先链自愈**(操作失败自动 tree 最近存活容器) |

## 3. 三项改动

### 3.1 xpath 退役(删依赖)

- 删 `genXpath`、删 fontoxpath 依赖、删 find-root.ts 的 shadowFacade / xpathEval / xpathRoot / normalizeXpath / splitAxis
- 删 `tree --xpath-file`、`locate` 的 xpath 输出、api.ts 的 xpath 参数、`TreeArgs.xpath`、`treeExpr` 的 xpath 形参
- locate 收敛为只出 selector
- shadow 内元素定位:ref(tree 已穿透 shadow 建 ref)+ host 锚定的 selector(`tree --selector-file` 命中 host 再 `--ref` 展开)

### 3.2 ref 祖先链自愈

**登记表升级**:`__cdpRefs` 从 `Element[]` → `Array<{el, parentRef: number|null}>`。
- buildTree DFS 时维护"已登记 ref 的祖先栈",登记新 ref 时记录**最近带 ref 祖先的 ref 号**(O(1) 跳表,不存全链)
- 失效判定:`el.isConnected === false`

**自愈流程**(click/fill/focus/hover 用 ref,解析发现 detached):
1. 沿 `parentRef` 链向上跳,找首个 `isConnected` 的祖先 ref
2. 以它为根做**局部 tree**(用增量 ref 号,不重置全局表 —— 复用现有反馈机制)
3. 返回 `{ok:false, refInvalid:true, recovered:{rootRef, lines}}`,CLI 打印更新内容
4. agent 一轮拿到更新内容 + 新增量 ref,直接重试

### 3.3 fold(取代 stash)

**规则文件**:跨会话持久,放 `CDP_USER_DATA`(默认 `~/.cdp-browser`)下 `folds.txt`。格式类 uBlock:
```
www.bilibili.com   .bili-header     # 顶部导航
zhihu.com          .AppHeader       # 知乎顶栏
```
域名匹配:精确 + 后缀通配(`*.zhihu.com`)。

**CLI(`fold` 命令族,取代 `stash`)**:
- `fold add <域名> <selector> <备注>` — 手动加持久规则
- `fold --ref <i> [--ancestor <k>] [--save <备注>] [--domain <d>]` — 从 ref 推 selector+域名;带 `--save` 落盘,不带=会话级临时折叠
- `fold list` — 列规则
- `fold rm <id>` — 删规则

**buildTree 折叠行为**:
- Node 侧 tree 前读 `folds.txt`,按当前 hostname 过滤匹配规则,把 `{selector, note}[]` 传进注入侧;临时折叠存页面全局 `__cdpFolds`
- buildTree 遇命中元素(`el.matches(sel)` 或在临时集合)→ **折叠**:输出一行 `▸ [ref=i] <备注>`,不递归子树,保留 ref
- **嵌套天然支持**:展开折叠容器(`tree --ref i`)就是普通局部 tree,子树里命中的 fold 规则继续折叠

## 4. 文档大改

- **SKILL.md**:删全部 xpath 铁律/易错/示例;locate 只讲 selector;`stash` 段落整段换成 `fold`;新增"ref 失效自动自愈"
- **CLAUDE.md**:删 genXpath/fontoxpath/shadowFacade/stash 段;加 fold 规则文件契约、ref `parentRef` 跳表 + 自愈、buildTree 折叠分支

## 5. 实施顺序(每步独立 commit,最后 merge main)

1. **xpath 退役** — 砍依赖降复杂度
2. **ref 祖先链自愈** — 登记表升级 + findTarget 失效自愈
3. **fold 取代 stash** — 规则文件 + CLI + buildTree 折叠 + 删 stash
4. **文档大改** — SKILL + CLAUDE
