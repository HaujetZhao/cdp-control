# 2026-08-11 浏览器连接重设计

> 服务对象：DESIGN.md「浏览器连接」枝——「探测用户可用 / 默认浏览器，独立用户数据目录拉起 CDP 端口」「一切命令自愈式确保连接（未起自动启动、就绪零开销），agent 不管理浏览器生命周期」。
> 经一轮事实调研 + 一轮源码审计 + 三路对抗性子代理审查后，按用户关键决定收敛：**端口固定 9222**；「保证可用」= 未启动时自动探查并自动拉起；**浏览器启动命令/参数保存为 `~/.cdp-control/browser.json`，缺失则创建、存在则用、坏了则警告且不兜底、用户可改**。本文档只锁抽象决策与不变量，实现细节落 CLAUDE.md / 源码。

## 问题

当前 `src/browser.ts` 的 `ensureBrowser` 是非常 proto 的临时方案，几处不成立：

1. **跨平台缺失（主问题）**：`findBrowserExe` 只认 Windows（Edge/Chrome 路径表）。macOS / Linux 直接不可用——「各系统都可用」不成立。
2. **启动不可配置**：浏览器启动命令/参数硬编码在代码里，用户无法钉死某个浏览器/exe 或加参数。
3. **"一切命令自愈"不成立**：只有 `list`/`fetch` 显式 `ensure`；所有 target 命令（view/click/fill/eval/navigate/article/logs/shot/...）走 `needTarget → api.resolve`，**不 ensure**，浏览器没起就报连接错误。
4. **依赖逻辑环**：`browser → api`（ensureBrowser 的 url 分支调 api.open/navigate）。
5. **就绪/启动各发一次 GET**：`isBrowserReady` 与 `probeBrowserName` 分两次 GET `/json/version`，未合并。

## 选型

浏览器发现/启动**不引入浏览器启动库**，全自研（仅用 Node 内建 `child_process`）。这不是"避免依赖"——日后有契合的成熟库（如引入 playwright 后）随时复用；而是通用浏览器启动库发现不含 Edge（本项目默认浏览器）、单次启动模型不契合持久自愈，硬塞是错配。依赖取舍原则见 CLAUDE.md（优先成熟库、没有才现写）。

## 端口与"可用"语义（用户决定）

- **端口与用户数据路径均入配置**：`browser.json` 的 `port`（默认 9222）与 `userData`（默认 `~/.cdp-control/user-data`）用户可改。ensureBrowser 读配置后 `transport.setPort` 同步端口，所有命令连该端口。`CDP_PORT` env 仅在无配置时兜底默认。
- **"保证可用"= 未启动时自动探查并自动启动**：
  - **已启动**（配置端口上有响应）→ 直接连上用，零额外开销（读配置 + 1 次 GET `/json/version`，顺便拿 Browser 字段推断浏览器名）。
  - **未启动** → 读启动配置 `browser.json` 拉起浏览器（缺失则自动发现生成、坏了则警告不兜底），轮询就绪后连上。
- 身份不做特殊校验：配置端口上是什么就是什么（可能是本工具先前起的隔离浏览器，也可能是用户自己开的调试浏览器——后者即"驱动用户真实浏览器"语义，按用户决定接受）。

## 决策

### D1 启动配置 `~/.cdp-control/browser.json`（新，权威、用户可改）

- **作用**：保存浏览器启动命令、参数、端口与用户数据路径。内容（JSON）：
  ```json
  { "exe": "<浏览器绝对路径>", "kind": "edge", "args": ["--remote-allow-origins=*", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--window-size=1200,800"], "port": 9222, "userData": "~/.cdp-control/user-data" }
  ```
- **缺失** → 自动发现首个可用浏览器，用默认参数集 + 默认 port/userData 写此文件，再用它启动。
- **存在且合法** → 用它启动，**不再发现**（配置即权威，用户钉死了浏览器/exe/参数/端口/用户数据）。
- **坏了** → 打印清晰警告（JSON 解析失败 / `exe` 缺失或非字符串 / `exe` 文件不存在 / `args` 存在但非数组 / 显式 `port` 非法），**不 fallback 到发现**，报错让用户改文件。
- **用户可改**：改 `exe` 指向特定浏览器/安装，改 `args` 加/删参数（如受限环境加 `--no-sandbox`），改 `port` 换调试端口，改 `userData` 换独立 profile 目录。`--remote-debugging-port` 与 `--user-data-dir` 由工具据 `port`/`userData` 生成。
- 原子写（tmp + rename）。

### D2 浏览器发现 `browser-discover.ts`（新，纯函数可单测，仅 bootstrap）

- **只在 D1 配置缺失时引导生成**；配置存在后不再调用。
- 输入 platform + 环境，输出**有序候选列表** `[{exe, kind}]`（kind ∈ edge|chrome|chromium|brave|arc），按优先级排序；逐个尝试，首个能拉起者写入配置。
- **Windows**：env 路径表（`PROGRAMFILES` / `PROGRAMFILES(X86)` / `ProgramW6432` / `LOCALAPPDATA`）+ Edge stable/Beta/Dev 通道路径 + Chrome，`where` 兜底。Edge 优先。
- **macOS**：**硬编码精确 `.app` 名 + `Contents/MacOS/<精确可执行名>`**（不得 glob 模糊），扫 `/Applications` 与 `~/Applications`，/Applications 优先；优先级 edge > chrome > chromium > brave > arc。**Safari 不进白名单**（非 CDP）。注意 bin 名可能与 .app 名不一致（`Brave Browser.app` 里是 `Brave Browser`、`Microsoft Edge.app` 里是 `Microsoft Edge`，含空格）。
- **Linux**：`command -v` 查 `google-chrome-stable|google-chrome|chromium|chromium-browser|microsoft-edge-stable|microsoft-edge` + `.desktop` 文件 grep（`Exec=` 路径）。snap / flatpak 记为已知局限，后补，不阻塞主路径。
- 候选列表可注入假 platform / 假路径，单测验证优先级与解析。

### D3 `ensureBrowser()`（browser.ts 重写）

- 依赖仅 transport + monitor + browser-discover（另用 node:child_process spawn）。**不再依赖 api**（去掉 open/navigate 分支；URL 打开归 api.open）→ 无环，api 可 import browser。
- **ready 路径**：读配置 → `transport.setPort(cfg.port)` → 1 次 GET `/json/version` → 有 `webSocketDebuggerUrl` 即 ready，返回（一次拿到 Browser 字段，合并原两次 GET）。
- **冷启动路径**：
  1. 读配置 `browser.json`：
     - 缺失 → discover 候选逐个尝试，首个能拉起者把 `{exe, kind, args:默认集, port:默认, userData:默认}` 原子写配置，用该 exe 继续。
     - 存在且合法 → 用其 `exe`+`args`+`port`+`userData`。
     - 坏 → 警告 + 报错，不兜底。
  2. `spawn(exe, [...args, --remote-debugging-port=<cfg.port>, --user-data-dir=<cfg.userData>], { detached:true, stdio:'ignore' }).unref()`。
  3. 轮询 `GET /json/version` 就绪（每 ~400ms，超时 ~20s）；失败 → 杀该进程（win `taskkill /T` / 其他 SIGKILL）→ 报错（配置在就不换浏览器，按"不兜底"）。仅 bootstrap（无配置）时失败才试下一候选。
  4. 成功 → `maybeSpawnDaemon()` → 打印"已自动启动 <kind> (端口 X)"。
- **userDataDir**：取 `cfg.userData`（默认 `~/.cdp-control/user-data`，独立 profile，DESIGN「独立用户数据目录」）。仅冷启动自启时用到；已连接态用配置端口上现成的。

### D3.5 `kill` 命令

- **端口从 browser.json 读**（`cfg.port`），**不**用默认 9222。
- **无配置 → kill 不生效**（返回 noConfig，不做事）。
- 损坏配置 → 无法确定端口，报 broken、不 kill。
- 找监听进程（netstat/lsof → pid）→ taskkill `/F /T`/SIGKILL → 等端口释放（Edge 崩溃自启会重绑，等待确认）。

### D4 默认参数集（写入配置 args）

- 写入 D1 配置的 `args`：`--remote-allow-origins=*`（Chrome 111+ CDP 来源校验，Node 客户端必须）、`--no-first-run`、`--no-default-browser-check`、`--disable-background-networking`、`--disable-component-update`、`--window-size=1200,800`（稳定 `--visible-only` 视口）。
- **Linux 默认加** `--disable-dev-shm-usage`（大页面 /dev/shm 不足）。
- **不加 `--no-sandbox`**；用户需要时自己在配置 args 里加（"不兜底"）。
- 以上是**首次生成配置时的默认值**；用户改过则以其为准，工具不覆盖。

### D5 自愈下沉到 api 层 + 连接失败自愈

- **主动 ensure**：`api.resolve` / `api.list` / `api.open` 三处前置 `ensureBrowser()`（幂等）。覆盖所有 target 命令（经 needTarget→resolve）、list、open/fetch。`ignore-link add/rm/list`（纯本地规则文件）与 `__daemon`（monitor 常驻）**显式豁免**——不 ensure。
- **反应式自愈（堵 stale target 漏洞）**：`transport.evaluate`（api 全部操作必经、daemon 不用）的连接失败分支：触发 ensureBrowser → 按 url 重新 resolve target → 重试一次；仍失败则抛清晰"target 已失，重新 view"。**不要放 `pageWs`**（cmdListen 用 pageWs，若自动 ensure 会死循环拉起浏览器）。
- cdp.ts 里 `list`/`fetch` 的显式 `api.ensure()` 删除（现冗余）。
- run/recipe 全走 api（审计确认），自动继承主动 ensure；run 脚本直传 stale target 由反应式自愈兜底。

### D6 daemon（monitor.ts 小改）

- daemon 经 `spawnDaemon` 以 `env.CDP_PORT = transport.PORT` 拉起，而 `PORT` 已由 ensureBrowser 从 `browser.json` 的 `port` 同步 → daemon 连对端口。端口在配置里稳定（用户改配置换端口后，旧 daemon 看门狗自退、下次冷启动重拉新端口 daemon）。daemon 每 500ms 重扫 `/json/list` 自动重附着；浏览器长期不在则看门狗自退。仅确认不因 D3 移除 url 分支而受影响。

### D7 有头/可见性

- 默认有头（自研 spawn 不加 headless），固定 `--window-size` 使 `--visible-only` 视口稳定可复现。headless 作为未来 `CDP_HEADLESS` 选项（本次不做）。

## 依赖环（改后）

```
transport
   ↑                ↑
 inject-loader      browser-discover
   ↑                ↑
 monitor            browser(ensureBrowser)
   ↑                ↑
   └──────── api ←────┘   (api.resolve/list/open 前置 ensureBrowser)
        ↑
      cdp.ts
```

无环。`api → browser → {transport, monitor, browser-discover}`；`api → monitor → {transport, inject-loader}`；`browser → monitor → {transport}`。browser 不再依赖 api。

## 明确的删除（零兼容）

- `findBrowserExe` 的 Windows 单平台路径表 → browser-discover 替换。
- `browser.ts` 对 api 的依赖（open/navigate）→ 移除。
- `isBrowserReady` 与 `probeBrowserName` 两次 GET → 合并为 ready 路径一次 GET。
- cdp.ts 冗余 `api.ensure()`（list/fetch）。

## 边界 / 已知局限

- **macOS / Linux 无法本机实测**：靠纯函数单测（注入假平台/假路径）+ 路径表评审；macOS 冷启动连通性留一次真机验收项。
- **配置端口身份不辨**：配置端口上若已有浏览器（含用户自己开的调试浏览器）直接连用，属用户接受的语义（驱动真实浏览器）；独立 user-data 隔离仅对"本工具自启"的浏览器成立。
- **配置"不兜底"**：配置坏了（exe 不存在等）只警告报错，不自动 fallback；用户自行修改 `~/.cdp-control/browser.json`。这是有意的设计。
- **平台二进制名差异**：macOS bin 含空格、Linux `chromium-browser` 符号链接、snap shim——已纳入 bootstrap 候选模型。
- **snap / flatpak / Safari**：已知局限，不阻塞主路径。
