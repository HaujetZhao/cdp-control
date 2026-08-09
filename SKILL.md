---
name: cdp-browser-control
description: 需要控制本地浏览器时使用——列出 tab、打开/关闭/导航页面、提取页面元素、点击、填表、执行 JS、截图,**读页面控制台日志(含嵌套对象与调用链,支持过滤)**。做自动化时,优先把整个操作写成脚本文件用 `run` 一次执行,避免分步调用。**核心模型:tree 感知页面(整页 body 的文本+结构紧凑树,生成可操作的 ref),ref 是操作索引(会话句柄),selector 是后台匹配(刷新后兜底)。** `tree --ref <n> --ancestor <k>` 查看局部;`locate <ref>` 从 ref 反查 selector 用作刷新后定位。遇到首屏外内容没加载(如评论区),用 `tree --scroll-to-load` 先滚动触发懒加载再建树。**任何用 ref 的命令(click/fill/focus/hover/locate/fold)ref 失效都自动自愈**——沿祖先链 tree 最近存活容器给你新 ref;打错号(从未存在)直接报、不误导成"页面刷新";整链失效才提示重新 tree。长页噪声用 `fold`(类 uBlock 的持久折叠规则:域名+selector+备注)把顶栏/导航等折叠成一行,跨会话生效。
---

# CDP 浏览器控制 (cdp-browser-control)

## Overview

本 Skill 所在目录有一个零依赖 Node 脚本 `dist/cdp.js` ,可直接连 Chrome/Edge 的 CDP 端口(默认 9222),取代 chrome-devtools MCP。核心价值:**能看到并操作手动打开的 tab**(MCP 因 Puppeteer attach 竞态会漏看)。

## 核心模型(三件事)

1. **tree = 感知**:整页 body 建为紧凑树(文本+结构),给每个可操作元素标 `[ref=i]`。**首次看页面必须完整 `tree`**(别 `| head` 截断,别 `--visible-only`)。
2. **ref = 操作索引**:会话句柄,存 `window.__cdpRefs`,刷新失效、每次 tree 重排。操作一律优先 `--ref i`(穿透 shadow)。**ref 失效自动自愈**(任何 ref 命令,见下)。
3. **selector = 后台匹配**:刷新后 ref 失效,用 `locate <ref>` 把 ref 翻译成 selector 喂回 `tree --selector-file` 复用。

重要原则:
- `list` 自动确保浏览器就绪(CDP 未起则启动)并列出 tab,无需先 `ensure` 再 `list`。
- 打开页面后,优先 `tree` 感知整页拿 ref;**tree 输出严禁用 head/sed/grep 过滤**,局部只能用 `--ref/--ancestor/--selector-file/--visible-only`。
- selector 只能用 `locate <ref>` 获取,**严禁 JS eval 探查 DOM**(从 tree 已有的 ref 出发定位,别摸原始 HTML)。
- 多步交互优先写成 `.js` 脚本,用 `node "<本 SKILL 所在目录>/dist/cdp.js" run 脚本.js` 一次执行,省模型 API 往返。

## When to Use

- 读/操作浏览器里已手动打开的页面(知乎、财联社这种 tab),用 `tree` 感知。
- 多步自动化(填表、爬取、提交)——**写脚本文件 + run** 首选,省往返、可复用、易改。

## 调用前唯一入口:`ensure`

```bash
node "<本 SKILL 所在目录>/dist/cdp.js" ensure          # 确保浏览器已通过 CDP 就绪(不导航)
node "<本 SKILL 所在目录>/dist/cdp.js" ensure --url "<网页地址>"   # 开浏览器并直接打开该页
```

`ensure` 内部自动:1) 检查 CDP 端口(默认 9222)是否就绪——已就绪直接继续;2) 没就绪 → 自动探测默认浏览器(优先 Edge,其次 Chrome);3) 用**独立用户数据目录**启动(默认 `~/.cdp-browser`,环境变量 `CDP_USER_DATA` 覆盖);4) 轮询等待 ready(最多 ~15s),给了 `--url` 则打开。**冷启动**(本次由 ensure 启动)复用首个空白 tab 导航;**热启动**(已就绪)新开 tab。

## 脚本调用方式

```bash
node "<本 SKILL 所在目录>/dist/cdp.js" <子命令> [参数]
node "<本 SKILL 所在目录>/dist/cdp.js" run "./scripts/你的脚本.js"   # 在项目根执行自动化脚本
```

## 脚本放置规范

写到**当前项目的根目录**(或项目内 `scripts`/`tmp`),**不写进 skill 目录**;运行用 **`dist/cdp.js` 绝对路径**,在项目根执行:

```bash
node "<本 SKILL 所在目录>/dist/cdp.js" run "./scripts/项目里的脚本.js"
```

- **为什么**:`run` 的脚本读取与输出(截图等)都以 `cwd` 为基准。在项目根运行 → 输出落项目根,**skill 目录保持干净**。
- **绝对路径调 dist/cdp.js**:别 `cd` 进 skill 目录再跑(cwd 会变 skill 目录)。
- **脚本环境**:`run` 里只有全局 `cdp` + **白名单 `require`**(`os`/`path`/`fs`/`child_process`/`crypto`/`util`/`stream`/`url`)。临时路径用 `path.join(os.tmpdir(), name)`,**勿直接用 `/tmp/xx` 前缀**(Windows 被 `path.resolve` 解析成盘根而 ENOENT)。

## 感知页面

`tree`:将整页以 **缩进+折叠** 输出紧凑树,以节省 Token 的方式包含结构+文本+Ref。

**参数**:

| 参数 | 作用 |
|---|---|
| (默认) | 整页 |
| `--selector-file <f>` | 筛选指定区域(刷新后用 locate 得到的 selector 复用) |
| `--ref <n>` | 以某 ref 的元素为树根(与 --selector-file 互斥) |
| `--ancestor <k>` | 从锚点(任意)向上爬 k 层父级再建树;多与 --ref 配合把"内容叶子"抬到"区域容器" |
| `--visible-only` | 筛选当前视口内可见元素(**仅"看当前屏上有啥",绝不做首次整页感知**) |
| `--scroll-to-load` | 滚动触发懒加载(评论区等首屏外内容)再建树。默认向下/向上各一屏后回原位(**只移动 ±1 屏不会拉飞视口**);配合下方两参数可滚更远 |
| `--scroll-pages <n>` | 与 `--scroll-to-load` 配合:循环向下滚 N 屏(每屏等 innerHeight + 150ms 间隔),边滚边检测 `scrollHeight` 增长,**连续 2 次不增长提前停**。用于无限流(持续滚+等加载)。**注意**:知乎等"用户主动滚动"反爬站点即便分步滚也可能触发不了,是站点反爬不是工具 bug |
| `--scroll-to <selector>` | 与 `--scroll-to-load` 配合:先滚到匹配该 selector 的元素(B站评论区 `#bili-comments` 等),停下让懒加载触发,**命中不到优雅降级**(跳过该步、正常建树)。这是 `--scroll-to` 的主战场——比 `--scroll-pages` 精准 |

**铁律(首次感知 = 完整 tree,禁 `--visible-only`)**:
- 第一次看页面必须完整 `tree`(看全部内容,别 `| head` 截断,别 `--visible-only`)。`--visible-only` 只输出当前视口内元素——视口外的回答、评论区等**被整段漏掉**,让你以为页面只有首屏那么点(曾因只看可见区域找不到第 2 个回答)。
- 完整 `tree` 把整页(含视口外)文本+结构+ref 一次给全;`--visible-only` 只在"专门确认当前屏幕可见区域"时用。

**定位 = 从已有的 tree 出发,别 JS 探查(最重要)**:
- 你已看过整页 tree,**层级、内容、ref 全在眼前**,不需要再猜结构。要定位区域/元素,一律从 tree 里已有的 ref 出发,不要 `eval` JS 摸原始 DOM——那是浪费轮次的弯路。
- 已带 `[ref]` 直接 ref 操作;要把"内容叶子"抬到"区域容器",用 `--ancestor k`(k 不确定就逐个试 `--ancestor 1/2/3...`,每次 tree 成本低、结果直观)。

**易错**:
- selector 一律从文件读(Git Bash 会把行首特殊字符改掉)。
- `eval` 里 `(() => ({...}))()` 会返回空对象——箭头+对象字面量需显式 `return` 或写 `(function(){ return {...}; })()`。

**操作(ref)**:
- 整页 tree 里 `[shadow]` 占位行(如 `bili-comments[shadow] [ref=N]`)是 Web Component 容器——内容在 shadow DOM,整页 tree 只占位不深入。**看它的内容用 `tree --ref N`**(展开 shadow 子树);首屏没加载(评论区空壳)则 `tree --ref N --scroll-to-load` 滚动触发。CSS 穿不透 shadow,操作这类块一律用 ref。
- 操作优先 `[ref=i]`(`click --ref i`,零 selector,shadow 内也能定位)。
- ref 是会话句柄:存 `window.__cdpRefs`,页面刷新失效,每次 tree 重建。**每回合先 tree 拿 ref 再操作**,刷新/动态加载后序号漂移是预期。

**区域定位(想 tree 一块"语义区域"而不是单个叶子)**:
- **同会话立即看**:`tree --ref <n> --ancestor <k>`——拿区域内任一内容叶子的 ref,向上爬 k 层到容器直接建树。
- **刷新后仍可用(更常用)**:`locate <n> [--ancestor <k>]` 把 ref 翻译成**稳定 CSS selector**,写进文件后 `tree --selector-file` 复用。ref 刷新即失效,locate 得到的 selector 不依赖 ref、刷新后照样局部 tree:
  ```
  tree --target ...            # 1. 看整页,记下区域里某个内容叶子的 ref(如 [ref=53])
  cdp locate 53 --ancestor 4   # 2. 反查该区域容器的 selector(直接贴出来)
  cdp tree --selector-file f   # 3. 刷新后,把 selector 写入 f,照样定位这块区域
  ```
  selector 是 id 锚定 + `:nth-of-type` 链,可读、较稳。若页面改版后定位器失效,重新 `tree` 拿 ref 再 `locate` 一次即可。
- **shadow DOM 元素的 locate**:目标在 shadow 内时,标准 CSS selector 在 document 上查不到(`querySelector` 返 null)。locate 会检测到并改输出 `shadow 链:hostSel >>> innerSel >>> ...`(`>>>` 是本工具自定义的 shadow 穿透符),把这条链写进 selector-file,`tree --selector-file` 能分段穿透 shadowRoot 命中。操作(点击/填值)则继续用 `--ref`(操作命令穿透 shadow)。
- **多块布局**(如知乎 Q&A 是"问题块 + 回答列"两个兄弟块、**没有共同容器**):别找"能一网打尽的容器"(不存在)——分块各做一次 ref+ancestor,或各自 `locate`,再并列看。别因此绕回 JS 探查。

**整页 tree 去噪(`lineage` 透视 + `fold` 持久规则,类 uBlock Origin)**:长页(知乎问题页、评论区)整页 tree 常混入导航头/推荐/广告等大量噪声 ref。用 `fold` 把这些区域**折叠成一行**(输出 `▸ [ref=i] <备注>`,不展开子树但保留 ref),跨会话持久——下次打开同站点自动折叠。

**主路径:lineage 看祖先链挑稳定锚点 → fold add 写 uBlock 式短规则**。`fold --ref --save` 让工具用 genSel 猜一个 selector,但有时你想要更短更稳的语义锚点(如 `#biliMainHeader` 而非某个 `data-v-xxx`)。`lineage` 把目标元素从 `<html>` 到自身的祖先链摊开,每层紧凑列出 tag/id/class/语义 data-*/aria/role,你一眼挑出最稳的层手写规则:
```
cdp tree --target ...                       # 1. 看整页,记下噪声区域里某个内容叶子的 ref(如顶栏 logo [ref=0])
cdp lineage 0 --ancestor 3 --target ...     # 2. 列祖先链,挑稳定锚点(如 #biliMainHeader)——比 genSel 猜的更可控
cdp fold add www.bilibili.com #biliMainHeader 顶栏 --path /video --target ...  # 3. 手写持久规则(uBlock 式短 selector)
cdp tree --target ...                       # 4. 整页 tree 顶栏折叠成 ▸ [ref=0] 顶栏
cdp fold list --target ...                  # 5. 列持久 + 会话级临时折叠规则(带 id + path 列)
cdp fold rm <id> --target ...               # 6. 删持久规则(按 id,其它 id 不重排)
```
- **`lineage <n> [--ancestor <k>]`**:输出祖先链缩进树(html 在顶,目标元素在最深并标 `[ref=N]`),末尾附 genSel 的建议 selector 作参考。挑锚点优先级:id > 测试锚点(data-testid 等)> 语义 data-* > aria-label/role > 唯一 class。
- **持久规则**存在 `$CDP_USER_DATA/folds.txt`(默认 `~/.cdp-browser/`),五列 tab:`<id>\t<域名>\t<selector>\t<备注>[\t<pathPrefix>]`。域名支持精确(`www.bilibili.com`)与通配(`*.zhihu.com`)。
  - **id 稳定**:`addFold` 用 max(id)+1 单调递增,`rm <id>` 删后**其它 id 不重排**(连续 rm 不漏删)。旧三列格式文件读时自动迁移补 id。
  - **`--path <前缀>` 限定页面路径**(借鉴 uBlock `:matches-path`):同域名不同页(B站首页 vs 视频页、知乎首页 vs 回答页)DOM 结构不同,只按域名存的规则会在别的页命中错位元素。加 `--path /video` 后该规则只在 pathname 以 `/video` 开头的页命中。无 `--path` 的规则不限路径。
  - 也可从 ref 落盘:`fold --ref <n> [备注] --save [--path <前缀>]`(用 genSel 推 selector + 当前 hostname);或 `fold add <域名> <selector> <备注> [--path <前缀>]` 手写。
- **会话级临时折叠**:`fold --ref i [备注]`(不带 `--save`),只本次会话生效、刷新清空。
- **展开折叠区域**:`tree --ref <折叠容器的 ref>` 就是普通局部 tree。**嵌套天然支持**:展开顶栏后,里面命中的子折叠规则(如搜索区)仍是折叠态。
- `fold` 取代了旧的 `stash`(stash 已删除)。

## 操作后自动反馈(click/fill/focus/hover/press-key 默认开启)

每次操作后自动等约 1s(给异步/懒加载内容出现留时间),然后回报 **页面新增内容 tree + tab 变化**,一轮拿到结果,不必再手动 `tree`/`list` 补查:

- **内容反馈**:CLI 分块换行输出(内容 2 空格缩进)——`页面变化 · 新增内容:`(重复块折叠标 `(重复 N 次,已折叠)`)、`页面变化 · 文本变化:`(逐条 `旧 → 新`,过滤前后相同)。**文本变化报前后值**(点赞后数字 583→584 直接可见);点"显示评论"后评论进来,反馈里直接看得到。操作行同一行附 `，该元素的 selector 为: <唯一selector>`,后续对该元素操作优先用 selector 而非 ref,避免 ref 重渲染失效。
- **tab 变化**:操作前后 diff `/json/list`。点 `target=_blank` 链接新开 tab 后,反馈直接告诉你 `新开 tab: <title> <url> [<targetId>]`,直接 `tree --target <targetId>` 继续,不必先 `list`。
- **`--no-feedback`**:关闭(不等待、不观察、不 diff tab),高频操作想快时用。
- **`--feedback-delay <ms>`**:自定义等待时长,默认 1000。
- **反馈树 ref 是增量号,不顶掉旧 ref**:反馈新增内容里的 `[ref]` 从当前已有号继续递增(整页 tree 才从 0 重置)。反馈后既可用反馈树的增量 ref 操作新增内容(如点刚加载的"显示更多"),**原整页 ref 依旧有效**。注意:增量 ref 适合即时 `click`/`fill`;要 `tree --ref` 局部回看/`locate` 反查稳定定位器时,请先用整页 `tree` 重建 ref。
- 脚本 API:`cdp.click(target, arg, { noFeedback?, feedbackDelay? })` → 返回 `{ok, tag, feedback:{lines, summary, tabs:{opened, closed}}}`(见下方脚本表)。

## ref 失效自动自愈(所有 ref 命令)

任何用 `--ref` 的命令——`click`/`fill`/`focus`/`hover`/`locate`/`fold`——遇到 ref 失效都**自动自愈**,你不用猜容器:

- **失效但祖先还活着**:沿 ref 的 `parentRef` 链向上找最近一个仍 connected 的容器,以它为根局部 tree,直接回报更新后的内容 + 新 ref,提示你用新 ref 重试。你**不需要**判断"该 tree 哪个更高层级的容器"——工具定位到最近存活祖先。
- **打错号(从未存在)**:ref 越界或登记表里没这个槽,工具直接报 `ref=N 从未存在(当前最大 ref=M),检查 ref 号`——**不**走自愈、**不**误导成"页面刷新"(避免你白去 reload)。
- **整链失效(页面刷新/重建)**:祖先链全部 detached,才提示`整条祖先链均已失效,请重新 tree 拿新 ref`。

> 三态由注入侧统一返回(`{ok:false, refInvalid:true, recovered:{never|rootRef,lines|null}}`),CLI 共享同一套打印,click 系与 locate/fold 行为一致。

## Quick Reference

所有命令可选 `--target <匹配>`(target id 或 url/title 子串;不传则自动选第一个普通网页)。每个命令支持 `--help`/`-h`;命令名统一 **kebab-case**。

| 子命令 | 作用 |
|---|---|
| `ensure [--url <url>]` | 确保浏览器已打开(自动探测 Edge/Chrome 启动 CDP),可选 --url 直接导航 |
| `list` | 确保浏览器就绪(CDP 未起自动启动)并列出所有 page tab,先报 tab 总数 |
| `open <url>` | 新开一个 tab,返回 targetId |
| `close <target>` | 关闭 tab |
| `navigate <url> [--target]` | 导航 |
| `eval "<js>" [--target]` | 执行 JS,返回 returnByValue 的值 |
| `tree [--target] [--ref <n>] [--ancestor <k>] [--selector-file <file>] [--visible-only] [--scroll-to-load [--scroll-pages <n>] [--scroll-to <selector>]]` | 整页 body 的文本+结构紧凑层级树。**首次感知必须用完整 tree(无 --visible-only/不截断),否则视口外的回答/评论区被整段漏掉**。锚点互斥:--ref 优先,其次 --selector-file,缺省 body;--ancestor 统一向上爬 k 层;--scroll-to-load 滚动触发懒加载再建树(默认下+上各一屏回弹;--scroll-pages 改为循环滚 N 屏带增长检测;--scroll-to 先滚到指定 selector 元素如 `#bili-comments`,命中不到降级)。命中 fold 折叠规则的容器输出 `▸ [ref=i] <备注>`。带 ref 节点在视区标 `[ref=i·屏]`,否则 `[ref=i]` |
| `locate <n> [--ancestor <k>] [--target]` | 从 tree 的 ref 序号**反查稳定 CSS selector**。ref 是会话句柄,刷新后失效;locate 把它翻译成刷新后仍可用的 selector,供 `tree --selector-file` 复用(可选 --ancestor 把叶子抬到区域容器)。目标在 **shadow DOM** 内时改输出 `hostSel >>> innerSel >>> ...` 穿透链(标准 CSS 穿不透 shadow),写进 selector-file 仍可复用 |
| `lineage <n> [--ancestor <k>] [--target]` | 列目标元素(爬 ancestor 后)从 html 到自身的**祖先链**:每层 tag/id/class/语义 data-* /aria/role,末尾附 genSel 建议 selector。挑稳定锚点手写 `fold add` 这种 uBlock 式短规则(如 `#biliMainHeader`),比 `fold --ref --save` 让工具猜更可控 |
| `fold add <域名> <selector> <备注> [--path <前缀>]` / `fold list` / `fold rm <id>` / `fold --ref <n> [备注] [--ancestor <k>] [--save] [--domain <d>] [--path <前缀>] [--target]` | **类 uBlock 折叠规则**:持久规则存 `$CDP_USER_DATA/folds.txt`(五列:id/域名/selector/备注/pathPrefix),tree 时命中区域折叠成一行 ▸,跨会话自动生效。`add`/`--ref --save` 落盘;`--path` 限定页面 pathname 前缀(修同域名跨页错位);`rm <id>` 按 id 删(其它 id 不重排,连续 rm 不漏删);`list` 列持久+临时。展开用 `tree --ref <折叠容器 ref>` |
| `click <selector> [--ref <n>] [--ancestor <k>] [--no-feedback] [--feedback-delay <ms>] [--target]` | 点击元素(selector 或 `--ref i`,穿透 shadow;--ancestor 定位后爬父)。默认带操作后反馈 |
| `fill <selector> <值> [--ref <n>] [--ancestor <k>] [--no-feedback] [--feedback-delay <ms>] [--target]` | 填输入框并派发 input/change。默认带操作后反馈 |
| `focus <selector> [--ref <n>] [--ancestor <k>] [--no-feedback] [--feedback-delay <ms>] [--target]` | 聚焦元素(配合按键用)。默认带操作后反馈 |
| `get-focus [--target]` | 查看当前焦点元素在哪 |
| `press-key <键> [--no-feedback] [--feedback-delay <ms>] [--target]` | 真实按键/组合键,如 `Enter`、`Tab`、`Ctrl+Shift+A`(含滚动如 PageDown,反馈懒加载内容)。默认带操作后反馈 |
| `hover <selector> [--ref <n>] [--ancestor <k>] [--no-feedback] [--feedback-delay <ms>] [--target]` | 鼠标移到元素上(触发 mouseover/mouseenter)。默认带操作后反馈 |
| `shot [--file out.png] [--target]` | 截图 |
| `logs [--target] [--level error,warn] [--since <ms>] [--json]` | 读 target 控制台日志(见下方「读控制台日志」) |
| `run <脚本文件>` | 执行自动化脚本(脚本里用全局 `cdp` API,可顶层 `await`) |

环境变量:`CDP_HOST` / `CDP_PORT`(默认 `127.0.0.1:9222`)、`CDP_LOGS_PORT`(监听 daemon 端口,默认 9333)、`CDP_USER_DATA`(浏览器用户数据目录 + fold 规则文件位置,默认 `~/.cdp-browser`)。

## 命令示例(真实流程)

> 以下 `cdp` 均指 `node "<本 SKILL 所在目录>/dist/cdp.js"`。真实流程照"打开→感知→点击→**核对落点/结果**"走。**别把 `tree` 输出丢给 `head`/`sed`/`grep` 过滤**,看局部只能用 `tree --ref/--ancestor/--selector-file/--visible-only`。**CLI 用 `--ref n`,脚本 API 才用 `{ref:n}`**——`cdp click "{ref:44}"` 会报"不是合法 selector"。

### 逛页面 + 定位区域 + 去噪
```bash
cdp open "https://www.zhihu.com/"     # 开页
cdp tree --target zhihu               # 看整页,拿 ref(别 head/sed 截断)
cdp lineage 1 --ancestor 4 --target zhihu      # 列顶栏祖先链,挑稳定锚点(如 .AppHeader)
cdp fold add www.zhihu.com .AppHeader 知乎顶栏 --target zhihu   # 手写持久规则(uBlock 式短 selector)
cdp tree --target zhihu               # 顶栏折叠成 ▸ 一行,树干净
cdp tree --ref 53 --ancestor 4 --target zhihu   # 从内容叶子 ref 爬到区域容器,只列问题+回答
cdp locate 53 --ancestor 4 --target zhihu       # 要刷新后仍可用的 selector
cdp tree --selector-file ./f --target zhihu     # 用 selector 局部复看
```

### 点击可能开新 tab → 反馈自动报落点
```bash
cdp click --ref 44 --target zhihu    # 点卡片/链接;反馈直接报"新开 tab: <title> <url>"(target=_blank 落点)
cdp tree --target "BV1..."           # 按反馈给的 tab 直接继续
```

### 改状态的操作(点赞/关注/提交)→ 反馈自动复看
```bash
cdp tree --target "BV1..."           # 先看整页拿 ref
cdp click --ref 36 --target "BV1..."  # 点赞;反馈直接回文本变化(如 "42→43"),别只靠"无报错"当成功
```

## 读控制台日志(console 监听)

`dist/cdp.js` 用**常驻 daemon 给每个页面注入监控脚本**,把日志存进页面的 `window.__cdpLogs`,`logs` 命令再 eval 读出来——**保留对象的嵌套结构和调用链**(不是拍平的文本)。核心价值:抓到**用户手动操作期间**打出的日志、跨多次命令/agent 回合累计、**刷新页面后监控自动补装**、支持过滤。

原理:直接监听 CDP 控制台事件只拿到描述文本,看不到对象嵌套。所以往页面注入 `console.*`/`onerror`/`unhandledrejection` 钩子,把**活的嵌套对象 + 调用链(stack)** 存进 `window.__cdpLogs`,读时结构化序列化。关键机制是 `Page.addScriptToEvaluateOnNewDocument`——注册在该 tab 会话上,**每次 document 创建(含刷新)自动先跑监控脚本**。

- **自动装监听**:`open` / `ensure --url` 打开页面时自动拉起 daemon,它轮询 `/json/list` 给**每个** tab(含手动开的)注册监控脚本。
- **读**:`node dist/cdp.js logs [--target <匹配>] [--level error,warn] [--since <ms>] [--json]`
  - `--level` 逗号分隔按级别过滤(`debug/log/info/warn/error`);未捕获异常归 `error`。
  - `--since <毫秒时间戳>` 只取该时间点之后。
  - 默认人类可读 `[HH:MM:SS][level] args`;`--json` 输出完整结构(嵌套对象 + `stack` 调用链)。
  - **读时自动补种**:`logs` 本身也会幂等注入监控脚本(防 daemon 未及装)。
- **无需手动管理**:监听 daemon 由 `open`/`ensure`/`logs` **自动拉起**(隐藏 `__daemon` 入口,无 `listen`/`listen-stop`)。daemon 端口 `CDP_LOGS_PORT`(默认 9333)。
- **生命周期**:daemon 在**浏览器关闭后约 5s 自动退出**(看门狗),不留孤儿进程。
- **脚本模式**:`cdp.logs(target, {level, since})` → 返回结构化日志数组,可与 `cdp.click`/`cdp.waitForFn` 配合做"跑完流程断言无报错"。

**已知限制**:
- `window.__cdpLogs` 在页面刷新后**清空**(缓冲在页面里,新 document 从头开始);监控脚本会自动补装,但历史没了。
- **首屏/加载早期的日志可能错过**:daemon 靠轮询注入,页面刚打开的几毫秒内已打的日志在注入前就跑了。agent 打开页→操作→读的场景不受影响。
- **刚 `open` 的新 tab,立即打日志再 `logs` 读会读到空**:daemon 每 ~500ms 轮询,新 tab 打开后需 **~0.5–2s 才装上监控**;开 tab 后**先 `await sleep(1500)` 再操作/读日志**。

## 自动化工作流(推荐)

**先探后写、写成文件、一次执行**——避免多次模型往返:

1. **探明页面**:不知道元素时,先 `node dist/cdp.js list`(看 tab)+ `node dist/cdp.js tree --target <匹配>`(感知整页结构);要操作再 `cdp locate <ref>` 反查目标元素的稳定 selector。
2. **写脚本文件**:把整段操作写成一个 `.js` 放到**项目根**(见上方"脚本放置规范"),用全局 `cdp` API。
3. **执行**:在项目根用绝对路径运行 `node "<本 SKILL 所在目录>/dist/cdp.js" run ./你的脚本.js`。出错改文件再跑;截图等输出直接落项目根。

脚本示例(等价于多个单命令调用,但只发一次模型请求):

```js
// ⚠️ open 返回字符串 targetId,其余方法都要 **target 对象**。open 之后总要 resolve 一次拿对象再往下传。
const tid = await cdp.open('about:blank');      // 返回字符串 targetId
const t = await cdp.resolve(tid);                // 用 id/url/title 子串 → 返回 target 对象
await cdp.eval(t, `document.body.innerHTML='<input id=box><button id=btn>go</button>';'ok'`);
await cdp.waitFor(t, '#btn');                    // 等元素出现
await cdp.fill(t, '#box', '值');
await cdp.click(t, '#btn');
console.log(await cdp.eval(t, 'document.title'));
await cdp.shot(t, 'out.png');
await cdp.close(t);
```

> **target 对象**是绝大多数方法的第一个参数,来自 `cdp.resolve(子串)`;若已有手动打开的页面,直接 `const t = await cdp.resolve('5173')`(url/title 子串)拿对象。

### 脚本模式 API

脚本顶层可直接 `await`;全局 `cdp` 提供:

**句柄类型约定(重要):**
- `open` **返回字符串 `targetId`**;其余方法第一个参数 **`target` 一律是对象**(来自 `resolve`)。**不要用字符串 id 直接调方法**。
- `resolve(匹配)` 匹配可为 targetId / url / title 子串;`undefined` 取第一个普通网页。

| API | 参数 | 返回 |
|---|---|---|
| `cdp.ensure(url?)` | 字符串 url 可选 | 浏览器就绪(自动启动) |
| `cdp.list()` | — | `[{id,title,url,...}]` |
| `cdp.resolve(匹配?)` | id/url/title 子串,可省略 | `target` 对象 |
| `cdp.open(url)` | 字符串 | 字符串 `targetId`(⚠️ 非对象) |
| `cdp.close(target)` | 对象 | — |
| `cdp.navigate(target, url)` | 对象,字符串 | — |
| `cdp.eval(target, js, timeout?)` | 对象,字符串 | `returnByValue` 值 |
| `cdp.tree(target, opts?)` | 对象,`{selector?,ref?,ancestor?}` | 整页 body 文本+结构紧凑树:`{ok, lines}`;锚点互斥:ref 优先,其次 selector,缺省 body;`opts.ancestor` 统一向上爬 k 层;命中 fold 折叠规则的容器输出 `▸ [ref=i] <备注>` |
| `cdp.locate(target, ref, ancestor?)` | 对象,数字,数字可选 | 从 ref 反查稳定 selector:`{ok, tag, text, selector, shadow?, shadowChain?}`;刷新后仍可用,喂给 `tree` 复用。shadow 元素:selector 退化为最外层 host 锚定,shadowChain 是 `>>>` 穿透链(写进 selector-file 可复用) |
| `cdp.lineage(target, ref, ancestor?)` | 对象,数字,数字可选 | 列目标元素祖先链:`{ok, chain:[{depth,tag,id?,classes?,dataAttrs?,aria?,role?}], targetDepth, suggested}`;挑稳定锚点手写 fold 规则 |
| `cdp.fold(target, opts?)` | 对象,`{ref?,ancestor?,note?,save?,domain?,path?,add?,list?,rm?}` | 折叠规则管理(见 CLI fold);`save:true` 从 ref 落盘持久,否则会话级临时;`path` 限定 pathname 前缀 |
| `cdp.click(target, selector, opts?)` | 对象,字符串,`{noFeedback?, feedbackDelay?}` | `{ok, tag, feedback?}`;默认带操作后反馈 |
| `cdp.click(target, {ref: 12})` | 对象,`{ref:n}` | 按 ref 点真实元素(穿透 shadow);ref 失效自动自愈 |
| `cdp.fill(target, selector, value, opts?)` | 对象,字符串,字符串,opts | `{ok, tag, feedback?}` |
| `cdp.fill(target, {ref: 12}, value)` | 对象,`{ref:n}`,字符串 | 按 ref 填值(穿透 shadow) |
| `cdp.waitFor(target, selector, opts?)` | 对象,字符串,`{timeout,interval}` | 布尔(超时抛错) |
| `cdp.waitForFn(target, jsExpr, opts?)` | 对象,字符串,`{timeout,interval}` | 布尔(等同步布尔表达式为真,超时抛错)。**只吃同步布尔表达式**,别传 async/Promise/`return` 函数 |
| `cdp.focus(target, selector, opts?)` | 对象,字符串,opts | `{ok, tag, feedback?}` |
| `cdp.focus(target, {ref: 12})` | 对象,`{ref:n}` | 按 ref 聚焦(穿透 shadow) |
| `cdp.getFocus(target)` | 对象 | 焦点元素信息或 null |
| `cdp.pressKey(target, "Ctrl+Shift+A", opts?)` | 对象,字符串,opts | `{ok, feedback?}`(滚动触发懒加载也回反馈) |
| `cdp.hover(target, selector, opts?)` | 对象,字符串,opts | `{ok, feedback?}` |
| `cdp.hover(target, {ref: 12})` | 对象,`{ref:n}` | 按 ref 悬停(穿透 shadow) |
| `cdp.shot(target, file?)` | 对象,字符串可选 | 截图文件路径 |
| `cdp.logs(target, opts?)` | 对象,`{level,since}` | 控制台日志条目数组(自动拉起 daemon) |

## 常见错误

- **eval 拿不到结果** → 已用 `returnByValue + awaitPromise`;跨域 iframe 内元素需用 `contentDocument` 单独取。
- **click 没生效** → `el.click()` 是合成事件;若组件不吃,用 `eval` 调组件方法,或截图定位后真坐标点击。
- **多 tab 匹配错** → title 相似时用完整 id。
- **`navigate` 后 target 对象的 `url`/`title` 是快照,不刷新** → 判断跳转是否成功用 `cdp.eval(t, 'location.href')`,别信缓存字段。
- **`open` 失败/脚本中断会留下已建的 tab**(open 已建 target,后续报错不会自动关)→ 记得 `list` 核对后 `close` 清理。
- **SPA(知乎热榜)首屏加载慢,固定 sleep 不一定够** → 优先 `waitFor`/`waitForFn` 等条件出现,别死等固定时长。
- **连接失败** → 别手动排查端口,**先跑 `ensure`** 让它自动启动浏览器;仍失败用 `CDP_HOST/CDP_PORT` 指端口。
- **fill 对富文本框无效** → 已派发 input/change;React 等框架可能需额外 setter,改用 `eval` 按框架方式设值。
- **logs 拿不到历史日志** → daemon 只在 attach **之后**才收;加载早期日志读不到。想抓加载期日志要在导航**前**种上监听(open/ensure 已自动种)。
- **`--target 5173` 匹配到 DevTools 窗** → DevTools 的 url/title 也含 `5173`。用**完整 targetId** 精确指定(见 `list`)。
- **监听 daemon 没起/日志读空** → 无需手动管 daemon;`logs` 本身会幂等拉起并补种监控。仍读空多半是刚开新 tab(~0.5–2s 才装上),先 `await sleep(1500)` 再读。
