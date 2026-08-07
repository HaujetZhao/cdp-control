# 设计:cdp.js 读控制台日志(常驻 daemon)

日期:2026-08-07

## 背景与核心矛盾

读控制台日志本质是**推式 + 长连接**:要收到 `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` / `Log.entryAdded`,必须有一条**活着的 WebSocket 连着 page target 且发过 `Runtime.enable`**,事件是推给这条 WS 的。而每次 `node cdp.js xxx` 是**独立进程、跑完即退**,WS 一关事件就断。

用户需求(经 brainstorming 澄清):
1. **监听窗口跨 agent 回合 + 用户手动操作**:打开页 → 用户操作 → 之后 agent 再读。
2. **打开页面时自动装监听器**,读时支持过滤。
3. **刷新后监听器还能接着用**(硬性要求)。
4. **读不到时自动补种**,不多一轮交互。

结论:**必须有一个常驻监听进程**持续持有 WS、缓冲事件,agent 读时查它的本地 HTTP 接口。CDP 事件挂在 target 上,`Runtime.enable` 在同一 target 刷新后保持 → 刷新存活天然成立(不能用 JS 注入 `console.log=` 覆盖,那刷新即失效)。

## 架构

```
open/ensure ──spawn──▶ cdp-listen daemon(HTTP :9333,CDP_LOGS_PORT 可改)
                          │  每500ms轮询 /json/list,给每个 page target:
                          │  attach WS → Runtime.enable + Log.enable → 缓冲事件
                          ▼
日志: {ts, targetId, url, title, type(console/exception/browser), level, args}
                          ▲
logs 命令 ──HTTP GET /logs?target&level&since──┘
```

## 组件

### `listen` 子命令(daemon 主体,`cmdListen`)
- HTTP server(`node:http`,绑定 127.0.0.1:9333):
  - `GET /health` → 存活探测
  - `GET /logs?target=<子串>&level=error,warn&since=<ts>` → 带过滤取日志
  - `POST /shutdown` → 停止
- 主循环 `syncAttach` 每 500ms `getJson('/json/list')`:
  - 未 attach 的 page target → `pageWs(target, onEvent)` + `Runtime.enable` + `Log.enable`。
  - **刷新存活**:同一 target 内导航,WS 不断、enable 保持 → 事件继续进,无需特判。
  - **自动 attach 手动开的 tab**:轮询 diff 自然覆盖。
- 缓冲:`Map<targetId, {target, entries[], listeningSince}>`;每 target 封顶 2000 条 FIFO。
- WS 断开 → `attached.delete(targetId)`,下轮重连;缓冲保留。

### dispatcher 改造(最小侵入)
`attachDispatcher(ws, onEvent?)`:`msg.id === undefined` 时若传了 `onEvent` 则回调 `(method, params)`。**不影响**现有单命令(不传 onEvent,事件照旧忽略)。

### 事件 → entry 映射(`handleEvent`)
- `Runtime.consoleAPICalled`:level = `params.type`,type='console',args = RemoteObject 数组经 `serializeRemoteArg` 降级(DOM/函数/循环引用 → 描述文本,防 JSON 崩)。
- `Runtime.exceptionThrown`:level='error',type='exception',args = description 截断 + line/col。
- `Log.entryAdded`:type='browser',默认查询时排除(浏览器级噪音,需显式 `--level browser`)。

### 自动种监听
`open()` 和 `ensureBrowser()`(url 分支)末尾 `maybeSpawnDaemon()`(异步、失败不阻塞)。→ agent 打开页面即自动种上。

### `logs` 子命令(读取 + 自动补种)
- `node cdp.js logs [--target <匹配>] [--level error,warn] [--since <ms>] [--json]`
- 流程:`ensureDaemon()`(不在跑则 spawn)→ `GET /logs`。daemon 侧 `/logs` 若该 target 未 attach → 当场 `attach()`(**自动补种**,只能从此刻起捕获)。
- 输出:默认人类可读 `[HH:MM:SS][level] args`;`--json` 给脚本/agent。
- `--level` 逗号分隔匹配 level;未捕获异常归 'error'。默认(不传 level)排除 `browser` 级。

### `listen-stop`
发起 `POST /shutdown`(daemon 在响应前 `process.exit`,response 被截断 reject 也算成功)→ 轮询 health 直到不可达;优雅关闭未生效再读 pid 文件 `kill` 兜底。PID 存 `os.tmpdir()/cdp-listen.pid`。

### 脚本 API
`cdp.logs(target, {level, since})` → 走 daemon HTTP 返回条目数组,供 `run` 脚本做"跑完流程断言无报错"。

## 关键修复(实测发现)
- **parseArgs 取值 bug**:`--level log` 里 `--level` 不在取值白名单 → `opts.level=true`、值被当位置参数。已把 `level`/`since` 加进 `--target/--file/--url` 那组。
- **listen-stop 判定 bug**:原以"fetch 返回值"判成败,daemon 提前 `process.exit` 导致 fetch 抛错被误判失败。改为轮询 health。

## 实测验证记录(本地 Edge + 5173)
- console.log/warn/error 按 level 正确捕获 ✓
- 未捕获异常 `throw new Error(...)` 捕获为 type=exception ✓
- `--level log` 过滤只剩 log 级、`--level error` 过滤掉 log 级 ✓
- **刷新存活**:导航后同 target 继续收到 `post-reload` 日志 ✓
- 新开自带 console 的 data 页 → 自动 attach、`logs` 读到 ✓
- `listen-stop` 正确停掉、health 不可达 ✓

## 不改的部分
- 单命令 `eval`/`snapshot` 等行为不变(不传 onEvent,事件照旧忽略)。
- 读历史日志的限制:daemon 只在 attach 之后才收;attach 前已存在的日志读不到(想抓加载期日志要在导航前种监听)。
