# cdp-browser-control 开发者说明

> 面向**开发者**(维护本 skill 源码的人)。**agent 使用本 skill 时只需要 `SKILL.md`,不需要看这里。**
> 运行入口:`node dist/cdp.js`(需先构建)。

## 构建

本项目的 `dist/`(实际运行产物)不提交 git,改动源码后需重建:

```bash
npm install      # 首次:装 esbuild / typescript / @types/node / commander(运行时仅 commander,无 fontoxpath)
npm run build    # tsc --noEmit(类型检查) + esbuild(编译 + 打包注入脚本)
npm test         # node:test 跑 tests/*.test.ts(零运行时依赖)
```

`npm run build` 产出的 `dist/` 结构:
```
dist/cdp.js              入口 bundle(commander + 全部 src 模块,自包含:拷走 dist 即可运行)
dist/*.js                其余 Node 侧(api/transport/monitor/browser/inject-loader/keys,转译保留)
dist/inject/*.js         注入到浏览器页面跑的 JS(esbuild 打包成自包含 IIFE)
```

## 源码结构(两层,彻底分离)

| 目录 | 内容 | 运行环境 | 编译 |
|---|---|---|---|
| `src/*.ts` | Node 侧(连接 CDP、CLI、api、纯函数模块;`folds.ts` 为 fold 规则文件读写) | Node | `src/cdp.ts` 入口 esbuild bundle(含 commander)→ `dist/cdp.js`;其余转译 CJS(不打包) |
| `src/inject/*.ts` | 注入浏览器页面执行的 JS(入口) | 浏览器(DOM lib) | esbuild bundle 成 IIFE → `dist/inject/` |
| `src/inject/lib/` | 注入侧共享模块(genSel/result/arg/monitor-inject/tree-utils/tree-format/tree-core/feedback/find-root/fold) | 浏览器 | 打进各入口 |

依赖单向无环:`transport ← inject-loader/api/folds ← monitor/browser ← cdp`;注入侧 `find → tree-core → fold`、`tree-core → fold(arg)` 等同侧 import 也不成环。定位体系已收敛为两套:**ref(前台索引)+ selector(后台匹配)**,xpath 全套退役(删了 fontoxpath 依赖)。

## 注入脚本契约(改动注入脚本必读)

注入脚本经 esbuild 打包成自包含 IIFE,`Runtime.evaluate` 的 `returnByValue` 取整体完成值。
esbuild 会把入口包进 module wrapper、吞掉返回值,故:

1. **结果写入**:注入脚本把结果写到全局 `globalThis.__cdpResult`(用 `src/inject/lib/result.ts` 的 `setResult`)。
2. **footer 读取**:`build.mjs` 给每个入口统一追加 footer `;(async()=>{const r=await globalThis.__cdpResult;delete globalThis.__cdpResult;return r})()`——整体完成值即结果,且读完即删、无残留。**footer 是 async 并 await `__cdpResult`**:同步入口传普通值(await 原样通过);异步入口(如 `tree --scroll-to-load` 先滚动再建树)可 `setResult(<promise>)` 传 promise,footer await 后拿到解析值。`Runtime.evaluate` 开了 `awaitPromise`。
3. **参数传递**:注入脚本用自由标识符 `__CDP_ARG__`(TS 里 `declare const __CDP_ARG__: XxxArgs`),Node 侧 `src/inject-loader.ts` 注入前拼一行 `var __CDP_ARG__ = <json>;`。无需字符串替换。
4. **入参数类型**在 `src/inject/lib/arg.ts`(FindArgs/FillArgs/TreeArgs(含 FoldItem)/LocateArgs/ReadArgs/FoldArgs)。

**新增注入入口的步骤**:在 `src/inject/` 加一个 `.ts`(顶层,不进 lib/),用 `setResult` + 可选 `__CDP_ARG__`,重建即可自动打包成 `dist/inject/<名>.js`。**注意**:注入侧代码跑在浏览器,不能用 Node API;类型只在编译期(DOM lib)。

**建树 core(tree-core.ts)**:DOM 采集(simplify + visible-only 裁剪 + fold 折叠)抽在 `lib/tree-core.ts` 的 `buildTree(root, {visibleOnly, viewport, folds})`,被 `tree` 入口、`feedback-collect`、`recoverRef` 共享。**buildTree 只"追加" ref 到 `__cdpRefs`,不重置**——重置时机归调用方(tree 整页建树前才从 0 清空;反馈/自愈**不重置、只追加**,使它们的 ref 为增量号)。`viewport:true` 时对带 ref 节点算便宜 `isInViewport`(rect+宽高,不查 computed style),存入 `node.view`,formatTree 据此输出 `[ref=i·屏]`(在视区)/`[ref=i]`。**fold 折叠**:`folds`(持久规则,Node 侧按 hostname 过滤后传入)+ 会话级临时(`__cdpFolds`,见 `lib/fold.ts`)合并按 `el.matches(selector)` 判定;命中**非根**元素(depth>0)时登记 ref(容器可展开)、设 `node.fold=备注`、`kids=[]` 不递归。**根不折叠**——否则 `tree --ref i` 展开折叠容器时根本身又被折叠,永远展不开;嵌套折叠自然支持(展开一层后,子树里命中的规则继续折叠)。**shadow host 占位**:带 `shadowRoot` 的 Element(custom element,如 `bili-comments`)无条件登记 ref 并设 `isContent=true`——这类 host 常无 light 文本、首屏 shadow 子树还空,按 `inter||text` 登记就静默消失。`tree-format.walk` 对 `depth>0 && shadow && ref` 的节点输出占位行(`<tag>[shadow] [ref=N]`)、不展开 shadow 子树(深入用 `tree --ref N`/`--selector-file`);根(depth=0)是展开目标,正常走子树。fold 命中的 host 仍走 fold(优先级不变)。

**操作反馈(feedback-start/collect)**:`lib/feedback.ts` 的 `startFeedback()` 装 MutationObserver 记 childList 新增 + 文本变化(**前后值**:childList 文本替换用 removedNodes=旧值 / addedNodes=新值 配对成 `before → after`;characterData 原地改字符用 `characterDataOldValue` 的 `m.oldValue` 作旧值)。`collectFeedback()` 断开后取**顶层新增元素**逐块 `buildTree`,返回**结构化** `{blocks, changes}`:`blocks` 是去重折叠后的新增块(按去掉 ref 号的行签名去重,重复块 `count++`);`changes` 是过滤前后相同后的文本变化列表。注入入口 `feedback-start`/`feedback-collect` **分两次 eval 协作**,observer 状态暂存全局 `__cdpFeedback`;中间 Node 侧(api.ts 的 `runWithFeedback`)执行动作 + `sleep(feedbackDelay)` + 前后各 `list()` 一次 diff tab(opened/closed)。`noFeedback` 时不观察/不等待/不 diff,`feedback:null`。**ref 失效自愈时 `runWithFeedback` 短路**:doAction 返回 `{refInvalid:true}` 则跳过 sleep/collect/tabdiff,直接透传 `recovered`。

**注入动作返回唯一 selector + ref 失效自愈(所有 ref 命令)**:`click`/`fill`/`focus`/`hover` 注入入口操作成功时用 `genSel` 生成目标元素的唯一 CSS selector 一并返回(`{ok, tag, selector}`),CLI 操作行据此打印 `selector:`——后续对该元素操作优先用 selector 而非 ref,避免 ref 重渲染失效。**任何用 ref 的命令(`click`/`fill`/`focus`/`hover`/`locate`/`fold`)ref 解析失败时统一自愈,不裸报错**:注入侧调 `lib/find.ts` 的 `notFoundResult(arg)` —— ref 路径返回 `{ok:false, refInvalid:true, recovered: recoverRef(ref)}`,selector 路径返回普通 err;`ref.ts`(locate)、`fold.ts` 的 `--ref` 分支同样走它。`recoverRef` 三态:**判定逻辑(纯,无 DOM)抽到 `lib/find-root.ts` 的 `classifyRef`**(返回 `none`/`never{maxRef}`/`live{start,maxRef}`,可单测);`find.ts` 的 `recoverRef` 据此在 `live` 态走 `__cdpRefs[i].parentRef` 跳表找首个 `isConnected` 祖先,以它为根 `buildTree`(增量 ref)返回 `{rootRef, lines}`,整链 detached 返回 `null`。Node 侧 `invoke` 对 `refInvalid` 透传不抛(`api.fold --save` 据此跳过 `addFold`),`runWithFeedback` 短路跳过反馈,`cdp.ts` 共享 `printRefInvalid` 检测三态打印(从未存在→报 ref 号;自愈→最近存活容器 + 局部 tree;整链失效→重新 tree)。

**ref 登记表契约**:tree 遍历时把内容/交互元素登记进 `window.__cdpRefs`,`[ref=i]` 序号即其下标;**登记表存 `{el, parentRef}` 而非裸 Element**——`parentRef` 是"最近的已登记祖先的 ref 号"(buildTree DFS 顺带记录,O(1) 跳表,不存全链),供 ref 失效自愈向上找存活容器。tree 每次重建时**先清空再重排**(序号随树变,别跨树假设)。**操作反馈/自愈的反馈树不重置 __cdpRefs,只追加**——新增 ref 从现有长度递增(增量号),**不顶掉整页旧 ref**;agent 既可用增量 ref 操作新增内容,原 ref 依旧有效。只有整页 `tree` 才清空重排。`tree`/`locate`/`fold`/`click`/`fill`/`focus`/`hover` 都靠它按 ref 定位。共享解析在 `lib/find-root.ts` 的 `refElement`(ref→元素,兼容裸 Element 与 `{el,parentRef}` 两种形态)+ `climbAncestors`(向上爬父,`--ancestor` 用);`locate`(注入入口 `src/inject/ref.ts`)用它们把 ref 翻译成**稳定 CSS selector**(`genSel`:id 锚定 + `:nth-of-type` 链;仅覆盖 light DOM——shadow 内元素 parentElement 在边界为 null,路径断在 host 锚定,shadow 内元素靠 ref 操作)。

**fold 折叠规则(取代已删除的 stash)**:Node 侧 `src/folds.ts` 读写持久规则文件 `$CDP_USER_DATA/folds.txt`(三列 **tab 分隔** `<域名>\t<selector>\t<备注>`——selector 含空格故不能用空白分隔,行首 `#` 注释;域名精确或 `*.suffix` 通配)。`loadFolds/addFold/removeFold/matchFolds/hostOf/domainMatch` 纯函数 + 落盘;`api.tree` 按 `hostOf(target.url)` 过滤后把 `{selector, note}[]` 注入 `__CDP_ARG__.folds`。会话级临时折叠存页面全局 `__cdpFolds`(`lib/fold.ts` 的 `addTmpFold/clearTmpFolds/listTmpFolds`),刷新清空。注入入口 `src/inject/fold.ts`(临时折叠/list/clear;`--save` 落盘由 Node 侧 `api.fold` 调 `locateExpr` 拿 selector 后写文件,不经此入口)。CLI `fold add` / `fold list` / `fold rm <id>` / `fold --ref <n> [备注] [--ancestor] [--save] [--domain]`。**fold 不是 stash**:stash 是"藏"(整棵不输出、刷新丢、存元素);fold 是"折叠"(输出一行 `▸ [ref=i] <备注>` 保留 ref 可展开、跨会话持久、基于 selector 规则)。

## 返回契约(api.ts 的 `invoke`)

Node 侧统一用 `invoke(target, expr)` 执行注入脚本并解包结果:注入脚本成功返回任意值(可含 `{ok:true}`);失败返回 `{ok:false, err}`。`invoke` 统一把 `{ok:false}` 抛成异常,调用方无需各自判 ok。数据类入口(tree/locate 等返回裸对象)自然通过。改 api 方法时统一走 `invoke`,别再散落 `r?.ok` 检查。

## 测试

- `tests/*.test.ts` 用 Node 内置 `node:test` + `node:assert/strict`,零运行时依赖。
- 纯函数单测覆盖:`src/inject/lib/tree-utils.ts`(inlineLen/inlineable/leafText/firstTxt/isTrivialLeaf)、`src/inject/lib/tree-format.ts`(formatTree/markText,结构树折叠内联的纯变换)、`src/inject/lib/genSel.ts`(genSel)、`src/inject/lib/find-root.ts`(refElement/climbAncestors/classifyRef——后者是 recoverRef 的纯判定分支:无登记表→none、越界/槽空→never、已登记→live,用假 entry 模拟)、`src/folds.ts`(parseRules/domainMatch/hostOf,fold 规则解析与域名匹配)、`src/keys.ts`(parseKeySpec)、`src/transport.ts`(resolveTarget)。
- 注入侧 DOM 相关逻辑(如 tree-core 的 buildTree/fold 折叠(DOM 采集)、feedback 的顶层新增元素判定、find.ts 的 recoverRef 沿 parentRef 跳表自愈的 live 分支——命中 `isConnected=true` 触发 buildTree)依赖真实 DOM,靠浏览器实测验收(见 SKILL.md 用法),不写单测。`formatTree` 的纯变换分支(`·屏` view 标注、shadow host 占位/fold 优先)均已有单测锁定。

## 文档分工

- `SKILL.md`:面向 **agent 使用**,只讲怎么调 `dist/cdp.js`,不含构建/源码结构。
- `CLAUDE.md`(本文件):面向 **开发者**,含构建、源码结构、注入契约、测试。
- `docs/superpowers/specs/`:设计文档。根目录不再放 DESIGN md。


---

以上为 Agent 自动生成，从此以下为用户所写。

上面的所有约定仅表示开发的历史路径，不代表未来约束。

重构、加新功能，在新的 branch 做，以迭代的方式分阶段提交，最后 merge 到 main。

这个项目是为服务 Agent 更好地读网页写的，一切以服务 Agent 为目标，所有的不合理通通可被扔，一切的重构要激进，要以最优为先，无需背负兼容性顾虑。

临时路径用项目根目录里的 `./tmp`