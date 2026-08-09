# 设计文档:CLI commander 重构 + view 结构忠实度修复

日期:2026-08-08
状态:已批准(用户确认三项决策:聚合文本加标记 / 递归 shadow 穿透 / commander 最激进重构)

## 1. 背景与问题

实测 B 站视频页(`node dist/cdp.js view --target bili`)发现三处影响「从 view 输出构造 xpath 反查页面」的问题:

1. **view 引用文本可能是聚合文本而非直接文本节点**。`simplify`([src/view.ts](src/view.ts))第 70/71 行的 `grabText`/`innerText` 兜底,会把「子元素里的文本」折叠显示到父标签上(如 `a "首页"` 的真实直接文本其实在子 `span` 里)。agent 用 `//a[contains(text(),'首页')]` 反查会**漏**(`text()` 只查直接文本节点),必须用 `contains(.,'…')`(递归 string-value)。现状无法从输出分辨字面文本与聚合文本。

2. **深层嵌套 shadow DOM 的 xpath 首个命中不可靠**。`xpathRoot`([src/inject/lib/find-root.ts](src/inject/lib/find-root.ts))只对「document + 各 shadowRoot 的**顶层子元素**」求值。B 站评论区是多层嵌套 web component(各自 shadow DOM),实测 `//bili-comment-renderer` 取到**最后一条**评论而非文档序第一条;`//bili-comments//bili-comment-renderer` 组合路径直接未命中。view 能看到这些内容,靠的是 [view.ts](src/view.ts) 的 `childrenOf` **递归穿透** shadow,而 xpath 只穿透一层——两者不一致。

3. **CLI 参数与命令体系不统一**。`--help`/`-h` 只在命令名位置被识别([src/cdp.ts](src/cdp.ts) 第 270 行),`view --help` 里 `--help` 被 `parseArgs` 当布尔 flag 忽略,不显示帮助。命令命名混用下划线(`get_focus`/`press_key`)与连字符(`listen-stop`)。参数解析 `parseArgs` 极简,无 per-command 参数定义、无校验、无命令级 help。

## 2. 目标

- 让 view 输出能区分「字面文本」与「聚合文本」,消除 xpath 反查陷阱。
- 让 xpath 穿透**任意深度**的 shadow DOM,深层元素也能稳定取文档序首个命中。
- 用成熟 CLI 框架(commander)重构命令行:声明式命令、每命令自动 `--help`、参数校验、命名统一 kebab-case;dist 自包含 bundle(拷走即跑、无需 npm install)。
- 同步更新 SKILL.md 与 CLAUDE.md。

## 3. 坑 1:聚合文本标记

### 设计

- [src/view.ts](src/view.ts) 的 `simplify`:给 `ViewNode` 增加 `agg: boolean` 字段。文本来源为第 70/71 行兜底(`grabText`/`innerText`)时置 `true`;第 57 行 `ownText`(直接子文本)保持 `false`。
- [src/inject/lib/view-format.ts](src/inject/lib/view-format.ts) 的 `leafLabel`/`inlineLabel`:输出引用文本时,若节点 `agg` 则前缀 `~`。字面文本不加标记。
- 符号 `~` 表示「约/聚合文本」(只在兜底情况出现,噪音最小)。仅出现在输出侧,无 shell 转义问题。

### 示例

```
a ~"首页"        # 聚合文本(子元素里的文本,反查用 contains(.,'…'))
a "下载客户端"   # 若为字面文本则无标记
```

## 4. 坑 2:递归 shadow 穿透

### 设计

- [src/inject/lib/find-root.ts](src/inject/lib/find-root.ts) 的 `shadowContexts`:从「document + 各 shadowRoot 顶层子元素」改为**递归收集 document + 所有元素(任意深度)的 shadowRoot** 作为求值 context,按 DFS 预序排列(宿主文档序在前)。
- `xpathRoot`:对每个 context 求 `FIRST_ORDERED_NODE_TYPE`,取**首个非空命中**。context 顺序按 DFS 预序(document 的 light DOM 在前,shadow 按宿主文档序),保证深层元素也按文档序取到第一个。
- 性能:B 站评论区多层嵌套 shadow,但只在显式传 `--xpath` 时执行,且首个命中即短路,可接受。
- **验收**(浏览器实测):`//bili-comment-renderer` 稳定取到第一条评论(林韵子墨)。注意 `//bili-comments//bili-comment-renderer` 这类**跨 shadow 组合路径不可行**(`document.evaluate` 不穿透 shadow 做组合),改用 `//bili-comments` 建选区(树穿透显示全部评论)。

## 5. 坑 3:commander 重构 CLI

### 5.1 依赖与构建

- 引入 `commander`(Node CLI 事实标准)。
- 构建改为 **dist 自包含 bundle**:esbuild 把 src 模块 + commander **打包进 `dist/cdp.js`**,拷走 dist 即跑,无需 npm install。注入脚本维持 bundle IIFE。改 `build.mjs` 的 Node 侧入口从「转译不打包」为「bundle」。

### 5.2 命令定义

- 命令统一 **kebab-case**(同步更新 SKILL.md;旧名不兼容,符合「不保留向后兼容」):
  - `get_focus → get-focus`、`press_key → press-key`;`listen-stop` 不变。
- `--target` 改为**全局 option**(`-t, --target <匹配>`),子命令经 `program.opts().target` 取。
- `eval` 用 variadic 位置参数(`<js...>`)。
- `--selector-file/--xpath-file/--level/--since/--file` 等作为 per-command option。
- `help`/`--help`/`-h` 全交 commander(修掉坑 3 根源)。
- 保留全部现有命令:`ensure/list/open/close/navigate/eval/snapshot/view/click/fill/focus/get-focus/press-key/hover/outline/content/shot/logs/listen/listen-stop/run`。

### 5.3 清理

- `src/cli-args.ts`(`parseArgs`)被 commander 取代 → **删除**,连带 `tests/cli-args.test.ts` 删除。
- handler 逻辑尽可能抽成可测纯函数(按 plan 决定抽哪些)。

## 6. 文档同步

- `SKILL.md`:更新命令名(kebab-case)、`--help` 说明、view 聚合文本标记 `~` 的语义、xpath 穿透深度的说明。
- `CLAUDE.md`:更新构建说明(dist 自包含 bundle、commander 依赖)、源码结构、测试范围(删除 cli-args 测试)。

## 7. 测试

- 删除 `tests/cli-args.test.ts`(parseArgs 废弃)。
- 保留/新增纯函数单测:view-format 的聚合标记逻辑、find-root 的 shadowContexts(若可脱离 DOM 测)。
- 注入侧 DOM 逻辑(view 聚合标记、find-root 递归穿透)仍靠浏览器实测验收(见 SKILL.md 用法),不写单测。

## 8. 实施与提交策略

按独立可回测的三块分阶段提交:
1. 坑 1:聚合文本标记(改 view.ts + view-format.ts + 单测 + 回测)。
2. 坑 2:递归 shadow 穿透(改 find-root.ts + 回测 `//bili-comment-renderer`)。
3. 坑 3:commander 重构(依赖 + build.mjs + cdp.ts + 删 parseArgs + 更新文档)。
4. 同步 SKILL.md / CLAUDE.md。
5. merge 回 main。
