---
name: cdp-browser-control
description: 需要控制本地浏览器时使用——列出 tab、打开/关闭/导航页面、提取页面元素、点击、填表、执行 JS、截图,**读页面控制台日志(含嵌套对象与调用链,支持过滤)**。做自动化时,优先把整个操作写成脚本文件用 `run` 一次执行,避免分步调用。**感知页面内容用 `tree`，它会输出整页 body 的文本+结构紧凑树，并生成便捷操作的 ref，`tree --ref <n> --ancestor <k>` 可以查看局部， 也可以用 `--selector-file`/`--xpath-file` 局部定位。可用 `locate` 从 ref 得到 xpath 和 selector 用作刷新后的快速定位。遇到首屏外内容没加载(如评论区),用 `tree --scroll-to-load` 先滚动触发懒加载再建树。
---

# CDP 浏览器控制 (cdp-browser-control)

## Overview

本 Skill 所在目录有一个零依赖 Node 脚本 `dist/cdp.js` ，可直接连 Chrome/Edge 的 CDP 端口(默认 9222),取代 chrome-devtools MCP。核心价值:**能看到并操作手动打开的 tab**(MCP 因 Puppeteer attach 竞态会漏看)。


重要原则：

- 用 `ensure` 可确保 CDP 浏览器启动，意外的页面变化多由用户手动操作引起，模型不必猜测。
- 打开页面后，优先用 `tree` 查看页面整体内容并生成 ref，`tree` 的输出严禁用 `head` 或 `sed` 等过滤，只能用 `--ref n --ancestor k`/`--selector-file`/`--xpath-file`/`--visible-only` 来局部查看。
- selector 只能用 `locate ref --ancestor <k>` 获取，严禁用 JS eval 探查 DOM
- 多步交互操作优先写成一个 `.js` 脚本文件,用 `node "<本 SKILL 所在目录>/dist/cdp.js" run 脚本.js` 一次执行，节省模型API调用次数

## When to Use

- 需要读取/操作浏览器里已手动打开的页面(知乎、财联社这种 tab)，用 `tree` 获取页面内容。
- 做多步自动化(填表、爬取、提交)时——此时**写脚本文件 + run** 是首选,省往返、可复用、易改。

## 调用前唯一入口:`ensure`

```bash
node "<本 SKILL 所在目录>/dist/cdp.js" ensure          # 确保浏览器已通过 CDP 就绪(不导航)
node "<本 SKILL 所在目录>/dist/cdp.js" ensure --url "<网页地址>"   # 开浏览器并直接打开该页
```

`ensure` 内部自动:
1. 检查 CDP 端口(默认 9222)是否已就绪——已就绪则直接继续。
2. 没就绪 → 自动探测默认浏览器(优先 Edge,其次 Chrome,覆盖常见安装路径)。
3. 用**独立用户数据目录**启动它(默认 `~/.cdp-browser`,可用环境变量 `CDP_USER_DATA` 覆盖)。
4. 轮询等待浏览器 ready(最多 ~15s),然后(若给了 `--url`)打开它。**冷启动**(本次由 ensure 启动的浏览器)会直接复用首个空白 tab 导航,不额外开 tab;**热启动**(浏览器已就绪)才新开一个 tab 放链接,不覆盖你现有页面。


## 脚本调用方式

```bash
node "<本 SKILL 所在目录>/dist/cdp.js" <子命令> [参数]
node "<本 SKILL 所在目录>/dist/cdp.js" run "./scripts/你的脚本.js"   # 在项目根执行自动化脚本
```

## 脚本放置规范

写到**当前项目的根目录**(或项目内临时目录，如 `scripts` 或 `tmp`),**不写进 skill 目录**。运行用 **`dist/cdp.js` 的绝对路径**,在项目根执行:

```bash
node "<本 SKILL 所在目录>/dist/cdp.js" run "./scripts/项目里的脚本.js"
```

- **为什么**:`run` 读取脚本和脚本里的相对路径输出(截图等)都以 `cwd`(你执行命令的那个目录)为基准。在项目根运行 → 脚本能被读、截图/生成文件直接落到项目根,**skill 目录保持干净、只有工具本身**,不会被业务脚本和输出污染。
- **绝对路径调 dist/cdp.js**:不要 `cd` 进 skill 目录再跑(那会把 cwd 变成 skill 目录,输出写进 skill)。
- **脚本运行环境**:`run` 脚本里只有全局 `cdp` + **白名单 `require`**(可用 `os`/`path`/`fs`/`child_process`/`crypto`/`util`/`stream`/`url`)。取临时目录/写文件:``const path = require('path'), os = require('os')``,用 `path.join(os.tmpdir(), name)` 拼路径——**勿直接用 `/tmp/xx` 前缀**(Windows 会被 `path.resolve` 解析成盘根 `D:\xx` 而 ENOENT)。

## 感知页面

`tree`:将整页以 **缩进+折叠** 输出紧凑树，以节省Token的方式包含了结构+文本+Ref。

**参数**:

| 参数 | 作用 |
|---|---|
| (默认) | 整页 |
| `--xpath-file <f>` / `--selector-file <f>` | 筛选指定区域 |
| `--ref <n>` | 以某 ref 的元素为树根(与 --selector-file/--xpath-file 互斥) |
| `--ancestor <k>` | 从锚点(任意)向上爬 k 层父级再建树;多与 --ref 配合把"内容叶子"抬到"区域容器" |
| `--visible-only` | 筛选当前视口内可见元素(**仅用于"看当前屏幕上有啥",绝不用来做首次整页感知**) |
| `--scroll-to-load` | 固定距离滚动触发懒加载(评论区等首屏外的内容)再建树——向下滚一屏、向上滚一屏(都是固定一屏高),触发当前位置上下各一屏的懒加载后回到原位。**只会移动当前位置附近 ±1 屏,不会拉飞视口**;内容在远处时先自己滚到附近再建树 |

**铁律(首次感知 = 完整 tree,禁 `--visible-only`)**:
- **第一次看页面必须用完整 `tree`(看全部内容,别 `| head` 截断,也别 `--visible-only`)**。`--visible-only` 只输出当前视口内的元素——页面下方/后面的回答、评论区等**视口外的容器会被整段漏掉**,导致你以为页面只有首屏那么点东西,找不到后面的内容(曾因只看可见区域找不到第 2 个回答)。
- 完整 `tree` 会把整页(含视口外)的文本+结构+ref 一次给全;要用 `--visible-only` 只有在"专门确认当前屏幕可见区域"时。

**定位 = 从已有的 tree 出发,别 JS 探查(最重要)**:
- 你已经看过整页 tree,**层级、内容、ref 全在眼前**,不需要再猜结构。要定位区域/元素,一律从 tree 里已有的 ref 出发,不要 `eval` 一段 JS 去分析原始 HTML 摸 DOM 结构——那是浪费轮次的弯路。
- 层数=数折叠链(`div>div>div`=3层);但同类序号 `n` **不能**从 tree 反推(含无文本兄弟)。已带 `[ref]` 直接 ref 操作。拿准序号:①F12 Copy full XPath ②文本谓词 `//*[contains(.,'…')]` ③文本叶推父链(最稳)④`cdp locate <ref>` 反查稳定定位器。

**易错**:
- `//*[contains(.,'…')][1]` 的 `[1]` 取最外层,须加 `and not(.//*[contains(.,'…')])` 锁最深
- `~` 前缀=聚合文本(用 `contains`,别用 `text()`)
- `//text()="X"` 是布尔非节点集,等值写 `//*[.="X"]`
- xpath/selector 一律从文件读(Git Bash 会把行首 `//` 改 `/`)
- `eval` 里 `(() => ({...}))()` 会返回空对象——箭头+对象字面量需显式 `return` 或写 `(function(){ return {...}; })()`。

**操作(ref)**:
- tree 里标 `[shadow]` 的块(如 `bili-comments[shadow]`)CSS 定位不到 → 操作改用 ref 或 `--xpath-file`
- 操作优先 `[ref=i]`(`click {ref:i}`,零 XPath,shadow 内也能定位);XPath 兜底批量/精确查询
- ref 是会话句柄:存 `window.__cdpRefs`,页面刷新失效,每次 tree 重建。**每回合先 tree 拿 ref 再操作**,刷新/动态加载后序号漂移是预期

**区域定位(想 tree 一块"语义区域"而不是单个叶子时)**:
- **同会话立即看**:`tree --ref <n> --ancestor <k>`——拿区域内任一内容叶子的 ref,向上爬 k 层到容器直接建树。k 不确定就逐个试(`--ancestor 1/2/3...`),每个 tree 调用成本低、结果直观。
- **刷新后仍可用(更常用)**:`locate <n> [--ancestor <k>]` 把 ref 翻译成**稳定 selector + xpath**,写进文件后 `tree --selector-file/--xpath-file` 复用。ref 是会话句柄刷新即失效,locate 得到的定位器不依赖 ref、刷新后照样局部 tree。流程:
  ```
  tree --target ...            # 1. 看整页,记下区域里某个内容叶子的 ref(如 [ref=53])
  cdp locate 53 --ancestor 4   # 2. 反查该区域容器的 selector + xpath(直接贴出来)
  cdp tree --selector-file f   # 3. 刷新后,把上一步的 selector 写入 f,照样定位这块区域
  ```
  **首选 selector**(CSS,最可读、最稳);xpath 是**就近 id 锚定**版(就近祖先有 id 就 `//*[@id=…]`,否则回退 `html/body/div[1]…` 位置链),也可靠,但长路径在动态页有位置漂移风险。若页面刷新/改版后定位器失效,重新 `tree` 拿 ref 再 `locate` 一次即可。
- **多块布局**(如知乎 Q&A 是"问题块 + 回答列"两个兄弟块、**没有共同容器**):别去找"能一网打尽的容器"(不存在)——分块各做一次 ref+ancestor,或各自 `locate`,再并列看。别因此绕回 JS 探查。

## 操作后自动反馈(click/fill/focus/hover/press-key 默认开启)

每次操作命令后自动等约 1s(给异步/懒加载内容出现留时间),然后回报 **页面新增内容 tree + tab 变化**,agent 一轮拿到结果,不必再手动 `tree`/`list` 补查:

- **内容反馈**:记录本次操作期间新增的顶层内容块,CLI 先打一行 `→ 本次操作后页面变化(新增内容):` 作标题,再逐块 tree 拼出带 `[ref]` 的行 + 摘要(如 `新增 3 个内容块; 文本变化: 583 → 584`)。**文本变化报前后值**(点赞后数字 583→584 直接可见);点"显示评论"后评论进来,反馈里直接看得到。
- **tab 变化**:操作前后 diff `/json/list`。点 `target=_blank` 链接新开 tab 后,反馈直接告诉你 `新开 tab: <title> <url>`,直接 `tree --target <新tab>` 继续,不必先 `list`。
- **`--no-feedback`**:关闭(不等待、不观察、不 diff tab),高频率操作想快时用。
- **`--feedback-delay <ms>`**:自定义等待时长,默认 1000。
- **反馈树 ref 是增量号,不顶掉旧 ref**:反馈新增内容里的 `[ref]` 从当前已有号继续递增(整页 tree 才从 0 重置)。反馈后 agent 既可用反馈树的增量 ref 操作新增内容(如点刚加载的"显示更多"),**原整页 ref 依旧有效**。
- 脚本 API:`cdp.click(target, arg, { noFeedback?, feedbackDelay? })` → 返回 `{ok, tag, feedback:{lines, summary, tabs:{opened, closed}}}`(见下方脚本表)。

## Quick Reference

所有命令可选 `--target <匹配>`(target id 或 url/title 子串;不传则自动选第一个普通网页)。每个命令支持 `--help`/`-h` 查看自身用法(顶层 `cdp --help` 或 `cdp help` 看全部)。命令名统一 **kebab-case**。

| 子命令 | 作用 |
|---|---|
| `ensure [--url <url>]` | 确保浏览器已打开(自动探测 Edge/Chrome 启动 CDP),可选 --url 直接导航 |
| `list` | 列出所有 page tab(含手动开的) |
| `open <url>` | 新开一个 tab,返回 targetId |
| `close <target>` | 关闭 tab |
| `navigate <url> [--target]` | 导航 |
| `eval "<js>" [--target]` | 执行 JS,返回 returnByValue 的值 |
| `tree [--target] [--ref <n>] [--ancestor <k>] [--selector-file <file>] [--xpath-file <file>] [--visible-only] [--scroll-to-load]` | 将整页以 **缩进+折叠** 输出紧凑树，以节省Token的方式包含了结构+文本+Ref。**首次感知必须用完整 tree(无 --visible-only/不截断),否则视口外的回答/评论区被整段漏掉**。锚点互斥:--ref 优先,其次 --selector-file/--xpath-file,缺省 body;--ancestor 统一向上爬 k 层父级再建树;--scroll-to-load 固定距离滚动(向下+向上各一屏,回原位)触发懒加载再建树。带 ref 的节点若在当前视区会标 `[ref=i·屏]`,否则 `[ref=i]`——看到未标 `·屏` 就知道它不在屏上,要先滚动/`--scroll-to-load` 再操作 |
| `locate <n> [--ancestor <k>] [--target]` | 从 tree 的 ref 序号**反查稳定定位器(selector + xpath)**。ref 是会话句柄,页面刷新后失效;locate 把它翻译成刷新后仍可用的定位器,供 `tree --selector-file/--xpath-file` 复用(可选 --ancestor 把叶子抬到区域容器) |
| `click <selector> [--ref <n>] [--ancestor <k>] [--no-feedback] [--feedback-delay <ms>] [--target]` | 点击元素(selector 或 `--ref i` 用 tree 的 ref 序号,穿透 shadow;--ancestor 定位后爬父)。默认带操作后反馈(见上) |
| `fill <selector> <值> [--ref <n>] [--ancestor <k>] [--no-feedback] [--feedback-delay <ms>] [--target]` | 填输入框并派发 input/change(selector 或 ref,--ancestor 爬父)。默认带操作后反馈 |
| `focus <selector> [--ref <n>] [--ancestor <k>] [--no-feedback] [--feedback-delay <ms>] [--target]` | 聚焦元素(selector 或 ref,--ancestor 爬父,配合按键用)。默认带操作后反馈 |
| `get-focus [--target]` | 查看当前焦点元素在哪 |
| `press-key <键> [--no-feedback] [--feedback-delay <ms>] [--target]` | 真实按键/组合键,如 `Enter`、`Tab`、`Ctrl+Shift+A`(含滚动如 PageDown,反馈懒加载内容)。默认带操作后反馈 |
| `hover <selector> [--ref <n>] [--ancestor <k>] [--no-feedback] [--feedback-delay <ms>] [--target]` | 鼠标移到元素上(selector 或 ref,--ancestor 爬父,触发 mouseover/mouseenter)。默认带操作后反馈 |
| `shot [--file out.png] [--target]` | 截图 |
| `logs [--target] [--level error,warn] [--since <ms>] [--json]` | 读 target 控制台日志(见下方「读控制台日志」) |
| `run <脚本文件>` | 执行自动化脚本(脚本里用全局 `cdp` API,可顶层 `await`) |

环境变量:`CDP_HOST` / `CDP_PORT`(默认 `127.0.0.1:9222`)、`CDP_LOGS_PORT`(监听 daemon 端口,默认 9333)。

## 命令示例(真实流程)

> 以下 `cdp` 均指 `node "<本 SKILL 所在目录>/dist/cdp.js"`。真实流程照"打开→感知→点击→**核对落点/结果**"走。**别把 `tree` 输出丢给 `head`/`sed`/`grep` 过滤**(见上第 16 行限制),看局部只能用 `tree --ref/--ancestor/--selector-file/--xpath-file/--visible-only`。注意:**CLI 用 `--ref n`,脚本 API 才用 `{ref:n}`**——`cdp click "{ref:44}"` 会报"不是合法 selector"。

### 逛页面 + 定位区域
```bash
cdp open "https://www.zhihu.com/"     # 开页
cdp tree --target zhihu               # 看整页,拿 ref(别 head/sed 截断)
cdp tree --ref 53 --ancestor 4 --target zhihu   # 从内容叶子 ref 爬到区域容器,只列问题+回答
cdp locate 53 --ancestor 4 --target zhihu       # 要刷新后仍可用的定位器 → selector + xpath
cdp tree --selector-file ./f --target zhihu     # 用定位器局部复看
```

### 点击可能开新 tab → 反馈自动报落点
```bash
cdp click --ref 44 --target zhihu    # 点卡片/链接;反馈直接报"新开 tab: <title> <url>"(target=_blank 落点)
cdp tree --target "BV1..."           # 按反馈给的 tab 直接继续;原 tab 的 location 可能没变,不必再手动 list
```

### 改状态的操作(点赞/关注/提交)→ 反馈自动复看
```bash
cdp tree --target "BV1..."                      # 先看整页拿 ref
cdp click --ref 36 --target "BV1..."            # 点赞;反馈直接回新增内容/文本变化(如 文本变化 "42"),别只靠"无报错"当成功
```

## 读控制台日志(console 监听)

`dist/cdp.js` 用**常驻 daemon 给每个页面注入监控脚本**,把日志存进页面的 `window.__cdpLogs`,`logs` 命令再 eval 读出来——**保留对象的嵌套结构和调用链**(不是拍平的文本)。核心价值:能抓到**用户手动操作期间**打出的日志、跨多次命令/agent 回合累计、**刷新页面后监控自动补装**、支持过滤。

原理:直接监听 CDP 控制台事件拿到的只是描述文本,看不到对象嵌套结构。所以改成往页面注入 `console.*`/`onerror`/`unhandledrejection` 钩子,把**活的嵌套对象 + 调用链(stack)** 存进 `window.__cdpLogs`,读时结构化序列化。关键机制是 `Page.addScriptToEvaluateOnNewDocument`——注册在该 tab 的会话上,**每次 document 创建(含刷新)自动先跑监控脚本**,刷新自动补装,无需 daemon 探测。

- **自动装监听**:`open` / `ensure --url` 打开页面时自动拉起 daemon,它轮询 `/json/list` 给**每个** tab(含手动开的)注册监控脚本。
- **读**:`node dist/cdp.js logs [--target <匹配>] [--level error,warn] [--since <ms>] [--json]`
  - `--level` 逗号分隔按级别过滤(`debug/log/info/warn/error`);未捕获异常归 `error`。
  - `--since <毫秒时间戳>` 只取该时间点之后。
  - 默认人类可读 `[HH:MM:SS][level] args`;`--json` 输出完整结构(嵌套对象 + `stack` 调用链)给脚本/agent。
  - **读时自动补种**:`logs` 本身也会幂等注入监控脚本(防 daemon 未及装),所以对任意 tab 读都有效。
- **无需手动管理**:监听 daemon 由 `open`/`ensure`/`logs` **自动拉起**(隐藏 `__daemon` 入口,无 `listen`/`listen-stop` 命令)。daemon 端口 `CDP_LOGS_PORT`(默认 9333)。
- **生命周期**:daemon 在**浏览器关闭后约 5s 自动退出**(看门狗),不留孤儿进程;下次 `open`/`ensure`/`logs` 会自动重新拉起。所以无需手动担心残留。
- **脚本模式**:`cdp.logs(target, {level, since})` → 返回结构化日志数组,可与 `cdp.click`/`cdp.waitForFn` 配合做"跑完流程断言无报错"。

**已知限制**:
- `window.__cdpLogs` 在页面刷新后**清空**(缓冲在页面里,新 document 从头开始);监控脚本会自动补装,但历史没了。
- **首屏/加载早期的日志可能错过**:daemon 靠轮询注入,页面刚打开的几毫秒内已打的日志在注入前就跑了。agent 打开页→操作→读的场景不受影响;想抓加载早期日志需在导航前注册。
- **刚 `open` 的新 tab,立即打日志再 `logs` 读会读到空**:daemon 每 ~500ms 轮询,新 tab 打开后需 **~0.5–2s 才装上监控**;开 tab 后**先 `await sleep(1500)` 再操作/读日志**,否则首几条在监控装上前就跑掉了,读到空是正常的(不是 bug)。
- 只覆盖主线程的 console/onerror/unhandledrejection,worker 等跨 context 的异常抓不到。

## 自动化工作流(推荐)

**先探后写、写成文件、一次执行**——避免多次模型往返:

1. **探明页面**:不知道元素时,先 `node dist/cdp.js list`(看有哪些 tab)+ `node dist/cdp.js tree --target <匹配>`(感知整页结构);要操作再 `cdp locate <ref>` 反查目标元素的稳定定位器。
2. **写脚本文件**:把整段操作写成一个 `.js` 放到**项目根**(见上方"脚本放置规范"),用全局 `cdp` API。直接复制下面「脚本示例」即可(无内置模板)。
3. **执行**:在项目根用绝对路径运行 `node "<本 SKILL 所在目录>/dist/cdp.js" run ./你的脚本.js`。出错改文件再跑,不重新生成;截图等输出直接落项目根。

脚本示例(等价于 9 个单命令调用,但只发一次模型请求):

```js
// ⚠️ 记住两类"句柄":open 返回字符串 targetId,其余方法都要 **target 对象**。
// 所以 open 之后总要 resolve 一次拿到对象,再往下传。
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

> **target 对象**是绝大多数方法的第一个参数。它来自 `cdp.resolve(子串)`;若你已经有一个**手动打开**的页面,直接 `const t = await cdp.resolve('5173')`(url/title 子串)拿对象即可,不需要 `open`。

### 脚本模式 API

脚本顶层可直接 `await`;全局 `cdp` 提供:

**句柄类型约定(重要):**
- `open` **返回字符串 `targetId`**;其余方法的第一个参数 **`target` 一律是对象**(来自 `resolve` 或 `list()` 数组里的元素)。**不要用字符串 id 直接调方法**。
- `resolve(匹配)` 匹配可为 targetId / url / title 子串;`undefined` 取第一个普通网页。

| API | 参数 | 返回 |
|---|---|---|
| `cdp.ensure(url?)` | 字符串 url 可选 | 浏览器就绪(自动启动) |
| `cdp.list()` | — | `[{id,title,url,webSocketDebuggerUrl,...}]` |
| `cdp.resolve(匹配?)` | id/url/title 子串,可省略 | `target` 对象 |
| `cdp.open(url)` | 字符串 | 字符串 `targetId`(⚠️ 非对象) |
| `cdp.close(target)` | 对象 | — |
| `cdp.navigate(target, url)` | 对象,字符串 | — |
| `cdp.eval(target, js, timeout?)` | 对象,字符串 | `returnByValue` 值 |
| `cdp.tree(target, opts?)` | 对象,`{selector?,xpath?,ref?,ancestor?}` | 整页 body 的**文本+结构**紧凑层级树:`{ok, lines}`;不做可见性判定,输出纯文本与结构;锚点互斥:ref 优先,其次 selector,最后 xpath,缺省 body;`opts.ancestor` 统一向上爬 k 层父级;`opts.xpath` 为 shadow 穿透版(拼接树模型,`/`与`//`都跨任意层 shadow,支持 `[n]` 标准位置索引(逻辑父下第 n 个匹配兄弟)与 `[contains(...)]` 谓词,递归任意深度) |
| `cdp.locate(target, ref, ancestor?)` | 对象,数字,数字可选 | 从 tree 的 ref 序号反查稳定定位器:`{ok, tag, text, selector, xpath}`;可选 ancestor 向上爬 k 层。返回的 selector/xpath 刷新后仍可用,喂给 `tree` 复用 |
| `cdp.click(target, selector, opts?)` | 对象,字符串,`{noFeedback?, feedbackDelay?}` | 点击结果 `{ok, tag, feedback?}`;默认带操作后反馈(`feedback:{lines, summary, tabs:{opened, closed}}`),`{noFeedback:true}` 关闭、`{feedbackDelay:500}` 改等待时长 |
| `cdp.click(target, {ref: 12})` | 对象,`{ref:n}` | 按 tree 输出的 ref 序号点真实元素(穿透 shadow,零 XPath);同上带反馈 |
| `cdp.fill(target, selector, value, opts?)` | 对象,字符串,字符串,`{noFeedback?, feedbackDelay?}` | 填充结果 `{ok, tag, feedback?}`;同上带反馈 |
| `cdp.fill(target, {ref: 12}, value)` | 对象,`{ref:n}`,字符串 | 按 ref 填值(穿透 shadow);同上带反馈 |
| `cdp.waitFor(target, selector, opts?)` | 对象,字符串,`{timeout,interval}` | 布尔(超时抛错) |
| `cdp.waitForFn(target, jsExpr, opts?)` | 对象,字符串,`{timeout,interval}` | 布尔(等 JS 布尔表达式为真,超时抛错)。**只吃同步布尔表达式**,如 `document.querySelector('#x') !== null`;别传 async/Promise/`return` 函数(会 `Unexpected token`) |
| `cdp.focus(target, selector, opts?)` | 对象,字符串,`{noFeedback?, feedbackDelay?}` | 聚焦结果 `{ok, tag, feedback?}`;同上带反馈 |
| `cdp.focus(target, {ref: 12})` | 对象,`{ref:n}` | 按 ref 聚焦(穿透 shadow);同上带反馈 |
| `cdp.getFocus(target)` | 对象 | 焦点元素信息或 null |
| `cdp.pressKey(target, "Ctrl+Shift+A", opts?)` | 对象,字符串,`{noFeedback?, feedbackDelay?}` | `{ok, feedback?}`;同上带反馈(滚动触发懒加载也回反馈) |
| `cdp.hover(target, selector, opts?)` | 对象,字符串,`{noFeedback?, feedbackDelay?}` | `{ok, feedback?}`;同上带反馈 |
| `cdp.hover(target, {ref: 12})` | 对象,`{ref:n}` | 按 ref 悬停(穿透 shadow);同上带反馈 |
| `cdp.shot(target, file?)` | 对象,字符串可选 | 截图文件路径 |
| `cdp.logs(target, opts?)` | 对象,`{level,since}` | 控制台日志条目数组(自动拉起 daemon) |

## 常见错误

- **eval 拿不到结果** → 已用 `returnByValue + awaitPromise`;跨域 iframe 内的元素需用 `contentDocument` 单独取。
- **click 没生效** → `el.click()` 是合成事件;若组件不吃,用 `eval` 调组件方法,或截图定位后真坐标点击。
- **多 tab 匹配错** → title 相似时用完整 id。
- **`navigate` 后 target 对象的 `url`/`title` 是快照,不刷新** → 判断跳转是否成功用 `cdp.eval(t, 'location.href')`,别信 target 对象的缓存字段。
- **`open` 失败/脚本中断会留下已建的 tab**(open 已建 target,后续报错不会自动关)→ 记得 `list` 核对后用 `close` 清理。
- **SPA(知乎热榜这类)首屏加载慢,固定 sleep 不一定够** → 优先用 `waitFor`/`waitForFn` 等条件出现,别死等固定时长。
- **连接失败** → 别手动排查端口,**先跑 `ensure`** 让它自动启动浏览器;仍失败再用 `CDP_HOST/CDP_PORT` 指端口,或确认浏览器没被别的占用。
- **fill 对富文本框无效** → 已派发 input/change;React 等框架可能需额外 setter,改用 `eval` 按框架方式设值。
- **logs 拿不到历史日志** → daemon 只在 attach **之后**才收;页面加载早期的日志、attach 前已有的日志读不到。想抓加载期日志要在导航**前**种上监听(open/ensure 已自动种)。
- **`--target 5173` 匹配到 DevTools 窗** → DevTools 的 url/title 也含 `5173`。用**完整 targetId** 精确指定(见 `list`)。
- **监听 daemon 没起/日志读空** → 无需手动管 daemon(无 listen/listen-stop);`logs` 本身会幂等拉起并补种监控。若仍读空,多半是刚开的新 tab(见上方「已知限制」~0.5–2s 才装上),先 `await sleep(1500)` 再读。
