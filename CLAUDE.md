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
| `src/inject/lib/` | 注入侧共享模块(genSel/result/arg/monitor-inject/view-utils/view-format/view-core/feedback/find-root/fold) | 浏览器 | 打进各入口 |

依赖单向无环:`transport ← inject-loader/api/folds ← monitor/browser ← cdp`;注入侧 `find → view-core → fold`、`view-core → fold(arg)` 等同侧 import 也不成环。定位体系已收敛为两套:**ref(前台索引)+ selector(后台匹配)**,xpath 全套退役(删了 fontoxpath 依赖)。

## 注入脚本契约(改动注入脚本必读)

注入脚本经 esbuild 打包成自包含 IIFE,`Runtime.evaluate` 的 `returnByValue` 取整体完成值。
esbuild 会把入口包进 module wrapper、吞掉返回值,故:

1. **结果写入**:注入脚本把结果写到全局 `globalThis.__cdpResult`(用 `src/inject/lib/result.ts` 的 `setResult`)。
2. **footer 读取**:`build.mjs` 给每个入口统一追加 footer `;(async()=>{const r=await globalThis.__cdpResult;delete globalThis.__cdpResult;return r})()`——整体完成值即结果,且读完即删、无残留。**footer 是 async 并 await `__cdpResult`**:同步入口传普通值(await 原样通过);异步入口(如 `view --scroll-to-load` 先滚动再建视图)可 `setResult(<promise>)` 传 promise,footer await 后拿到解析值。`Runtime.evaluate` 开了 `awaitPromise`。
3. **参数传递**:注入脚本用自由标识符 `__CDP_ARG__`(TS 里 `declare const __CDP_ARG__: XxxArgs`),Node 侧 `src/inject-loader.ts` 注入前拼一行 `var __CDP_ARG__ = <json>;`。无需字符串替换。
4. **入参数类型**在 `src/inject/lib/arg.ts`(FindArgs/FillArgs/ViewArgs(含 FoldItem)/LocateArgs/FindCmdArgs/LineageArgs/ReadArgs/FoldArgs)。

**新增注入入口的步骤**:在 `src/inject/` 加一个 `.ts`(顶层,不进 lib/),用 `setResult` + 可选 `__CDP_ARG__`,重建即可自动打包成 `dist/inject/<名>.js`。**注意**:注入侧代码跑在浏览器,不能用 Node API;类型只在编译期(DOM lib)。

**建视图 core(view-core.ts)**:DOM 采集(simplify + visible-only 裁剪 + fold 折叠)抽在 `lib/view-core.ts` 的 `buildView(root, {visibleOnly, viewport, folds})`,被 `view` 入口、`feedback-collect`、`recoverRef`、`find-entry` 共享。**buildView 只"追加" ref 到 `__cdpRefs`,不重置**——重置时机归调用方(view 整页建视图前才从 0 清空;反馈/自愈/find **不重置、只追加**,使它们的 ref 为增量号)。`viewport:true` 时对带 ref 节点算便宜 `isInViewport`(rect+宽高,不查 computed style),存入 `node.view`,formatView 据此输出 `[ref=i·屏]`(在视区)/`[ref=i]`。**fold 折叠**:`folds`(持久规则,Node 侧按 hostname 过滤后传入)+ 会话级临时(`__cdpFolds`,见 `lib/fold.ts`)合并按 `el.matches(selector)` 判定;命中**非根**元素(depth>0)时登记 ref(容器可展开)、设 `node.fold=备注`、`kids=[]` 不递归。**根不折叠**——否则 `view --ref i` 展开折叠容器时根本身又被折叠,永远展不开;嵌套折叠自然支持(展开一层后,子树里命中的规则继续折叠)。**shadow host 占位**:带 `shadowRoot` 的 Element(custom element,如 `bili-comments`)无条件登记 ref 并设 `isContent=true`——这类 host 常无 light 文本、首屏 shadow 子树还空,按 `inter||text` 登记就静默消失。`view-format.walk` 对 `depth>0 && shadow && ref` 的节点输出占位行(`<tag>[shadow] [ref=N]`)、不展开 shadow 子树(深入用 `view --ref N`/`--selector-file`);根(depth=0)是展开目标,正常走子树。fold 命中的 host 仍走 fold(优先级不变)。**表单元素采集**:simplify 对 INPUT/TEXTAREA 设 `node.inputInfo={type,value,placeholder}`(value 截 40;input 默认 text、textarea 不显式标 type),formatView 的 `inputAttr` 据此输出 `input[type=text value="..." placeholder="..."]`(空值省略),让 agent 看到搜索框内容不必 eval;prune 视口外清空 inputInfo 退化为空骨架。**模块导出**:`strip`(空白归一化)、`ownElText`(元素自身直接子文本,locate 的 text 字段 + find 文本比对都用它,确保命中具体元素而非子树聚合的祖先容器)、`subtreeText`(穿透 shadow 子树文本,备用——find 不用它,否则会命中最外层容器)、`childrenOf`(穿透 shadow 取子,find DFS 用)、`isInViewport`、`buildView`。**view 入口默认滚动加载**:`src/inject/view.ts` 对**整页完整 view**(无 `ref`/`selector`/`visibleOnly`、未显式给 `scrollToLoad`/`scrollPages`/`scrollTo`)在页面首次自动 `scrollToLoad()` 触发懒加载再建树,并置页面级标志 `__cdpFullViewDone`(同页刷新前只自动滚一次,后续整页 view 不再默认滚;局部 view/`--visible-only`/显式给了滚动参数都不触发)。`fetchPage` 靠它一次抓全懒加载内容;Node 侧 `api.fetchPage` 的等待条件已从 `readyState!=='loading'` 增强为"body 有非空文本"(`document.body && body.innerText.trim().length > 0`),避免 SPA 首帧空 body 就抓。

**操作反馈(feedback-start/collect)**:`lib/feedback.ts` 的 `startFeedback()` 装 MutationObserver 记 childList 新增 + 文本变化(**前后值**:childList 文本替换用 removedNodes=旧值 / addedNodes=新值 配对成 `before → after`;characterData 原地改字符用 `characterDataOldValue` 的 `m.oldValue` 作旧值)。`collectFeedback()` 断开后取**顶层新增元素**逐块 `buildView`,返回**结构化** `{blocks, changes}`:`blocks` 是去重折叠后的新增块(按去掉 ref 号的行签名去重,重复块 `count++`);`changes` 是过滤前后相同 + 时间戳折叠后的文本变化列表。注入入口 `feedback-start`/`feedback-collect` **分两次 eval 协作**,observer 状态暂存全局 `__cdpFeedback`(存 **observer 数组** + state);中间 Node 侧(api.ts 的 `runWithFeedback`)执行动作 + `sleep(feedbackDelay)` + 前后各 `list()` 一次 diff tab(opened/closed)。`noFeedback` 时不观察/不等待/不 diff,`feedback:null`。**ref 失效自愈时 `runWithFeedback` 短路**:doAction 返回 `{refInvalid:true}` 则跳过 sleep/collect/tabdiff,直接透传 `recovered`。**shadow 穿透**:MutationObserver 默认只观察调用 observe 的那棵树不进 shadowRoot——B站点赞数/弹幕多在 shadow 内,变化根本看不到。`startFeedback` 的 `observeAll(root,depth)` 递归对 document 及其所有 shadowRoot 各起一个共享 callback 的 observer(`MAX_SHADOW_DEPTH=3` 防爆炸),childList 新增节点带 shadowRoot 时 `observeShadowTree` 补装(覆盖动态挂载的 host);`currentDepth` 沿 `getRootNode()→host` 回溯查 `depthMap` 判定补装是否超限。**噪声过滤**:onMutate 顶部 `inIgnoredSubtree(target)` 沿 parentElement+host 穿透判定 target 在 `VIDEO`/`AUDIO`/`CANVAS`(`IGNORE_SUBTREE_OF`)子树内则整个 mutation 跳过(弹幕/播放进度/缓冲/canvas 动画每秒数十次,会刷满 changes 挤掉真变化);`collectFeedback` 跑纯函数 `foldTimestampRun` 折叠连续 ≥3 条 `\d{1,2}:\d{2}` 播放时间戳(如 `01:55→01:56→…`)为一条 `{before,after,note}`,**纯数字计数(点赞数 1402→1403→…)不匹配格式不折叠**(保守避免误杀真信号);`foldTimestampRun` 已加单测(`tests/feedback.test.ts`)。顶层新增去嵌套(`hasAncestorInSet`)同样穿透 shadow 边界。

**注入动作返回唯一 selector + ref 失效自愈(所有 ref 命令)**:`click`/`fill`/`focus`/`hover` 注入入口操作成功时回显目标元素的唯一 CSS selector(供后续优先用 selector 而非 ref,避免 ref 重渲染失效):light 元素用 `genSel`,**shadow 内元素不回废 selector**(querySelector 查不到会误导),改为 `{ok, tag, shadow:true, selector:null}`——CLI `printAction` 据此提示"用 ref 操作",且 light selector 超长(>80)截断显示。回显统一走 `lib/find-root.ts` 的 `actionSelector(el)`(判 shadow + light 调 genSel)。**任何用 ref 的命令(`click`/`fill`/`focus`/`hover`/`locate`/`fold`)ref 解析失败时统一自愈,不裸报错**:注入侧调 `lib/find.ts` 的 `notFoundResult(arg)` —— ref 路径返回 `{ok:false, refInvalid:true, recovered: recoverRef(ref)}`,selector 路径返回普通 err;`ref.ts`(locate)、`fold.ts` 的 `--ref` 分支同样走它。`recoverRef` 三态:**判定逻辑(纯,无 DOM)抽到 `lib/find-root.ts` 的 `classifyRef`**(返回 `none`/`never{maxRef}`/`live{start,maxRef}`,可单测);`find.ts` 的 `recoverRef` 据此在 `live` 态走 `__cdpRefs[i].parentRef` 跳表找首个 `isConnected` 祖先,以它为根 `buildView`(增量 ref)返回 `{rootRef, lines}`,整链 detached 返回 `null`。Node 侧 `invoke` 对 `refInvalid` 透传不抛(`api.fold --save` 据此跳过 `addFold`),`runWithFeedback` 短路跳过反馈,`cdp.ts` 共享 `printRefInvalid` 检测三态打印(从未存在→报 ref 号;自愈→最近存活容器 + 局部 view;整链失效→重新 view)。

**ref 登记表契约**:view 遍历时把内容/交互元素登记进 `window.__cdpRefs`,`[ref=i]` 序号即其下标;**登记表存 `{el, parentRef}` 而非裸 Element**——`parentRef` 是"最近的已登记祖先的 ref 号"(buildView DFS 顺带记录,O(1) 跳表,不存全链),供 ref 失效自愈向上找存活容器。view 每次重建时**先清空再重排**(序号随树变,别跨树假设)。**操作反馈/自愈/find 的反馈树不重置 __cdpRefs,只追加**——新增 ref 从现有长度递增(增量号),**不顶掉整页旧 ref**;agent 既可用增量 ref 操作新增内容,原 ref 依旧有效。只有整页 `view` 才清空重排。CLI 命令 `view`/`click`/`fill`/`focus`/`hover` 都靠它按 ref 定位。共享解析在 `lib/find-root.ts` 的 `refElement`(ref→元素,兼容裸 Element 与 `{el,parentRef}` 两种形态)+ `climbAncestors`(向上爬父,`--ancestor` 用);`locate`(注入入口 `src/inject/ref.ts`)用它们把 ref 翻译成**稳定 CSS selector**(`genSel`:`lib/genSel.ts` 按优先级 `id > data-testid/test/cy/qa > 语义 data-* > aria-label > 唯一 class > nth-of-type 位置链` 选稳定锚点——锚点命中即停、向上爬到最近稳定祖先在其下补位置链,`matchesEl` 校验精确命中 el 自己;参考 uBlock 屏蔽 B站顶栏只用 `###biliMainHeader`;仅覆盖 light DOM,shadow 内元素 parentElement 在边界为 null 路径断在 host 锚定)。**shadow DOM 元素的 locate/复用闭环**:`inShadow(el)`(`getRootNode() instanceof ShadowRoot`)检测;shadow 内时 `selector` 字段退化为最外层 host 锚定(`outermostHost` 上爬取,document 上有效但只是容器),另生成 `shadowChain`(`buildShadowChain`):`hostSel >>> seg1 >>> seg2`,首段取最外层 host 的 `genSel`(light DOM),之后每段是该层 shadow 根范围内 :nth-of-type 相对链(`shadowScopedChain`,shadow 根直接子 parentElement=null 收口)。`findRoot` 消费该链:按 `>>>` 分段,首段 `document.querySelector`,之后每段在前段元素的 `shadowRoot.querySelector` 逐层穿透——locate 输出 → selector-file 复用闭环。

**fold 折叠规则(取代已删除的 stash)**:Node 侧 `src/folds.ts` 读写持久规则文件 `dist/folds.csv`(与 cdp.js 同级,`__dirname` 定位,便于手动编辑;测试用 `CDP_FOLD_FILE` 覆盖)(**tab 分隔**,selector 含空格故不能用空白分隔,行首 `#` 注释)。格式五列:`<id>\t<域名>\t<path>\t<selector>\t<备注>`——**id 单调递增不重排**(修连续 `rm` 漏删),**域名通配对齐 uBlock**(精确/`*.suffix` 子域/`suffix.*` entity 任意 TLD),**path 为 glob**(`*` 匹配任意含 `/`,空=不限路径;修同域名跨页错位,如 B站首页顶栏规则在视频页误折主内容区)。`parseRules` 只认首列为数字的行,旧格式行跳过(不迁移);`loadFolds/addFold/removeFold/matchFolds(hostOf/pathOf/domainMatch/pathMatch)` 纯函数 + 落盘;`api.view` 按 `hostOf(target.url)`+`pathOf(target.url)` 过滤后把 `{selector, note}[]` 注入 `__CDP_ARG__.folds`(带 path 的规则要求 pathname glob 命中,无 hostname/about:blank 不参与)。会话级临时折叠存页面全局 `__cdpFolds`(`lib/fold.ts` 的 `addTmpFold/clearTmpFolds/listTmpFolds`),刷新清空。注入入口 `src/inject/fold.ts`(临时折叠/list/clear;`--save` 落盘由 Node 侧 `api.fold` 调 `locateExpr` 拿 selector 后写文件,不经此入口)。CLI `fold` 命令已删(DESIGN:规则手动编辑),折叠规则直接写 folds.csv(`<id>\t<域名>\t<path>\t<selector>\t<备注>`)。**fold 不是 stash**:stash 是"藏"(整棵不输出、刷新丢、存元素);fold 是"折叠"(输出一行 `▸ [ref=i] <备注>` 保留 ref 可展开、跨会话持久、基于 selector 规则)。

**lineage 透视(`src/inject/lineage.ts`)**:列目标元素(爬 ancestor 后)从 `<html>` 到自身的祖先链,每层紧凑描述 `tag/id/class(过长截断)/语义 data-*(testid/cy/qa/role/type/component/name/za-module 等)/aria-label/role`,附 `genSel` 建议 selector。设计意图:genSel 已能生成 selector,但有时它选的不是 agent 想要的语义锚点(如挑 `data-v-xxx` 而非更稳的 `#id`)。lineage 把整条链摊开,**决策权交还 agent**——它看清 `#biliMainHeader` 在第 N 层,直接写折叠规则(手动编辑 folds.csv)。与 `locate`(也给 selector)的差别:locate 只回一个 genSel 结果,适合"工具帮我定";lineage 回祖先链全貌,适合"我自己挑"。Node 侧 `api.lineage`/`inject-loader.ts` 的 `lineageExpr`(CLI `lineage` 已删,API 保留待 info 合并)。

**find 命令(`src/inject/find-entry.ts`,类 uBlock `:has-text()` 思想)**:解决"view 输出严禁 grep,但 ref 易失效"的矛盾——按文本/selector 找元素登记新 ref,不必整页重 tree。两种匹配:`--text` 整页 DFS(复用 `view-core` 的 `childrenOf` 穿透 shadow + `ownElText` 取**元素自身直接文本**)搜"**自身直接文本**含关键词"的元素,**深度上限 `MAX_DEPTH=14`** 防深层 shadow 爆炸,**命中即止**(不深入其子,避免父子重复占满结果);`--selector` 走 `findRoot`(支持 `>>>` shadow 链)。**为什么用自身文本而非子树文本(subtreeText)**:子树文本会让最外层容器先命中(body 几乎含所有文本),agent 拿到祖先 div 而非"首页"那个 span/a。uBlock `:has-text()` 是子树匹配(用于折叠容器),这里反过来要找具体元素,故用自身文本。命中元素**追加**进 `__cdpRefs`(`{el, parentRef:null}`,不顶旧 ref),拿 ref 号后 `buildView(el, {viewport:true})` 取根行,把根节点的 `ref` 标成分配号让 `formatView` 自动输出 `[ref=N]`。`--ancestor` 命中后爬父到容器;`--all` 收集全部(默认首个)。入参 `FindCmdArgs{text?,selector?,ancestor?,all?}`(注意区别于操作定位用的 `FindArgs`,后者已占名)。Node 侧 `api.find`/`inject-loader.ts` 的 `findExpr`(CLI `find` 已删,API 保留待 info 合并)。

**操作目标归一化(`src/target-arg.ts`,纯函数零依赖)**:`normArg(a)` 把 click/fill/focus/hover 的目标参数(selector 字符串或 `{ref,ancestor?}` 对象)归一化为注入侧 `{sel?}/{ref?}`。**抽独立模块而非留在 api.ts**:api.ts 顶部 import 一堆运行时模块(transport/monitor/folds),直接 import api.ts 做单测会拽出整条依赖链且源码无扩展名 import 在 `--experimental-strip-types` 下解析失败;独立模块让单测零依赖。**防呆**:字符串匹配 `/^\{[\s\S]*ref[\s\S]*\}$/`(对象字面量当 selector 误用,如 `click "{ref:80}"`)抛友好错误"CLI 用 `--ref N`,脚本 API 才用 `{ref:N}`",不让 `document.querySelector('{ref:80}')` 抛原生 CSS 异常暴露内部栈。`api.ts` re-export `TargetArg` 类型保持外部签名稳定。

## 返回契约(api.ts 的 `invoke`)

Node 侧统一用 `invoke(target, expr)` 执行注入脚本并解包结果:注入脚本成功返回任意值(可含 `{ok:true}`);失败返回 `{ok:false, err}`。`invoke` 统一把 `{ok:false}` 抛成异常,调用方无需各自判 ok。数据类入口(view 等返回裸对象)自然通过。改 api 方法时统一走 `invoke`,别再散落 `r?.ok` 检查。

## 测试

- `tests/*.test.ts` 用 Node 内置 `node:test` + `node:assert/strict`,零运行时依赖。
- 纯函数单测覆盖:`src/inject/lib/view-utils.ts`(inlineLen/inlineable/leafText/firstTxt/isTrivialLeaf)、`src/inject/lib/view-format.ts`(formatView/markText,结构视图折叠内联的纯变换)、`src/inject/lib/genSel.ts`(genSel)、`src/inject/lib/find-root.ts`(refElement/climbAncestors/classifyRef——后者是 recoverRef 的纯判定分支:无登记表→none、越界/槽空→never、已登记→live,用假 entry 模拟)、`src/folds.ts`(parseRules 新格式 5 列/旧格式行跳过不迁移、domainMatch 精确+*.suffix+entity、pathMatch glob、hostOf/pathOf/matchFolds(含 glob 跨页区分)、addFold/removeFold 稳定 id 不重排,用临时 CDP_USER_DATA 验证落盘往返)、`src/target-arg.ts`(normArg 的 `{ref:N}` 字符串误用防呆正则 + 普通 selector/真对象通过)、`src/keys.ts`(parseKeySpec)、`src/transport.ts`(resolveTarget)。
- 注入侧 DOM 相关逻辑(如 view-core 的 buildView/fold 折叠/表单 inputInfo 采集(DOM 采集)、find-entry 的穿透 shadow 文本搜索、feedback 的 observer 装配/顶层新增元素判定/子树黑名单、find.ts 的 recoverRef 沿 parentRef 跳表自愈的 live 分支——命中 `isConnected=true` 触发 buildView)依赖真实 DOM,靠浏览器实测验收(见 SKILL.md 用法),不写单测。纯函数分支(`formatView` 的 `·屏` view 标注/shadow host 占位/fold 优先/`inputAttr` 表单属性串、`feedback` 的 `foldTimestampRun` 时间戳折叠)均有单测锁定。

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