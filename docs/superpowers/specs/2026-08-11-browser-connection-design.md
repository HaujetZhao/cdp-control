# 2026-08-11 浏览器连接重设计

> 服务对象：DESIGN.md「浏览器连接」枝——「探测用户可用 / 默认浏览器，独立用户数据目录拉起 CDP 端口」「一切命令自愈式确保连接（未起自动启动、就绪零开销），agent 不管理浏览器生命周期」。
> 经一轮事实调研 + 一轮源码审计 + 三路对抗性子代理审查后，按用户关键决定收敛：**端口固定 9222**；「保证可用」= 未启动时自动探查并自动拉起。本文档只锁抽象决策与不变量，实现细节落 CLAUDE.md / 源码。

## 问题

当前 `src/browser.ts` 的 `ensureBrowser` 是非常 proto 的临时方案，几处不成立：

1. **跨平台缺失（主问题）**：`findBrowserExe` 只认 Windows（Edge/Chrome 路径表）。macOS / Linux 直接不可用——「各系统都可用」不成立。
2. **"一切命令自愈"不成立**：只有 `list`/`fetch` 显式 `ensure`；所有 target 命令（view/click/fill/eval/navigate/article/logs/shot/...）走 `needTarget → api.resolve`，**不 ensure**，浏览器没起就报连接错误。
3. **依赖逻辑环**：`browser → api`（ensureBrowser 的 url 分支调 api.open/navigate）。
4. **就绪/启动各发一次 GET**：`isBrowserReady` 与 `probeBrowserName` 分两次 GET `/json/version`，未合并。

## 选型

浏览器发现/启动**不引入浏览器启动库**，全自研（仅用 Node 内建 `child_process`）。这不是"避免依赖"——日后有契合的成熟库（如引入 playwright 后）随时复用；而是通用浏览器启动库发现不含 Edge（本项目默认浏览器）、单次启动模型不契合持久自愈，硬塞是错配。依赖取舍原则见 CLAUDE.md（优先成熟库、没有才现写）。

## 端口与"可用"语义（用户决定）

- **端口固定 9222**（`CDP_PORT` env 仍可覆盖；transport 的 `PORT` 保持模块级常量，不需状态文件 / 随机端口 / setPort）。
- **"保证可用"= 未启动时自动探查并自动启动**：
  - **已启动**（9222 上有响应）→ 直接连上用，零额外开销（1 次 GET `/json/version`，顺便拿 Browser 字段推断浏览器名）。
  - **未启动** → 自动发现可用浏览器、以独立 user-data-dir 拉起 CDP 端口，轮询就绪后连上。
- 身份不做特殊校验：9222 上是什么就是什么（可能是本工具先前起的隔离浏览器，也可能是用户自己开的调试浏览器——后者即"驱动用户真实浏览器"语义，按用户决定接受）。

## 决策

### D1 浏览器发现 `browser-discover.ts`（新，纯函数可单测）

- 输入 platform + 环境，输出**有序候选列表** `[{exe, kind}]`（kind ∈ edge|chrome|chromium|brave|arc），按优先级排序。冷启动逐个尝试，起失败/超时 → 降级下一候选（配合 D4 的 `--no-sandbox` 重试）。
- **Windows**：env 路径表（`PROGRAMFILES` / `PROGRAMFILES(X86)` / `ProgramW6432` / `LOCALAPPDATA`）+ Edge stable/Beta/Dev 通道路径 + Chrome，`where` 兜底。Edge 优先。
- **macOS**：**硬编码精确 `.app` 名 + `Contents/MacOS/<精确可执行名>`**（不得 glob 模糊），扫 `/Applications` 与 `~/Applications`，/Applications 优先；优先级 edge > chrome > chromium > brave > arc。**Safari 不进白名单**（非 CDP 协议）。注意各浏览器 bin 名可能与 .app 名不一致（`Brave Browser.app` 里是 `Brave Browser`、`Microsoft Edge.app` 里是 `Microsoft Edge`，含空格）。
- **Linux**：`command -v` 查 `google-chrome-stable|google-chrome|chromium|chromium-browser|microsoft-edge-stable|microsoft-edge` + `.desktop` 文件 grep（`Exec=` 路径）。snap / flatpak 记为已知局限（snap shim 沙箱行为特殊、flatpak 可执行不在 PATH），后补，不阻塞主路径。
- 候选列表可注入假 platform / 假路径，单测验证优先级与解析。

### D2 `ensureBrowser()`（browser.ts 重写）

- 依赖仅 transport + monitor + browser-discover（另用 node:child_process spawn）。**不再依赖 api**（去掉 open/navigate 分支；URL 打开归 api.open）→ 无环，api 可 import browser。
- **ready 路径**：1 次 GET `/json/version` → 有 `webSocketDebuggerUrl` 即 ready，返回（一次拿到 Browser 字段，合并原 isBrowserReady + probeBrowserName 的两次 GET）。
- **冷启动路径**：
  1. discover 候选 → 逐候选 `spawn(exe, flags, { detached:true, stdio:'ignore' }).unref()`，端口固定 `--remote-debugging-port=9222`（或 CDP_PORT）。
  2. 轮询 `GET /json/version` 就绪（每 ~400ms，超时 ~20s）；失败 → 杀该进程（win `taskkill /T` / 其他 SIGKILL）→ 降级下一候选。
  3. 成功 → `maybeSpawnDaemon()` → 打印"已自动启动 <kind> (端口 X)"。
- **userDataDir**：`~/.cdp-control/user-data`（独立 profile，DESIGN「独立用户数据目录」）。仅冷启动自启时用到；已连接态用 9222 上现成的。

### D3 冷启动 flags（自组装，跨平台差异化）

- 必需：`--remote-allow-origins=*`（Chrome 111+ 的 CDP 来源校验，Node 客户端必须）、`--no-first-run`、`--no-default-browser-check`、`--disable-background-networking`、`--disable-component-update`、`--window-size=1600,1000`（稳定 `--visible-only` 视口）。
- **Linux 必加** `--disable-dev-shm-usage`（大页面 /dev/shm 不足）。
- **默认不加 `--no-sandbox`**；仅当某候选启动超时/失败、降级重试时追加（并打印警告）。

### D4 自愈下沉到 api 层 + 连接失败自愈

- **主动 ensure**：`api.resolve` / `api.list` / `api.open` 三处前置 `ensureBrowser()`（幂等）。覆盖所有 target 命令（经 needTarget→resolve）、list、open/fetch。`ignore-link add/rm/list`（纯本地规则文件）与 `__daemon`（monitor 常驻）**显式豁免**——不 ensure。
- **反应式自愈（堵 stale target 漏洞）**：`transport.evaluate`（api 全部操作必经、daemon 不用）的连接失败分支：触发 ensureBrowser → 按 url 重新 resolve target → 重试一次；仍失败则抛清晰"target 已失，重新 view"。**不要放 `pageWs`**（cmdListen 用 pageWs，若自动 ensure 会死循环拉起浏览器）。
- cdp.ts 里 `list`/`fetch` 的显式 `api.ensure()` 删除（现冗余）。
- run/recipe 全走 api（审计确认），自动继承主动 ensure；run 脚本直传 stale target 由反应式自愈兜底。

### D5 daemon（monitor.ts 基本不变）

- daemon 用 transport 的 `PORT`（固定 9222 / CDP_PORT），端口不变故无需端口自愈逻辑。浏览器崩溃重开后仍在同一端口，daemon 每 500ms 重扫 `/json/list` 自动重附着；浏览器长期不在则看门狗自退，下次冷启动重拉。**本设计下 daemon 无需改**（现状已正确），仅确认不因 D2 移除 url 分支而受影响。

### D6 有头/可见性

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
- **9222 身份不辨**：9222 上若已有浏览器（含用户自己开的调试浏览器）直接连用，属用户接受的语义（驱动真实浏览器）；独立 user-data 隔离仅对"本工具自启"的浏览器成立。
- **平台二进制名差异**：macOS bin 含空格、Linux `chromium-browser` 符号链接、snap shim——已纳入候选重试模型。
- **snap / flatpak / Safari**：已知局限，不阻塞主路径。
