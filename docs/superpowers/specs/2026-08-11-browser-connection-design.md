# 2026-08-11 浏览器连接重设计

> 服务对象：DESIGN.md「浏览器连接」枝——「探测用户可用 / 默认浏览器，独立用户数据目录拉起 CDP 端口」「一切命令自愈式确保连接（未起自动启动、就绪零开销），agent 不管理浏览器生命周期」。
> 经一轮事实调研 + 一轮源码审计 + 三路对抗性子代理审查后收敛。本文档只锁抽象决策与不变量，实现细节落 CLAUDE.md / 源码。

## 问题

当前 `src/browser.ts` 的 `ensureBrowser` 是非常 proto 的临时方案，四处不成立：

1. **跨平台缺失**：`findBrowserExe` 只认 Windows（Edge/Chrome 路径表）。macOS / Linux 直接不可用。
2. **端口硬编码 9222 + 身份不辨**：只要 9222 有响应就"连上"，无法区分"我们的浏览器"还是"用户自己开的 CDP 浏览器"；可能接错、污染用户 profile，且静默无告警。
3. **"一切命令自愈"不成立**：只有 `list`/`fetch` 显式 `ensure`；所有 target 命令（view/click/fill/eval/navigate/article/logs/shot/...）走 `needTarget → api.resolve`，**不 ensure**，浏览器没起就报连接错误。
4. **依赖逻辑环**：`browser → api`（ensureBrowser 的 url 分支调 api.open/navigate）。
5. **transport 端口是模块级常量**，无法连动态随机端口。

## 选型

本轮浏览器发现/启动**不引入浏览器启动库**，全自研（仅用 Node 内建 `net`/`child_process`）。这不是"避免依赖"——日后有契合的成熟库（如引入 playwright 后）随时复用；而是通用浏览器启动库（如 chrome-launcher）**发现不含 Edge**（本项目默认浏览器）、**单次启动模型不契合本设计的持久自愈**、ESM 包打包有成本，硬塞是错配。依赖取舍原则见 CLAUDE.md（优先成熟库、没有才现写）。

## 决策

### D1 浏览器发现 `browser-discover.ts`（新，纯函数可单测）

- 输入 platform + 环境，输出**有序候选列表** `[{exe, kind}]`（kind ∈ edge|chrome|chromium|brave|arc），按优先级排序。冷启动逐个尝试，起失败/超时 → 降级下一候选（配合 D5 的 `--no-sandbox` 重试）。
- **Windows**：env 路径表（`PROGRAMFILES` / `PROGRAMFILES(X86)` / `ProgramW6432` / `LOCALAPPDATA`）+ Edge stable/Beta/Dev 通道路径 + Chrome，`where` 兜底。Edge 优先。
- **macOS**：**硬编码精确 `.app` 名 + `Contents/MacOS/<精确可执行名>`**（不得 glob 模糊），扫 `/Applications` 与 `~/Applications`，/Applications 优先；优先级 edge > chrome > chromium > brave > arc。**Safari 不进白名单**（非 CDP 协议）。注意各浏览器 bin 名可能与 .app 名不一致（如 `Brave Browser.app` 里是 `Brave Browser`、`Microsoft Edge.app` 里是 `Microsoft Edge`，含空格）。
- **Linux**：`command -v` 查 `google-chrome-stable|google-chrome|chromium|chromium-browser|microsoft-edge-stable|microsoft-edge` + `.desktop` 文件 grep（`Exec=` 路径）。snap / flatpak 记为已知局限（snap shim 沙箱行为特殊、flatpak 可执行不在 PATH），后补，不阻塞主路径。
- 候选列表可注入假 platform / 假路径，单测验证优先级与解析。

### D2 状态与端口 `transport.ts`（惰性化）

- `PORT`/`BASE` 改**当前端口变量**，提供 `setPort(p)`；`getJson`（唯一 HTTP 消费点）用当前端口拼 base。`pageWs` 用 target 自带 wsUrl，不受影响。
- **`setPort` 只允许冷启动路径调用一次**（launch 得端口后、返回前），ready 路径不碰；避免并发读旧 base 的竞态。
- 默认端口：env `CDP_PORT` 指定则固定且信任（用户显式接管，不做身份校验）；否则**每次冷启动 `net.listen(0)` 随机新端口** + 状态文件记忆。
- 探测需超时（`AbortSignal.timeout(2000)`），防半死浏览器 hang。

### D3 状态文件 `~/.cdp-control/browser.json`

- 内容：`{ port, kind, pid, startedAt }`。**原子写**（tmp + rename）。
- **内存缓存**：ensure 首次解析后缓存当前 `{port, kind}`，ready 路径不再读文件、只 1 次 GET `/json/version`（一次拿到 webSocketDebuggerUrl 与 Browser 字段，合并原 isBrowserReady + probeBrowserName 的两次 GET）。
- 冷启动时才写文件。

### D4 `ensureBrowser()`（browser.ts 重写）

- 依赖仅 transport + monitor + browser-discover（另用 node:net 取随机端口、node:child_process spawn）。**不再依赖 api**（去掉 open/navigate 分支；URL 打开归 api.open）→ 无环，api 可 import browser。
- **ready 路径**：内存状态有 port → 1 次 GET `/json/version` → 响应为浏览器且 kind 匹配 → ready，返回（零额外开销）。
- **冷启动路径**：
  1. `net.createServer().listen(0)` 取随机空闲端口 → 关闭，用该端口。
  2. discover 候选 → 逐候选 `spawn(exe, flags, { detached:true, stdio:'ignore' }).unref()`。
  3. 轮询 `GET /json/version` 就绪（每 ~400ms，超时 ~20s）；失败 → 杀该进程（win `taskkill /T` / 其他 SIGKILL）→ 降级下一候选。
  4. 成功 → `transport.setPort(port)` → 原子写状态 → `maybeSpawnDaemon()` → 打印"已自动启动 <kind> (端口 X)"。
- **身份模型**：只连"我们经随机端口自选并记录的端口"；kind 匹配校验。`CDP_PORT` override 视为用户显式接管、不校验。残余"用户同款浏览器偶然占我们随机端口"概率极低，记入已知局限（随机高位端口 + kind 校验已挡绝大多数）。
- **userDataDir**：沿用单目录 `~/.cdp-control/user-data`（保留已有真实 profile；自愈保证同一时刻只有一个浏览器、无跨产品同时互踩；跨浏览器切换仅偶发"custom dictionary"提示，可接受）。

### D5 冷启动 flags（自组装，跨平台差异化）

- 必需：`--remote-allow-origins=*`（Chrome 111+ 的 CDP 来源校验，Node 客户端必须）、`--no-first-run`、`--no-default-browser-check`、`--disable-background-networking`、`--disable-component-update`、`--window-size=1600,1000`（稳定 `--visible-only` 视口）。
- **Linux 必加** `--disable-dev-shm-usage`（大页面 /dev/shm 不足）。
- **默认不加 `--no-sandbox`**；仅当某候选启动超时/失败、降级重试时追加（并打印警告）。

### D6 自愈下沉到 api 层 + 连接失败自愈

- **主动 ensure**：`api.resolve` / `api.list` / `api.open` 三处前置 `ensureBrowser()`（幂等）。覆盖所有 target 命令（经 needTarget→resolve）、list、open/fetch。`ignore-link add/rm/list`（纯本地规则文件）与 `__daemon`（monitor 常驻）**显式豁免**——不 ensure。
- **反应式自愈（堵 stale target 漏洞）**：`transport.evaluate`（api 全部操作必经、daemon 不用）的连接失败分支：触发 ensureBrowser → 按 url 重新 resolve target → 重试一次；仍失败则抛清晰"target 已失，重新 view"。**不要放 `pageWs`**（cmdListen 用 pageWs，若自动 ensure 会死循环拉起浏览器）。
- cdp.ts 里 `list`/`fetch` 的显式 `api.ensure()` 删除（现冗余）。
- run/recipe 全走 api（审计确认），自动继承主动 ensure；run 脚本直传 stale target 由反应式自愈兜底。

### D7 daemon 端口自愈（monitor.ts 小改）

- **daemon 改读状态文件** `browser.json` 作为浏览器端口来源（单一事实源，不用 env 通道）。
- `cmdListen` 每轮 sync：读状态 → 若端口与 transport 当前端口不同 → `setPort` 跟上 → 复位看门狗计数器。浏览器重启换端口后，daemon 看门狗探测失败 → 重读状态 → 找到新端口 → 自动跟随，**旧 daemon 自愈而非死亡**。
- `maybeSpawnDaemon()` 保持无参（daemon 自发现端口）；单例仍由现有 health + pid 文件守卫。health 端点回显其看护的浏览器端口，供主进程比对（防"daemon 活但连旧端口"）。

### D8 有头/可见性

- 默认有头（自研 spawn 不加 headless），固定 `--window-size` 使 `--visible-only` 视口稳定可复现。headless 作为未来 `CDP_HEADLESS` 选项（本次不做）。

## 依赖环（改后）

```
transport(惰性端口)
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
- `transport` 模块级常量 `PORT`/`BASE` → 惰性当前端口。
- cdp.ts 冗余 `api.ensure()`（list/fetch）。

## 边界 / 已知局限

- **macOS / Linux 无法本机实测**：靠纯函数单测（注入假平台/假路径）+ 路径表评审 + 真实 exec 探测注入；macOS 冷启动连通性留一次真机验收项。
- **并发双冷启动**：冷启动前先探状态复用（大部分并发消成 ready）；残余窗口由"spawn 后写状态前再探一次"收口。不引入文件锁（命令要快），记为可接受。
- **平台二进制名差异**：macOS bin 含空格、Linux `chromium-browser` 符号链接、snap shim——已纳入候选重试模型。
- **snap / flatpak / Safari**：已知局限，不阻塞主路径（Linux 主流走 google-chrome / chromium / edge 的 command -v）。
