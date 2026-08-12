# 固定端口、占用即杀：浏览器启动端口语义重设计

日期：2026-08-12
状态：已批准（用户拍板两个边界点）

## 背景与动机

旧实现（`src/browser.ts`）采用「端口避让」：`ensureBrowser` 发现配置端口被占且不就绪时，
会换一个空闲端口拉起浏览器，并把漂移后的端口回写 `browser.json`。这带来几个问题：

- 用户配置的端口被静默改掉，`kill` 从配置读端口却找不到刚漂移的实例，两者不一致。
- 9222 是 CDP 业界共识端口；本工具被设计成「电脑上只有一个 CDP 浏览器实例、大家协作」。
  端口避让违背这个心智模型，反而掩盖了「占着 9222 却不应答」的坏实例。

本设计把语义改为：**配置哪个端口，就用哪个端口，绝不避让**。

## 核心语义

```
ensureBrowser():
  cfg = loadConfig();  setPort(cfg.port)          // 同步端口
  probe = GET /json/version
  if probe.ready:  return ready                    // ① 端口就绪 → 直接用（就绪零开销）

  pid = findPortListeners(cfg.port)                // 未就绪 → 查谁占着这个端口
  if pid != null:
    等待 probeReadySoon(3s)                        // ② 也许只是刚拉起、还在启动
    if ready:  return ready
    freePortByPid(pid)                             // ③ 仍不应答 → 占用者坏了 → 杀掉、等释放

  coldStart(cfg.port)                              // ④ 固定「配置端口」拉起，绝不避让、绝不漂移
  return started
```

四个分支，覆盖全部状态：

1. **端口就绪** → 直接复用（就绪零开销，1 次 GET）。
2. **端口绑定但短暂不应答**（另一个并发 `cdp-control` 刚拉起、正在启动）→ 等 3s 后判定，
   能起来就用，避免误杀。
3. **端口绑定、等 3s 仍不应答**（坏实例）→ 杀掉占用者、等端口释放。
4. **端口空闲**（或杀完后）→ 固定配置端口拉起。

**关键点：永远用 `cfg.port`，不换端口、不回写漂移。**

## 删除 vs 保留（对 PR#1/#2 的处置）

### 删除（违背「不避让」）

- `port.ts` 的 `portFree` / `findFreePort`（端口避让探测）。
- `launchReady` 的「换空闲口重试」逻辑。
- 端口漂移后自动回写 `browser.json` 的行为。

### 保留并归位（按新语义）

| 项 | 处置 |
|---|---|
| PR#1 #2 kill 检测升级（`parseNetstatListeners`：只认 `LISTENING`、精确端口、杀全部监听 pid）| **抽成共享纯函数** `findPortListeners(port)`，`kill` 命令与 `ensureBrowser` 热路径共用。它在每次启动失败时兜底，比原来更重要 |
| PR#2 `probeReadySoon`（3s 轮询）| 保留，作为「区分真坏 vs 还在起」的守卫 |
| PR#2 `writeConfigAtomic` pid 后缀 | 保留（并发回写互踩修复，与本改动正交） |
| PR#1 #3 错误提示 | 语义变化：原「找到但未就绪」现在自动处理掉（杀+重启）；错误只剩「候选都不存在」 |

## 已拍板的边界

1. **3s 等待守卫**：保留。`probeReadySoon` 用 3s 轮询 `/json/version`，区分「坏实例」与
   「并发刚拉起的浏览器」——A 拉起中、B 一到就误杀会触发连环重启。
2. **非浏览器进程占 9222 的边界**：如果 9222 被非浏览器服务（恰好 LISTEN、永不答
   `/json/version`）占着，本流程会杀掉它。这是「9222 是 CDP 共识端口、占用不应答即坏」的
   直接推论，用户确认接受，不做进程名防护。

## 实现要点

- `src/browser.ts`：重写 `ensureBrowser`；新增 `probeReadySoon`（3s 轮询 `/json/version`）；
  抽出 `findPortListeners(port)` 与 `freePortByPid(pid)`；`coldStart` 固定用 `cfg.port`。
- `killBrowser` 复用 `findPortListeners`，消除 `pidOnPort` 的重复。
- 新增纯函数单测：`findPortListeners` 的 `parseNetstatListeners` 解析（含 `:92220` 误匹配、
  ESTABLISHED 行、IPv6 行、精确端口匹配）。
- 无新增平台分支；`node:child_process` / `netstat` / `lsof` 原语与现状一致。

## 测试

- 单测：`parseNetstatListeners` 纯函数（跨平台可跑）。
- 真机（Win，CDP 9222）：就绪复用 / 空闲拉起 / 绑定不应答→杀→重启，三态各验一次。
