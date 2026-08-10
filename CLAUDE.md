# cdp-browser-control 开发者说明

> 面向**开发者**(维护本 skill 源码的人)。**agent 使用本 skill 时只需要 `SKILL.md`**。
> 运行入口:`node dist/cdp.js`(需先构建)。

## 构建

`dist/` 不提交 git,改源码后重建:

```bash
npm install      # 首次:esbuild/typescript/@types/node/commander(运行时仅 commander)
npm run build    # tsc --noEmit + esbuild(编译 + 打包注入脚本)
npm test         # node:test 跑 tests/*.test.ts(零运行时依赖)
```

产物:
```
dist/cdp.js          入口 bundle(commander+全部 src,自包含,拷走 dist 即可运行)
dist/*.js            其余 Node 侧(api/transport/monitor/browser/inject-loader/keys)
dist/inject/*.js     注入浏览器页面跑的 JS(esbuild 打包成自包含 IIFE)
dist/folds.csv       fold 规则运行时副本(由 src/folds.csv 每次构建覆盖,见「fold 折叠规则」)
```

## 源码结构(两层分离)

| 目录 | 内容 | 运行环境 | 编译 |
|---|---|---|---|
| `src/*.ts` | Node 侧(CDP/CLI/api/纯函数;`folds.ts` 读写 fold 规则) | Node | 入口 `cdp.ts` bundle → `dist/cdp.js`;其余转译 CJS |
| `src/inject/*.ts` | 注入浏览器执行的 JS(入口) | 浏览器(DOM lib) | esbuild bundle 成 IIFE → `dist/inject/` |
| `src/inject/lib/` | 注入侧共享模块 | 浏览器 | 打进各入口 |

依赖单向无环:`transport ← inject-loader/api/folds ← monitor/browser ← cdp`;注入侧同侧 import 也不成环。定位收敛为两套:**ref(前台索引)+ selector(后台匹配)**,xpath 已退役。

## 注入脚本契约(改动注入脚本必读)

注入脚本 esbuild 打包成自包含 IIFE,`Runtime.evaluate` 的 `returnByValue` 取整体完成值。esbuild 会吞掉返回值,故:

1. **结果写入**:写到全局 `globalThis.__cdpResult`(用 `lib/result.ts` 的 `setResult`)。
2. **footer 读取**:`build.mjs` 给每个入口追加 footer `;(async()=>{const r=await globalThis.__cdpResult;delete globalThis.__cdpResult;return r})()`,整体完成值即结果,读完即删。footer 是 async 并 await `__cdpResult`:同步入口传普通值;异步入口(如 `view --scroll-to-load`)可 `setResult(<promise>)`。`Runtime.evaluate` 开 `awaitPromise`。
3. **参数传递**:注入脚本用自由标识符 `__CDP_ARG__`(TS `declare const __CDP_ARG__: XxxArgs`),Node 侧 `inject-loader.ts` 注入前拼 `var __CDP_ARG__ = <json>;`。
4. **入参类型**在 `lib/arg.ts`(FindArgs/FillArgs/ViewArgs(含 FoldItem)/LocateArgs/FindCmdArgs/InfoArgs/ReadArgs/FoldArgs)。

**新增注入入口**:在 `src/inject/` 加顶层 `.ts`,用 `setResult` + 可选 `__CDP_ARG__`,重建自动打包成 `dist/inject/<名>.js`。注入侧跑浏览器,不能用 Node API。

## 注入模块速查

### view-core(buildView)
- `buildView(root,{visibleOnly,viewport,folds})` 被 view/feedback-collect/recoverRef/find-entry 共享。
- **ref 两遍先序登记**:遍一(`simplify`)只建树 + 打标记(`wantRef`/`wantHidden`)+ 暂存 `node.el`,**不登记 `__cdpRefs`**;遍二(`assign`)按先序 DFS 一次性分配 `ref = __cdpRefs.length` + `{el,parentRef}`(parentRef=最近已登记祖先),号随树位置单调增。此前隐藏容器 ref 在递归后 append 到尾部,致结构祖先(html/body/#root)拿到高位号、与树顶位置矛盾(见 info 链);先序后低位、内容号递增。
  - `wantRef`:内容/交互/折叠/shadow 宿主 → 遍二设 `node.ref` 并打印 `[ref=N]`。
  - `wantHidden`:纯包装含内容 → 遍二登记但**不设 `node.ref`**(view 不打印,info 反查可用)。
  - 只追加、不重置:整页 `view` 才从 0 清空;其余只追加(增量号)。
- `viewport:true` 算 `isInViewport` 存 `node.view`,输出 `[ref=i·屏]`/`[ref=i]`。
- **fold 折叠**:持久规则(`folds`,Node 按 hostname 过滤)+会话临时(`__cdpFolds`)合并,`el.matches(selector)` 判定。命中**非根**元素(depth>0)标 `wantRef`、`node.fold=备注`、`kids=[]` 不递归;**根不折叠**(否则 `view <ref>` 展开折叠容器时根本身又被折叠);嵌套折叠自然支持。
- **shadow host 占位**:带 `shadowRoot` 的 Element 无条件标 `wantRef`+`isContent=true`(常无 light 文本)。`view-format.walk` 对 `depth>0 && shadow && ref` 输出 `<tag>[shadow] [ref=N]` 不展开子树,根正常走子树。
- **图标按钮兜底(`elLabel`)**:交互元素无直接文本时 `aria-label → title → 直接文本`。view 显示其功能、article 降级 `[label]`,而非裸 `button [ref=N]`。
- **表单采集**:simplify 对 INPUT/TEXTAREA 设 `inputInfo={type,value,placeholder}`(value 截 40),formatView 输出 `input[type=text value="..." placeholder="..."]`,agent 不必 eval。
- **导出**:`strip`/`ownElText`(元素自身直接文本,locate/find 用它)/`subtreeText`(穿透 shadow,备用)/`childrenOf`(穿透 shadow 取子)/`isInViewport`/`elLabel`/`buildView`。
- **view 默认滚动加载**:`view.ts` 对整页完整 view 首次自动 `scrollToLoad()`(置 `__cdpFullViewDone`,同页只滚一次;局部/`--visible-only`/显式滚动参数不触发),滚动后默认等 `scrollWait`(默认 1000ms,`--scroll-wait 0` 关)渲染才建树。`api.fetchPage` 靠它一次抓全,等待条件="body 有非空文本"。

### feedback
- `startFeedback()` 装 MutationObserver 记 childList 新增+文本变化(前后值);`collectFeedback()` 断开后取**顶层新增元素**逐块 `buildView`,返回 `{blocks, changes}`。
- `feedback-start/collect` 分两次 eval 协作,observer 存全局 `__cdpFeedback`;Node `runWithFeedback` = 动作 + `sleep(feedbackDelay)` + diff tab。`noFeedback` 不观察/不等待/不 diff。
- **refInvalid 短路**:doAction 返回 `{refInvalid:true}` 则跳过 sleep/collect/tabdiff,透传 `recovered`。
- **shadow 穿透**:`observeAll` 递归 document+所有 shadowRoot 各起共享 callback 的 observer(`MAX_SHADOW_DEPTH=3`),动态 host 用 `observeShadowTree` 补装。
- **噪声过滤**:`inIgnoredSubtree` 跳过 VIDEO/AUDIO/CANVAS 子树;`foldTimestampRun`(已加单测)折叠连续 ≥3 条播放时间戳,纯数字计数不折叠(不误杀真信号);`hasAncestorInSet` 穿透 shadow。

### ref 登记表 + 自愈
- view 把内容/交互元素登记进 `window.__cdpRefs`,`[ref=i]` 即下标;表存 **`{el, parentRef}`**(`parentRef`=最近已登记祖先,O(1) 跳表),供失效自愈向上找存活容器。view 重建**先清空再重排**;反馈/自愈/find **只追加**(增量号,不顶旧 ref)。
- 解析在 `lib/find-root.ts`:`refElement`(ref→元素,兼容两种形态)+`climbAncestors`(`--ancestor` 用)。
- **操作成功回显唯一 selector**(优先用 selector 而非 ref):light 用 `genSel`;shadow 内回 `{ok,tag,shadow:true,selector:null}`,CLI 提示"用 ref";超长截断。统一走 `actionSelector(el)`。
- **任何 ref 命令 ref 失效统一自愈**:`find.ts` `notFoundResult`——ref 路径返回 `{ok:false,refInvalid:true,recovered:recoverRef(ref)}`,selector 路径普通 err。`recoverRef` 三态:纯判定 `classifyRef`(`none/never{maxRef}/live{start,maxRef}`);`live` 态沿 `parentRef` 跳表找首个 `isConnected` 祖先,以它为根 `buildView`(增量 ref)返回 `{rootRef,lines}`,整链 detached 返回 null。Node `invoke` 对 `refInvalid` 透传不抛,`runWithFeedback` 短路,`cdp.ts` `printRefInvalid` 打三态。
- **locate**(`inject/ref.ts`)把 ref 翻译成稳定 CSS selector:`genSel` 按 `id > data-testid/test/cy/qa > 语义 data-* > aria-label > 唯一 class > nth-of-type 位置链` 选锚点(命中即停、向上补位置链,`matchesEl` 校验,仅 light DOM)。
- **shadow locate/复用闭环**:`inShadow` 检测;shadow 内 selector 退化最外层 host 锚定,另生成 `shadowChain`(`hostSel >>> seg1 >>> seg2`);`findRoot` 按 `>>>` 分段逐层 `shadowRoot.querySelector` 穿透——locate 输出 → selector-file 复用。

### fold 折叠规则(取代已删 stash)
- Node `src/folds.ts` 读写 `dist/folds.csv`(与 cdp.js 同级,`__dirname` 定位;测试 `CDP_FOLD_FILE` 覆盖)。tab 分隔(selector 含空格),行首 `#` 注释。
- **改 fold 规则改 `src/folds.csv`**:每次构建强制覆盖到 dist,`src/folds.csv` 是唯一权威副本,dist 只是产物。
- 五列:`<id>\t<域名>\t<path>\t<selector>\t<备注>`;id 单调递增不重排;域名通配对齐 uBlock(精确/`*.suffix`/`suffix.*`);path 为 glob(`*` 含 `/`,空=不限,修同域名跨页错位)。`parseRules` 只认首列为数字的行,旧格式跳过。
- `loadFolds/addFold/removeFold/matchFolds(hostOf/pathOf/domainMatch/pathMatch)` 纯函数+落盘;`api.view` 按 hostOf+pathOf 过滤注入 `__CDP_ARG__.folds`。
- 会话临时折叠存页面全局 `__cdpFolds`(`lib/fold.ts`),刷新清空。注入入口 `inject/fold.ts`(临时折叠/list/clear);`--save` 落盘由 Node `api.fold` 调 `locateExpr`。
- **fold ≠ stash**:stash 是"藏"(整棵不输出、刷新丢);fold 是"折叠"(一行 `▸ [ref=i] <备注>` 保留 ref 可展开、跨会话持久、基于 selector 规则)。

### info(原 lineage)
`inject/info.ts` 列目标从 `<html>` 到自身的祖先链,每层紧凑描述 `tag/id/class/语义 data-*/aria-label/role` + `genSel` 建议。设计意图:genSel 有时挑的锚点不是 agent 要的语义锚点,info 把整条链摊开**决策权交还 agent**(看清 `#biliMainHeader` 在第 N 层直接写 fold 规则)。与 locate 差别:locate 回一个 genSel(工具帮我定);info 回祖先链全貌(我自己挑)。**CLI 命令 `info <n> [--ancestor <k>]`(对应 DESIGN.md 的 info 条目),`api.info(target, ref, ancestor?)` 供脚本用**;`cdp.ts` `printInfoChain` 负责格式化输出。

### article
`inject/article.ts` 以 ref 为根提取**格式友好的 Markdown 文章**。**不用 buildView**:其 simplify 把内联子元素(<a>/<b>)拆成独立子节点、丢失句子内顺序,对文章致命。故**专用保序 DOM 遍历**——沿 `childNodes` 逐节点(Text 节点 + 元素)发 Markdown:标题 `#`、段落空行分隔、链接 `[文本](href)`、粗斜 `**`/`*`、代码 `\`\`\``、列表 `-`/`1.`、引用 `>`、图片 `![alt](src)`;无文本交互元素降级 `[label]`(复用 `elLabel`);`BLOCK_TAGS` 遇块即停交 `walkEl` 单独成块。**不截断**:直接读完整文本。`ArticleArgs{ref,ancestor?}`。注:仅遍历 light childNodes,shadow 文章暂不穿透(知乎/B站正文为 light DOM,够用)。

### find
`inject/find-entry.ts`(类 uBlock `:has-text()`)解决"view 严禁 grep、ref 易失效"——按文本/selector 找元素登记新 ref,不必整页重 tree。`--text` 整页 DFS(`childrenOf` 穿透 shadow + `ownElText` 取**自身直接文本**)搜关键词,深度上限 `MAX_DEPTH=14`,命中即止。**为何用自身文本而非 subtreeText**:子树文本让最外层容器先命中(body 几乎含所有文本)。命中元素追加进 `__cdpRefs`(`{el,parentRef:null}`),`buildView(el,{viewport:true})` 取根行标 ref。`--ancestor` 爬父;`--all` 收集全部。`FindCmdArgs{text?,selector?,ancestor?,all?}`。

### target-arg
`src/target-arg.ts`(纯函数零依赖)`normArg(a)` 把 click/fill/focus/hover 目标(selector 字符串或 `{ref,ancestor?}` 对象)归一化为 `{sel?}/{ref?}`。**抽独立模块**:api.ts 顶部 import 一堆运行时模块,直接 import 做单测会拽出整条依赖链且无扩展名 import 在 `--experimental-strip-types` 下解析失败。**防呆**:字符串 `/^\{[\s\S]*ref[\s\S]*\}$/`(对象字面量当 selector 误用)抛"CLI 直接传数字,脚本 API 才用 `{ref:N}`"。

## 返回契约(api.ts 的 `invoke`)

Node 侧统一 `invoke(target, expr)` 执行注入脚本并解包:成功返回任意值(可含 `{ok:true}`),失败返回 `{ok:false, err}`;`invoke` 统一把 `{ok:false}` 抛成异常,调用方无需各自判 ok。数据类入口(view 等裸对象)自然通过。改 api 方法统一走 `invoke`,别散落 `r?.ok`。

## 测试

- `tests/*.test.ts` 用 Node 内置 `node:test`+`node:assert/strict`,零运行时依赖。
- 纯函数单测:`view-utils.ts`、`view-format.ts`(formatView/markText)、`genSel.ts`、`find-root.ts`(refElement/climbAncestors/classifyRef)、`folds.ts`(parseRules/domainMatch/pathMatch/matchFolds/addFold/removeFold,临时 CDP_FOLD_FILE 验证落盘往返)、`target-arg.ts`(normArg 防呆)、`keys.ts`(parseKeySpec)、`transport.ts`(resolveTarget)。
- 注入侧 DOM 相关(buildView/fold/inputInfo、find-entry 穿透 shadow、feedback observer/子树黑名单、recoverRef live 分支)依赖真实 DOM,靠浏览器实测(见 SKILL.md),不写单测。纯函数分支(`formatView` 的 `·屏`/shadow 占位/fold 优先/`inputAttr`、`feedback` 的 `foldTimestampRun`)有单测。

## 文档分工

- `SKILL.md`:面向 **agent**,只讲怎么调 `dist/cdp.js`,不含构建/源码结构。
- `CLAUDE.md`(本文件):面向 **开发者**,含构建、源码结构、注入契约、测试。
- `docs/superpowers/specs/`:设计文档。


---

以上为 Agent 自动生成，从此以下为用户所写。

上面的所有约定仅表示开发的历史路径，不代表未来约束。

重构、加新功能，在新的 branch 做，以迭代的方式分阶段提交，最后 merge 到 main。

这个项目是为服务 Agent 更好地读网页写的，一切以服务 Agent 为目标，所有的不合理通通可被扔，一切的重构要激进，要以最优为先，无需背负兼容性顾虑。

临时路径用项目根目录里的 `./tmp`
