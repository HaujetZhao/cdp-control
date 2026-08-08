---
name: cdp-browser-control
description: 需要控制本地浏览器时使用——列出 tab、打开/关闭/导航页面、提取页面元素、点击、填表、执行 JS、截图,**读页面控制台日志(含嵌套对象与调用链,支持过滤)**。做自动化时,优先把整个操作写成脚本文件用 `run` 一次执行,避免分步调用导致的多次模型往返。**感知页面用 `tree`**(唯一感知命令):`tree` 输出整页 body 的文本+结构紧凑树,不做可见性判定,可选 `--selector`/`--xpath`(或 `--selector-file`/`--xpath-file` 从文件读,免 shell 转义)只建指定区域;勿盲用 class selector 读内容(会漏文本块、命中滚出屏的旧元素)。
---

# CDP 浏览器控制 (cdp-browser-control)

## Overview

本 Skill 所在目录有一个零依赖 Node 脚本 `dist/cdp.js` ，可直接连 Chrome/Edge 的 CDP 端口(默认 9222),取代 chrome-devtools MCP。核心价值:**能看到并操作手动打开的 tab**(MCP 因 Puppeteer attach 竞态会漏看)。

**重要原则——自动化时优先写脚本文件**:凡是"打开→跳转→等元素→点击→填表→读结果"这类多步操作,**不要一步步调单个命令**(那会每次发一个模型请求、每次都 prefill+decode 全量上下文)。而是把整段操作写成一个 `.js` 脚本文件,用 `node "<本 SKILL 所在目录>/dist/cdp.js" run 脚本.js` **一次执行**。脚本可反复修改重跑。

## 协作原则(重要)

- **浏览器窗口必须可见,严禁隐藏启动**。agent 和用户**共同操作同一个浏览器**:agent 驱动页面时,用户能看到并随时介入(登录、验证码、确认弹窗、agent 做不了/做错的事,用户直接在那个窗口接手)。
- 所以启动/确保浏览器时**不要用 `-WindowStyle Hidden` / headless**,要让窗口真正显示出来。
- 若 agent 卡在某一步(页面行为异常、需要人工确认等),停下来让用户在当前可见窗口里处理,不要自说自话绕开。

## When to Use

- 需要读取/操作浏览器里已手动打开的页面(知乎、财联社这种 tab)。
- 做多步自动化(填表、爬取、提交)时——此时**写脚本文件 + run** 是首选,省往返、可复用、易改。
- 只想快速看一个页面有什么元素时——用 `snapshot` 探路。

## ⚠️ 调用前唯一入口:`ensure`(必走,别自己探端口)

**不确定 CDP 浏览器是否启动时，先跑一遍 `ensure`**,`ensure` 自己处理"浏览器开没开、用哪个、要不要启动":

```bash
node "<本 SKILL 所在目录>/dist/cdp.js" ensure          # 确保浏览器已通过 CDP 就绪(不导航)
node "<本 SKILL 所在目录>/dist/cdp.js" ensure --url "<网页地址>"   # 开浏览器并直接打开该页
```

`ensure` 内部自动:
1. 检查 CDP 端口(默认 9222)是否已就绪——已就绪则直接继续。
2. 没就绪 → 自动探测默认浏览器(优先 Edge,其次 Chrome,覆盖常见安装路径)。
3. 用**独立用户数据目录**启动它(默认 `~/.cdp-browser`,可用环境变量 `CDP_USER_DATA` 覆盖)。
4. 轮询等待浏览器 ready(最多 ~15s),然后(若给了 `--url`)打开它。**冷启动**(本次由 ensure 启动的浏览器)会直接复用首个空白 tab 导航,不额外开 tab;**热启动**(浏览器已就绪)才新开一个 tab 放链接,不覆盖你现有页面。

**规范要点:**
- **必须先 `ensure`,不要一上来就 `list`/`open`**——浏览器没开时这些会报连接失败。
- 对小白用户,整个流程 agent 一次 `ensure` 完成,用户无需知道开哪个浏览器、用户数据在哪。

## 调用方式

```bash
node "<本 SKILL 所在目录>/dist/cdp.js" <子命令> [参数]
node "<本 SKILL 所在目录>/dist/cdp.js" run "./scripts/你的脚本.js"   # 在项目根执行自动化脚本
```

## 脚本放置规范(重要)

**两类脚本,放两处**:

- **任务性一次性脚本**(针对某次具体任务的打开→跳转→填表→抓取)→ 写到**当前项目的根目录**(或项目内临时目录，如 `scripts` 或 `tmp`),**不写进 skill 目录**。运行用 **`dist/cdp.js` 的绝对路径**,在项目根执行:

```bash
node "<本 SKILL 所在目录>/dist/cdp.js" run "./scripts/项目里的脚本.js"
```

- **为什么**:`run` 读取脚本和脚本里的相对路径输出(截图等)都以 `cwd`(你执行命令的那个目录)为基准。在项目根运行 → 脚本能被读、截图/生成文件直接落到项目根,**skill 目录保持干净、只有工具本身**,不会被业务脚本和输出污染。
- **绝对路径调 dist/cdp.js**:不要 `cd` 进 skill 目录再跑(那会把 cwd 变成 skill 目录,输出写进 skill)。
- **脚本自包含**:每个脚本自己用 `cdp.open(url)` 或 `cdp.resolve(url/title子串)` 定位 target,不假设"当前选中页"。这样并行跑多个脚本互不影响。
- **脚本运行环境**:`run` 脚本里只有全局 `cdp` + **白名单 `require`**(可用 `os`/`path`/`fs`/`child_process`/`crypto`/`util`/`stream`/`url`)。取临时目录/写文件:``const path = require('path'), os = require('os')``,用 `path.join(os.tmpdir(), name)` 拼路径——**勿直接用 `/tmp/xx` 前缀**(Windows 会被 `path.resolve` 解析成盘根 `D:\xx` 而 ENOENT)。
- **可复用站点原语**(针对某站点、可反复用、已验证的**单用途**脚本,如"抓某站评论"、"在某站回复")→ 升格进 **skill 的 `sites/<域名>/` 目录**(见下方「站点脚本库 sites/」)。新任务遇到同站点先查该目录,能复用的直接 `run`,避免重写。

## 站点脚本库 sites/(可复用原语)

`<本 SKILL 所在目录>/sites/` 按站点组织**已验证可复用的单用途脚本** + 每站 README 导航:

```
sites/
├── README.md            # 总索引:有哪些站、各站 README 指向、原语放置/生命周期规范
├── zhihu/
│   ├── README.md        # 此站导航:已知结构、可用原语清单、坑、验证状态
│   └── get-comments.js  # 单用途原语,头部注释含元信息
└── _template/           # 新站点脚手架(README + primitive.js 模板)
```

- **原语自包含**:每个脚本自己 `cdp.resolve(url/title 子串)` 定位 target,不假设"当前选中页";用 `cdp` 全局 + 白名单 `require`(规范与上同)。用绝对路径 `dist/cdp.js run sites/<域名>/<原语>.js` 执行。
- **头部注释模板**(每个原语必带):`用途 / 用法 / 返回结构 / 依赖的 DOM 结构假设 / 最后验证日期 / 状态(✅已验证 | ⚠️失效待修)`。
- **生命周期**:实测验证通过 → 更新"最后验证/状态";站点改版失效 → **更新或删除原语**并在该站 README 标记。README 维护"可用/失效"清单。
- **新任务流程**:用到某站 → 先看该站 README + 目录里有没有现成原语 → 能复用直接 `run`,缺什么就写新的并升格进目录(验证通过后)。

## 感知页面(核心:`tree`,唯一感知命令)

`tree` 是**唯一感知命令**,默认无参数,输出整页 body 的**文本 + 结构**紧凑树——丢垃圾标签、折叠纯包装节点、穿透 shadow DOM,按缩进层级给出"有哪些内容项 + 标签结构"。**不做可见性判定**:不筛视口、不查 computed style,整页结构一次给全(由 `hasText`/`productive` 过滤无文本壳子树控输出量)。可选 `--selector <sel>` / `--xpath <xp>` 只建指定区域(取第一个匹配,两者都传时 selector 优先),适合大页面只想看某块(如评论区/侧栏)时省上下文。`--xpath` 是 **shadow 穿透版**,实现为「合成拼接树 + 原生 evaluate」:把整页镜像成**无 shadow 的合成树**(shadowRoot 顶层子直接拼进宿主),整条路径交浏览器原生 XPath 引擎在合成树上求值——`/`、`//` 与**全部标准轴(`parent::`/`ancestor::`/`self::`/`following-sibling::`…)天然穿透任意层嵌套 shadow**,谓词与 `[n]` 语义原生正确。可照 tree 输出的结构(含 `[shadow]` 宿主)直接写一条连续路径,如 B站 `/html/body/div[2]/div[2]/div[1]/div[6]/bili-comments//bili-comment-thread-renderer[1]//bili-comment-reply-renderer//bili-rich-text//p/span` 直达评论文本;`[n]` 为标准 XPath 位置语义——候选须是其**逻辑父的拼接子**中匹配本步 node test 的第 n 个(1 基;shadow 子取宿主作逻辑父),如 `//bili-comments//bili-comment-thread-renderer[2]` 取第 2 条评论。**⚠️ 别照 tree 缩进反推 `[n]`**:tree 会折叠无文本的纯包装节点(一行 `div > div > div` 不代表真实 DOM 的三层),而 `div[n]` 是真实 DOM 里**含无文本兄弟在内**的第 n 个 div 子,tree 把无文本的都省了,所以从缩进反推位置路径基本必错。要精确定位用:①F12 右键 Copy full XPath(可直接用)②文本+谓词(如 `//*[contains(.,'…')]`)③**从文本叶向上推父链**(反推最稳):先取**最内层**含该文本的叶 `//*[contains(.,'…') and not(.//*[contains(.,'…')])]`,再 `parent::`/`ancestor::div[N]`/`ancestor-or-self::` 向上取容器。**⚠️ 别用 `[1]`**:`//*[contains(.,'…')][1]` 的 `[1]` 是 XPath 谓词、按文档序取**最外层**(html/body)——因为祖先的聚合文本(innerText 整段)也含 '…',`[1]` 选到的是 html 而非文本叶,再爬祖先只会得到整页级 junk。加 `and not(.//*[contains(.,'…')])`(自身含该文本、且任一子级都不含)才真正锁到最深处那格。④用 `cdp xpath` 分步诊断的"当时候选"逐段确认。**DevTools 右键 Copy full XPath 复制的完整路径可直接用**(含 `//` 的 shadow 穿透段);若复制的路径未命中,可用 `cdp xpath` 分步诊断定位断在哪一步。**引用文本前缀 `~`** 表示该文本是**聚合文本**(来自 innerText/grabText 兜底,真实直接文本在子元素里,如 `a ~"首页"`),反查时须用 `contains(.,'…')` 而非 `text()`(后者只匹配直接文本节点)。另注意 `//text()="X"` 这种"路径后直接等号"是**布尔 XPath**(返回 true/false,不返回节点集,现已按无命中处理不报错)——要做等值匹配应写 `//text()[.="X"]` 或 `//*[.="X"]`。**xpath/selector 优先用文件传**:凡含 `//`(尤其行首 `//`)、`[`、`]`、`"`、`'`、空格等 shell 难转义字符的,一律走 `--xpath-file <file>` / `--selector-file <file>`——Git Bash 会把行首 `//` 静默转成 `/`(如 `//h1`→`/h1`)导致查错,只有文件能绕开;文件与内联同给时**文件优先**。

- **shadow DOM 已穿透**:`tree` 会递归进入 Web Component 的 `shadowRoot`(如 B站 `<bili-comments>` 评论区、各 web-app 的自定义组件),所以这类站点的内容也能读。**带 shadowRoot 的宿主节点 tag 会追加 `[shadow]`**(如 `bili-comments[shadow]`、`bili-rich-text[shadow]`):表示其下的子树来自 shadow DOM,**CSS 选择器不能穿透**,要定位这些子树下的元素须用 `--xpath`(shadow 穿透版),别直接拿 tree 里的标签反推 CSS 选择器。
- 想**操作**(点/填)→ 用 `tree --xpath` 圈到目标块、按 tree 结构构建 xpath 定位,或用 `cdp xpath` 拿该元素的稳定 selector。
- `tree` 不带状态前缀(无 `[看]`/`[架]`/`[X]`),只看文本与结构。
- 结论:**感知一律走 `tree`**(唯一感知命令)。

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
| `tree [--target] [--selector <sel>] [--xpath <xp>] [--selector-file <file>] [--xpath-file <file>]` | **结构树(唯一感知命令)**:整页 body 的文本+结构紧凑层级树,不做可见性判定,只输出文本与结构(过滤垃圾标签/纯包装节点,穿透 shadow DOM);`--selector`/`--xpath`(或从文件 `--selector-file`/`--xpath-file` 读,省 shell 转义)可选,只建指定区域(取第一个匹配,selector 优先);`--xpath` 为 shadow 穿透版(拼接树模型,递归任意深度);selector/xpath **优先从文件读**(`--selector-file`/`--xpath-file` 免 shell 转义,行首 `//` 内联会被 shell 静默改),文件与内联同给时文件优先 |
| `xpath [path] [--xpath-file <file>] [--target]` | **按 xpath 查元素(shadow 穿透,含分步诊断)**:打印全部命中(标签/文本/稳定 selector);未命中时打印**分步诊断**,精确指出断在哪一步、当时候选是谁——用于排查 DevTools 复制的路径为何不命中。位置参数与 `--xpath-file` 二选一;路径含 `//`(行首 `//` 会被 shell 静默改成 `/`)、`"`、`[contains(...)]`、空格等难转义字符时**一律优先用 `--xpath-file` 传**,文件与位置参数同给时文件优先 |
| `click <selector> [--target]` | 点击元素(selector 用 `cdp xpath` 输出的稳定 selector) |
| `fill <selector> <值> [--target]` | 填输入框并派发 input/change |
| `focus <selector> [--target]` | 聚焦元素(配合按键用) |
| `get-focus [--target]` | 查看当前焦点元素在哪 |
| `press-key <键> [--target]` | 真实按键/组合键,如 `Enter`、`Tab`、`Ctrl+Shift+A` |
| `hover <selector> [--target]` | 鼠标移到元素上(触发 mouseover/mouseenter) |
| `shot [--file out.png] [--target]` | 截图 |
| `logs [--target] [--level error,warn] [--since <ms>] [--json]` | 读 target 控制台日志(见下方「读控制台日志」) |
| `listen` | 前台运行控制台监听 daemon(常驻后台,一般不手动调) |
| `listen-stop` | 停止控制台监听 daemon |
| `run <脚本文件>` | 执行自动化脚本(脚本里用全局 `cdp` API,可顶层 `await`) |

环境变量:`CDP_HOST` / `CDP_PORT`(默认 `127.0.0.1:9222`)、`CDP_LOGS_PORT`(监听 daemon 端口,默认 9333)。

## 读控制台日志(console 监听)

`dist/cdp.js` 用**常驻 daemon 给每个页面注入监控脚本**,把日志存进页面的 `window.__cdpLogs`,`logs` 命令再 eval 读出来——**保留对象的嵌套结构和调用链**(不是拍平的文本)。核心价值:能抓到**用户手动操作期间**打出的日志、跨多次命令/agent 回合累计、**刷新页面后监控自动补装**、支持过滤。

原理:直接监听 CDP 控制台事件拿到的只是描述文本,看不到对象嵌套结构。所以改成往页面注入 `console.*`/`onerror`/`unhandledrejection` 钩子,把**活的嵌套对象 + 调用链(stack)** 存进 `window.__cdpLogs`,读时结构化序列化。关键机制是 `Page.addScriptToEvaluateOnNewDocument`——注册在该 tab 的会话上,**每次 document 创建(含刷新)自动先跑监控脚本**,刷新自动补装,无需 daemon 探测。

- **自动装监听**:`open` / `ensure --url` 打开页面时自动拉起 daemon,它轮询 `/json/list` 给**每个** tab(含手动开的)注册监控脚本。
- **读**:`node dist/cdp.js logs [--target <匹配>] [--level error,warn] [--since <ms>] [--json]`
  - `--level` 逗号分隔按级别过滤(`debug/log/info/warn/error`);未捕获异常归 `error`。
  - `--since <毫秒时间戳>` 只取该时间点之后。
  - 默认人类可读 `[HH:MM:SS][level] args`;`--json` 输出完整结构(嵌套对象 + `stack` 调用链)给脚本/agent。
  - **读时自动补种**:`logs` 本身也会幂等注入监控脚本(防 daemon 未及装),所以对任意 tab 读都有效。
- **停止**:`node dist/cdp.js listen-stop`。daemon 端口 `CDP_LOGS_PORT`(默认 9333)。
- **生命周期**:daemon 在**浏览器关闭后约 5s 自动退出**(看门狗),不留孤儿进程;下次 `open`/`ensure`/`logs` 会自动重新拉起。所以无需手动担心残留。
- **脚本模式**:`cdp.logs(target, {level, since})` → 返回结构化日志数组,可与 `cdp.click`/`cdp.waitForFn` 配合做"跑完流程断言无报错"。

**已知限制**:
- `window.__cdpLogs` 在页面刷新后**清空**(缓冲在页面里,新 document 从头开始);监控脚本会自动补装,但历史没了。
- **首屏/加载早期的日志可能错过**:daemon 靠轮询注入,页面刚打开的几毫秒内已打的日志在注入前就跑了。agent 打开页→操作→读的场景不受影响;想抓加载早期日志需在导航前注册。
- **刚 `open` 的新 tab,立即打日志再 `logs` 读会读到空**:daemon 每 ~500ms 轮询,新 tab 打开后需 **~0.5–2s 才装上监控**;开 tab 后**先 `await sleep(1500)` 再操作/读日志**,否则首几条在监控装上前就跑掉了,读到空是正常的(不是 bug)。
- 只覆盖主线程的 console/onerror/unhandledrejection,worker 等跨 context 的异常抓不到。

## 自动化工作流(推荐)

**先探后写、写成文件、一次执行**——避免多次模型往返:

1. **探明页面**:不知道元素时,先 `node dist/cdp.js list`(看有哪些 tab)+ `node dist/cdp.js tree --target <匹配>`(感知整页结构);要操作再 `cdp xpath` 拿目标元素的稳定 selector。
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
| `cdp.tree(target, opts?)` | 对象,`{selector?,xpath?}` | 整页 body 的**文本+结构**紧凑层级树:`{ok, lines}`;不做可见性判定,输出纯文本与结构;`opts.selector`/`opts.xpath` 可选,只建指定区域(取第一个匹配,selector 优先);`opts.xpath` 为 shadow 穿透版(拼接树模型,`/`与`//`都跨任意层 shadow,支持 `[n]` 标准位置索引(逻辑父下第 n 个匹配兄弟)与 `[contains(...)]` 谓词,递归任意深度) |
| `cdp.xpath(target, path)` | 对象,字符串 | 按 xpath 查元素(shadow 穿透):`{count, matches:[{tag,text,selector}], trace:[{text,axis,input,matched,sample?}]}`;`count===0` 为未命中,`trace` 含分步诊断 |
| `cdp.click(target, selector)` | 对象,字符串 | 点击结果 |
| `cdp.fill(target, selector, value)` | 对象,字符串,字符串 | 填充结果 |
| `cdp.waitFor(target, selector, opts?)` | 对象,字符串,`{timeout,interval}` | 布尔(超时抛错) |
| `cdp.waitForFn(target, jsExpr, opts?)` | 对象,字符串,`{timeout,interval}` | 布尔(等 JS 布尔表达式为真,超时抛错) |
| `cdp.focus(target, selector)` | 对象,字符串 | 聚焦结果 |
| `cdp.getFocus(target)` | 对象 | 焦点元素信息或 null |
| `cdp.pressKey(target, "Ctrl+Shift+A")` | 对象,字符串 | — |
| `cdp.hover(target, selector)` | 对象,字符串 | — |
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
- **listen-stop 报"未发现"** → 若 health 已不可达说明其实已停(判定是轮询 health 而不是看返回值);仍想确认看 `node dist/cdp.js logs` 是否还能拉起。
