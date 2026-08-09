---
name: cdp-browser-control
description: 控制本地浏览器——列出/打开/关闭/导航页面、提取元素、点击、填表、执行 JS、截图、读控制台日志。自动化优先写成脚本用 `run` 一次执行。核心模型:view 感知页面(整页文本+结构紧凑树,生成可操作 ref),ref 是操作索引(会话句柄)。首屏外没加载(如评论区)用 `view --scroll-to-load` 先滚动再建树。任何用 ref 的命令失效自动自愈。长页噪声用 fold 持久规则(手动编辑 `$CDP_USER_DATA/folds.csv`,类 uBlock)。
---

# CDP 浏览器控制

## Overview

本 Skill 目录有零依赖 Node 脚本 `dist/cdp.js`,连 Chrome/Edge 的 CDP 端口(默认 9222),取代 chrome-devtools MCP。核心价值:**能看到并操作手动打开的 tab**(MCP 因 Puppeteer attach 竞态会漏看)。

**核心模型**:`view` 感知(整页 body 建紧凑树+结构,给可操作元素标 `[ref=i]`);`ref` 是操作索引(会话句柄,存 `window.__cdpRefs`,刷新失效、每次 view 重排)。

铁律:
- `list`/`open` 自动确保浏览器就绪(CDP 未起自动启动)。
- **首次看页面必须完整 `view`**(别 `| head`,别 `--visible-only`);view 输出**严禁 head/sed/grep 过滤**,局部只能用 `view <ref>`/`--ancestor/--selector-file/--visible-only`。
- 定位一律从 view 已有 ref 出发,**严禁 JS eval 探查 DOM**;要 selector(如写 fold 规则)手动写。
- 多步交互写成 `.js` 脚本用 `run` 一次执行,省模型往返。

## When to Use

读/操作已手动打开的页面(知乎、财联社等 tab),用 `view` 感知;多步自动化(填表/爬取/提交)写脚本 + `run`,省往返、可复用。

## 调用方式

```bash
node "<本 SKILL 所在目录>/dist/cdp.js" <子命令> [参数]
node "<本 SKILL 所在目录>/dist/cdp.js" run "./scripts/你的脚本.js"
```

浏览器就绪:CDP 未起则自动探测默认浏览器(优先 Edge,其次 Chrome),独立用户数据目录启动(默认 `~/.cdp-browser`,`CDP_USER_DATA` 覆盖),轮询等 ready(≤15s)。冷启动复用首个空白 tab,热启动新开 tab。

**脚本放置**:写到**当前项目根**(或 `scripts`/`tmp`),不写进 skill 目录;用 `dist/cdp.js` 绝对路径在项目根运行(`run` 的读写以 cwd 为基准,输出落项目根)。别 `cd` 进 skill 目录。脚本环境只有全局 `cdp` + 白名单 `require`(`os/path/fs/child_process/crypto/util/stream/url`);临时路径用 `path.join(os.tmpdir(), name)`,勿用 `/tmp/xx`(Windows 解析成盘根 ENOENT)。

## 感知页面(view)

整页以**缩进+折叠**输出紧凑树,含结构+文本+Ref。

| 参数 | 作用 |
|---|---|
| (默认) | 整页 |
| `<ref>`(位置参) | 以某 ref 元素为树根(与 --selector-file 互斥) |
| `--selector-file <f>` | 筛选指定区域(selector 手动写) |
| `--ancestor <k>` | 从锚点向上爬 k 层父级再建树(把内容叶子抬到区域容器) |
| `--visible-only` | 只看当前视口内元素(**仅"确认当前屏",绝不做首次整页感知**) |
| `--scroll-to-load` | 滚动触发懒加载再建树,默认上下各一屏回原位。**整页完整 view 首次自动启用**(同页刷新前只滚一次),配合下列参数可滚更远 |
| `--scroll-wait <ms>` | 滚动后等内容渲染再建树(默认 1000,`--scroll-wait 0` 关),否则漏掉新回答/评论区 |
| `--scroll-pages <n>` | 循环向下滚 N 屏(每屏等 innerHeight+150ms),检测 scrollHeight 增长,连续 2 次不增长提前停。用于无限流。知乎等"用户主动滚动"反爬站点分步滚也可能触发不了,是反爬不是 bug |
| `--scroll-to <selector>` | 先滚到匹配元素(如 B站 `#bili-comments`)停下触发懒加载,命中不到优雅降级。比 --scroll-pages 精准 |

**铁律**:首次看页面必须完整 `view`(别 `| head`,别 `--visible-only`)。`--visible-only` 只输出视口内,视口外的回答/评论区**整段漏掉**,会误以为页面只有首屏。整页首次 view 已默认 scroll-to-load,评论区等也一次到位。

**定位 = 从已有 view 出发,别 JS 探查**:层级、内容、ref 全在眼前,不需猜结构。要定位区域,从 view 已有 ref 出发;要把"内容叶子"抬到"区域容器",用 `--ancestor k`(k 不确定逐个试 1/2/3)。

**易错**:selector 一律从文件读(Git Bash 会改行首特殊字符);`eval` 里 `(() => ({...}))()` 返回空对象——箭头+对象字面量需显式 `return` 或写 `(function(){ return {...}; })()`。

**操作(ref)**:
- 整页 view 里 `[shadow]` 占位行(如 `bili-comments[shadow] [ref=N]`)是 Web Component 容器,内容在 shadow DOM,整页只占位不深入。**看内容用 `view N`**;首屏空壳则 `view N --scroll-to-load`。CSS 穿不透 shadow,操作一律用 ref。
- 操作优先 `[ref=i]`(`click i`,零 selector,shadow 内也能定位;目标全数字即 ref)。
- ref 是会话句柄,页面刷新失效、每次 view 重建。**每回合先 view 拿 ref 再操作**。

**区域定位(想 view 一块"语义区域")**:
- 同会话:`view <n> --ancestor <k>`——拿区域内任一叶子 ref 向上爬 k 层到容器。
- 刷新后仍可用:把区域容器 selector(手动写,如 `#id` 或 fold 规则验证过的锚点)写文件,`view --selector-file <f>` 复用。
- 多块布局(如知乎 Q&A 是"问题块+回答列"两个兄弟块、**没有共同容器**):分块各做一次 ref+ancestor 再并列看,别绕回 JS 探查。

**整页去噪(`fold` 持久规则,类 uBlock)**:长页整页 view 常混入导航/推荐/广告等噪声 ref。用 `fold` 把区域**折叠成一行**(`▸ [ref=i] <备注>`,保留 ref 可展开),跨会话持久。

**规则**:存 `dist/folds.csv`(与 cdp.js 同级),五列 tab:`<id>\t<域名>\t<path>\t<selector>\t<备注>`,view 时自动加载。
- `<id>` 单调递增不重排,新规则取 max+1;只认首列为数字的行。
- `<域名>` 通配对齐 uBlock:精确(`www.bilibili.com`)/子域(`*.zhihu.com`)/entity(`zhihu.*`);空=不匹配。
- `<path>` glob:`*` 含 `/`,如 `/video/*`;空=不限。同域名不同页结构不同,只用域名会跨页错位,用 path 限定。
- 示例:`12\twww.bilibili.com\t/video/*\t#biliMainHeader\t顶栏`(tab 分隔,selector 可含空格)。
- 折叠判定:命中 `el.matches(selector)` 的非根区域折叠成一行。**展开**:`view <折叠容器 ref>`;**嵌套天然支持**。fold 取代旧 stash。

## 操作后自动反馈(click/fill/focus/hover/press-key 默认开启)

操作后等约 1s,回报**新增内容 view + tab 变化**,一轮拿到结果:
- **内容**:`页面变化 · 新增内容:`(重复块标 `(重复 N 次,已折叠)`)、`页面变化 · 文本变化:`(逐条 `旧 → 新`)。observer **穿透 shadow**、**跳过 video/audio/canvas 子树与连续播放时间戳**(01:55→01:56 折叠,不淹没点赞数等真变化)。操作行同附 `，该元素的 selector 为: <唯一selector>`,后续优先用 selector 而非 ref。
- **tab**:操作前后 diff,点 `target=_blank` 新开 tab 直接报 `新开 tab: <title> <url> [<targetId>]`,直接 `view --target <targetId>` 继续。
- `--no-feedback`:关闭。`--feedback-delay <ms>`:自定义等待(默认 1000)。
- **反馈树 ref 是增量号,不顶旧 ref**:新增内容 `[ref]` 从当前已有号递增,可操作新增内容,**原整页 ref 仍有效**。增量 ref 适合即时 click/fill;要 `view <ref>` 回看先整页 view。
- 脚本:`cdp.click(target, arg, {noFeedback?, feedbackDelay?})` → `{ok, tag, feedback:{lines, summary, tabs:{opened, closed}}}`。

## ref 失效自动自愈(所有 ref 命令)

`click`/`fill`/`focus`/`hover` 遇 ref 失效**自动自愈**,不用猜容器:
- **祖先还活着**:沿 `parentRef` 链找最近仍 connected 的容器,以它为根局部 view,回报新内容+新 ref。
- **打错号(从未存在)**:直接报 `ref=N 从未存在(当前最大 ref=M)`,**不误导成"页面刷新"**。
- **整链失效(页面刷新/重建)**:才提示`整条祖先链均已失效,请重新 view`。

## Quick Reference

所有命令可选 `--target <匹配>`(target id 或 url/title 子串;不传自动选第一个普通网页)。命令名统一 kebab-case。

| 子命令 | 作用 |
|---|---|
| `list` | 确保浏览器就绪并列出 page tab,先报总数 |
| `open <url>` | 新开 tab,返回 targetId |
| `close <target>` | 关闭 tab |
| `fetch <url>` | 一次性抓取:临时开 tab→等渲染→view(整页首次自动 scroll-to-load)→关 tab,输出文本+结构含 `[ref]`,不残留 tab |
| `navigate <url>` | 导航 |
| `eval "<js>"` | 执行 JS,返回 returnByValue 值 |
| `view [<ref>] [...]` | 整页文本+结构紧凑树。首次必须完整 view(禁 --visible-only/截断)。参数见上表(锚点互斥:位置 ref 优先、其次 --selector-file、缺省 body)。命中 fold 规则输出 `▸ [ref=i] <备注>`;视区标 `[ref=i·屏]`;INPUT/TEXTAREA 显示 `[type=... value="..." placeholder="..."]` |
| `click <target> [--ancestor <k>] [--no-feedback] [--feedback-delay <ms>]` | 点击(target 全数字=ref 否则 selector,穿透 shadow)。默认带反馈 |
| `fill <target> <值> [--ancestor <k>] [...]` | 填输入框并派发 input/change。默认带反馈 |
| `focus <target> [--ancestor <k>] [...]` | 聚焦元素。默认带反馈 |
| `get-focus` | 查看当前焦点元素在哪 |
| `info <n> [--ancestor <k>]` | 列元素祖先链(tag/id/class/语义 data-*/aria/role 逐层)+ 建议 selector,看清稳定锚点自己写 fold 规则 |
| `press-key <键> [...]` | 真实按键/组合键,如 Enter/Tab/Ctrl+Shift+A(含滚动如 PageDown)。默认带反馈 |
| `hover <target> [--ancestor <k>] [...]` | 鼠标移到元素(触发 mouseover/mouseenter)。默认带反馈 |
| `shot [--file out.png]` | 截图 |
| `logs [--level error,warn] [--since <ms>] [--json]` | 读控制台日志 |
| `run <脚本文件>` | 执行自动化脚本(全局 `cdp` API,可顶层 await) |

环境变量:`CDP_HOST`/`CDP_PORT`(默认 `127.0.0.1:9222`)、`CDP_LOGS_PORT`(daemon,默认 9333)、`CDP_USER_DATA`(默认 `~/.cdp-browser`)、`CDP_FOLD_FILE`(fold 规则路径覆盖,默认 `dist/folds.csv`)。

## 命令示例(真实流程)

> 以下 `cdp` 均指 `node "<本 SKILL 所在目录>/dist/cdp.js"`。真实流程照"打开→感知→点击→核对落点/结果";CLI 直接传数字 ref,脚本 API 才用 `{ref:n}`。

```bash
cdp open "https://www.zhihu.com/"                 # 开页
cdp view --target zhihu                           # 看整页拿 ref
cdp view 53 --ancestor 4 --target zhihu     # 从叶子 ref 爬到区域容器
cdp click 44 --target zhihu                       # 点卡片/链接;反馈报"新开 tab"落点
cdp click 36 --target "BV1..."                    # 点赞;反馈回文本变化(42→43)
```

## 读控制台日志

`dist/cdp.js` 用常驻 daemon 给每个页面注入监控脚本,把日志存进 `window.__cdpLogs`,`logs` 再 eval 读出来——**保留对象嵌套结构与调用链**(直接监听 CDP 事件只拿描述文本)。核心价值:抓到手动操作期间日志、跨命令累计、刷新后自动补装、支持过滤。关键机制 `Page.addScriptToEvaluateOnNewDocument` 注册在 tab 会话,每次 document 创建(含刷新)先跑监控脚本。

- **自动装**:`open`/`list`/`logs` 自动拉起 daemon,轮询给每个 tab 注册监控;`logs` 本身幂等补种。
- **读**:`logs [--target <匹配>] [--level error,warn] [--since <ms>] [--json]`。`--level` 逗号分隔(debug/log/info/warn/error);未捕获异常归 `error`。默认人类可读 `[HH:MM:SS][level] args`;`--json` 完整结构(嵌套对象+`stack`)。
- **脚本**:`cdp.logs(target, {level, since})` → 结构化日志数组,配合 `waitForFn` 做"跑完断言无报错"。端口 `CDP_LOGS_PORT`(默认 9333),浏览器关闭后 daemon 约 5s 自动退出。

**限制**:刷新后 `__cdpLogs` 清空(监控补装但历史没了);首屏/加载早期日志可能错过;刚 `open` 的新 tab 需 ~0.5–2s 才装监控,立即读会空——**先 `await sleep(1500)` 再操作/读**。

## 自动化工作流(推荐)

**先探后写、写成文件、一次执行**:1) `list` 看 tab + `view --target <匹配>` 感知整页拿 ref;2) 整段操作写成一个 `.js` 放项目根,用全局 `cdp` API;3) 项目根用绝对路径 `run` 执行,出错改文件再跑。

```js
const tid = await cdp.open('about:blank');   // ⚠️ open 返回字符串 targetId
const t = await cdp.resolve(tid);             // 其余方法都要 target 对象
await cdp.eval(t, `document.body.innerHTML='<input id=box><button id=btn>go</button>';'ok'`);
await cdp.waitFor(t, '#btn');
await cdp.fill(t, '#box', '值');
await cdp.click(t, '#btn');
console.log(await cdp.eval(t, 'document.title'));
await cdp.shot(t, 'out.png');
await cdp.close(t);
```

**target 对象约定(重要)**:`open` **返回字符串 targetId**;其余方法第一个参数 `target` 一律是对象(来自 `resolve`)。`resolve(匹配)` 匹配 id/url/title 子串,`undefined` 取第一个普通网页。

| API | 返回 |
|---|---|
| `ensure(url?)` | 浏览器就绪(自动启动) |
| `list()` | `[{id,title,url,...}]` |
| `resolve(匹配?)` | `target` 对象 |
| `open(url)` | 字符串 `targetId`(⚠️ 非对象) |
| `close(target)` | — |
| `fetchPage(url)` | `string[]` 视图 lines(临时开 tab→等加载→view→关 tab) |
| `navigate(target, url)` | — |
| `eval(target, js, timeout?)` | returnByValue 值 |
| `view(target, {selector?,ref?,ancestor?})` | `{ok, lines}`(锚点互斥,折叠输出 `▸ [ref=i] <备注>`) |
| `click(target, selector \| {ref:12}, {noFeedback?,feedbackDelay?})` | `{ok, tag, feedback?}`;ref 失效自动自愈 |
| `fill(target, selector \| {ref:12}, value, opts?)` | `{ok, tag, feedback?}` |
| `waitFor(target, selector, {timeout,interval})` | 布尔(超时抛错) |
| `waitForFn(target, jsExpr, {timeout,interval})` | 布尔(**只吃同步布尔表达式**,别传 async/Promise) |
| `focus(target, selector \| {ref:12}, opts?)` | `{ok, tag, feedback?}` |
| `getFocus(target)` | 焦点元素信息或 null |
| `pressKey(target, "Ctrl+Shift+A", opts?)` | `{ok, feedback?}` |
| `hover(target, selector \| {ref:12}, opts?)` | `{ok, feedback?}` |
| `shot(target, file?)` | 截图文件路径 |
| `logs(target, {level,since})` | 控制台日志数组(自动拉起 daemon) |

## 常见错误

- eval 拿不到 → 已用 returnByValue+awaitPromise;跨域 iframe 用 `contentDocument`。
- click 没生效 → `el.click()` 是合成事件;组件不吃就 eval 调组件方法,或截图后真坐标点击。
- SPA 首屏慢,固定 sleep 不够 → 优先 `waitFor`/`waitForFn`。
- 连接失败 → 先 `list` 自动启动;仍失败用 `CDP_HOST/CDP_PORT`。
- `open` 失败/中断留 tab → `list` 核对后 `close`。
- fill 富文本框无效 → 已派发 input/change;React 等框架需额外 setter,用 eval 设值。
- `--target 5173` 匹配到 DevTools 窗 → 用完整 targetId;title 相似也同法。
- logs 读空 → `logs` 幂等拉起;仍空多半刚开新 tab(~0.5–2s),先 sleep(1500)。
