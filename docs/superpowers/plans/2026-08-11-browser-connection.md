# 浏览器连接重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跨平台（Windows/macOS/Linux）探测并拉起浏览器，端口固定 9222，启动命令/参数落 `~/.cdp-control/browser.json`（缺失创建/存在用/坏警告不兜底/用户可改），并让"一切命令"自愈式确保连接。

**Architecture:** 新增 `browser-discover.ts`（纯函数候选发现，仅 bootstrap）；重写 `browser.ts`（读配置/冷启动/就绪探活，不再依赖 api）；`api.ts` 在 resolve/list/open 前置 `ensureBrowser()` + 连接失败反应式自愈（堵 stale target）；`transport.ts` 给 `getJson` 加超时。依赖解除 `browser→api` 环。

**Tech Stack:** Node 21+，TypeScript，Node 内建 `child_process`/`fs`/`os`/`net`。零新增运行时包。构建 `npm run build`（esbuild），测试 `npm test`（node:test）。

**依据 spec:** `docs/superpowers/specs/2026-08-11-browser-connection-design.md`（D1–D7）。

---

## 文件结构

- **新增** `src/browser-discover.ts`：`discoverCandidates(platform)` 纯函数，输出有序候选 `{exe, kind}[]`。
- **重写** `src/browser.ts`：`ensureBrowser()` + `browserConfigPath()` + `parseBrowserConfig()` + `defaultArgs()` + `loadConfig()` + 冷启动 bootstrap。
- **修改** `src/transport.ts`：`getJson(path, timeoutMs?)` 加超时。
- **修改** `src/api.ts`：resolve/list/open 前置 `ensureBrowser()`；`connectTarget()` 连接失败自愈，供 `invoke`/`withPage` 用。
- **修改** `src/cdp.ts`：删 list/fetch 冗余 `api.ensure()`。
- **新增测试** `tests/browser-discover.test.ts`（候选顺序/平台）、`tests/browser-config.test.ts`（parseBrowserConfig 好/坏、defaultArgs）。
- **文档** `CLAUDE.md`：browser 层与 browser.json 契约。

---

## Task 1: `browser-discover.ts` 候选发现（纯函数，TDD）

**Files:**
- Create: `src/browser-discover.ts`
- Test: `tests/browser-discover.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/browser-discover.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCandidates } from '../src/browser-discover.ts';

test('win32: Edge 优先于 Chrome，路径来自 env 表', () => {
  const c = discoverCandidates('win32');
  assert.ok(c.length > 0);
  const kinds = c.map(x => x.kind);
  assert.equal(kinds[0], 'edge', 'Edge 应排最前');
  assert.ok(kinds.some(k => k === 'chrome'));
  assert.ok(c[0].exe.includes('msedge.exe'));
  assert.ok(c.find(x => x.kind === 'chrome')!.exe.includes('chrome.exe'));
});

test('darwin: 精确 .app+bin 名，Safari 不在列表，Edge 优先', () => {
  const c = discoverCandidates('darwin');
  assert.equal(c[0].kind, 'edge');
  assert.ok(c[0].exe.includes('/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), 'bin 名含空格');
  assert.ok(c.find(x => x.kind === 'brave')!.exe.includes('Brave Browser'));
  assert.ok(!c.some(x => x.exe.includes('Safari')));
});

test('linux: command -v 名称齐全，microsoft-edge 判为 edge', () => {
  const c = discoverCandidates('linux');
  const names = c.map(x => x.exe);
  assert.ok(names.includes('google-chrome-stable'));
  assert.ok(names.includes('chromium'));
  assert.ok(names.includes('microsoft-edge-stable'));
  assert.equal(c.find(x => x.exe.includes('microsoft-edge'))!.kind, 'edge');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx tsx tests/browser-discover.test.ts` (或 `npm test` 会因文件不存在报错)
Expected: FAIL（模块不存在）

> 注：项目测试用 `node --test tests/*.test.ts` 直接跑 TS。确认现有测试怎么跑——见 Step 4。

- [ ] **Step 3: 实现**

```ts
// src/browser-discover.ts
/** 跨平台浏览器候选发现(纯函数,零 fs)。ensureBrowser 用它拿候选,再 existsSync/command -v 过滤。 */
export type BrowserKind = 'edge' | 'chrome' | 'chromium' | 'brave' | 'arc';
export interface Candidate { exe: string; kind: BrowserKind; }

function env() {
  return {
    pf: process.env.PROGRAMFILES || 'C:/Program Files',
    pf86: process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)',
    pw64: process.env.ProgramW6432 || process.env.PROGRAMFILES || 'C:/Program Files',
    la: process.env.LOCALAPPDATA || '',
    home: process.env.HOME || process.env.USERPROFILE || '',
  };
}

function windows(e: ReturnType<typeof env>): Candidate[] {
  const edge = [
    `${e.pf86}/Microsoft/Edge/Application/msedge.exe`,
    `${e.pf}/Microsoft/Edge/Application/msedge.exe`,
    `${e.la}/Microsoft/Edge/Application/msedge.exe`,
    `${e.pf86}/Microsoft/Edge Beta/Application/msedge.exe`,
    `${e.pf86}/Microsoft/Edge Dev/Application/msedge.exe`,
  ];
  const chrome = [
    `${e.pw64}/Google/Chrome/Application/chrome.exe`,
    `${e.pf86}/Google/Chrome/Application/chrome.exe`,
    `${e.la}/Google/Chrome/Application/chrome.exe`,
  ];
  return [
    ...edge.map(p => ({ exe: p, kind: 'edge' as const })),
    ...chrome.map(p => ({ exe: p, kind: 'chrome' as const })),
  ];
}

function macos(e: ReturnType<typeof env>): Candidate[] {
  // 精确 .app 名 + Contents/MacOS/<精确可执行名>(bin 名与 .app 名可不一致、可含空格)。
  const apps = [
    { name: 'Microsoft Edge', bin: 'Microsoft Edge', kind: 'edge' as const },
    { name: 'Google Chrome', bin: 'Google Chrome', kind: 'chrome' as const },
    { name: 'Chromium', bin: 'Chromium', kind: 'chromium' as const },
    { name: 'Brave Browser', bin: 'Brave Browser', kind: 'brave' as const },
    { name: 'Arc', bin: 'Arc', kind: 'arc' as const },
  ];
  const roots = ['/Applications', `${e.home}/Applications`];
  const out: Candidate[] = [];
  for (const root of roots) {
    for (const a of apps) out.push({ exe: `${root}/${a.name}.app/Contents/MacOS/${a.bin}`, kind: a.kind });
  }
  return out;
}

function linux(_e: ReturnType<typeof env>): Candidate[] {
  const names = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable', 'microsoft-edge'];
  return names.map(n => ({ exe: n, kind: (/edge/.test(n) ? 'edge' : 'chrome') as BrowserKind }));
}

/** 输出按平台、按优先级排序的候选列表(win/mac 为绝对路径,linux 为 command -v 名称)。 */
export function discoverCandidates(platform: string = process.platform): Candidate[] {
  const e = env();
  if (platform === 'win32') return windows(e);
  if (platform === 'darwin') return macos(e);
  return linux(e);
}
```

- [ ] **Step 4: 确认测试命令并跑通**

先确认现有测试怎么跑：`cat package.json | grep test`。
Run: `npm test`
Expected: 新 3 个测试 PASS，原有测试仍 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/browser-discover.ts tests/browser-discover.test.ts
git commit -m "feat(browser): 跨平台浏览器候选发现 discoverCandidates(win/mac/linux)"
```

---

## Task 2: `transport.ts` getJson 加超时

**Files:**
- Modify: `src/transport.ts`（`getJson`）

- [ ] **Step 1: 改实现（给 getJson 加可选的 AbortSignal 超时，默认 5000ms，向后兼容）**

```ts
export async function getJson(path: string, timeoutMs = 5000): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status} GET ${path}`);
  return r.json();
}
```

- [ ] **Step 2: 确认现有测试仍过**

Run: `npm test`
Expected: PASS（transport.test 未改，getJson 签名兼容默认值）

- [ ] **Step 3: Commit**

```bash
git add src/transport.ts
git commit -m "feat(transport): getJson 加 AbortSignal.timeout 超时"
```

---

## Task 3: `browser-config.ts` 配置解析（纯函数，TDD）

**Files:**
- Create: `src/browser-config.ts`
- Test: `tests/browser-config.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/browser-config.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBrowserConfig, defaultArgs, browserConfigPath } from '../src/browser-config.ts';

test('parseBrowserConfig: 合法 JSON 解析', () => {
  const c = parseBrowserConfig('{ "exe": "/x/msedge.exe", "kind": "edge", "args": ["--no-first-run"] }');
  assert.equal(c.exe, '/x/msedge.exe');
  assert.equal(c.kind, 'edge');
  assert.deepEqual(c.args, ['--no-first-run']);
});

test('parseBrowserConfig: args 缺省为空数组', () => {
  const c = parseBrowserConfig('{ "exe": "/x/msedge.exe" }');
  assert.deepEqual(c.args, []);
});

test('parseBrowserConfig: 非 JSON 抛清晰错', () => {
  assert.throws(() => parseBrowserConfig('not json'), /不是合法 JSON/);
});

test('parseBrowserConfig: 缺 exe 抛清晰错', () => {
  assert.throws(() => parseBrowserConfig('{ "kind": "edge" }'), /缺 exe/);
});

test('parseBrowserConfig: args 非数组抛清晰错', () => {
  assert.throws(() => parseBrowserConfig('{ "exe": "/x", "args": "nope" }'), /args 必须是/);
});

test('defaultArgs: 通用集 + linux 加 disable-dev-shm-usage', () => {
  assert.ok(defaultArgs('win32').includes('--remote-allow-origins=*'));
  assert.ok(defaultArgs('linux').includes('--disable-dev-shm-usage'));
  assert.ok(!defaultArgs('win32').includes('--disable-dev-shm-usage'));
});

test('browserConfigPath: 落在 ~/.cdp-control/browser.json', () => {
  assert.match(browserConfigPath(), /\.cdp-control[\\/]browser\.json$/);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/browser-config.ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BrowserKind } from './browser-discover';

export interface BrowserConfig { exe: string; kind: BrowserKind; args: string[]; }

export function browserConfigPath(): string {
  return join(homedir(), '.cdp-control', 'browser.json');
}

const KINDS: BrowserKind[] = ['edge', 'chrome', 'chromium', 'brave', 'arc'];

/** 解析 browser.json 文本；损坏则抛清晰错误(供调用方警告、不兜底)。 */
export function parseBrowserConfig(text: string): BrowserConfig {
  let obj: any;
  try { obj = JSON.parse(text); } catch (e: any) { throw new Error(`browser.json 不是合法 JSON: ${e.message}`); }
  if (!obj || typeof obj.exe !== 'string' || !obj.exe.trim()) throw new Error('browser.json 缺 exe(浏览器可执行文件绝对路径)');
  if (obj.kind != null && !KINDS.includes(obj.kind)) throw new Error(`browser.json 的 kind 非法: ${obj.kind}(应为 ${KINDS.join('|')})`);
  if (obj.args != null && !Array.isArray(obj.args)) throw new Error('browser.json 的 args 必须是字符串数组');
  if (Array.isArray(obj.args) && obj.args.some((a: unknown) => typeof a !== 'string')) throw new Error('browser.json 的 args 必须全是字符串');
  return { exe: obj.exe.trim(), kind: obj.kind || 'chrome', args: Array.isArray(obj.args) ? obj.args : [] };
}

/** 首次生成配置时的默认 args(用户改过则以用户为准,工具不覆盖)。 */
export function defaultArgs(platform: string = process.platform): string[] {
  const args = [
    '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--window-size=1600,1000',
  ];
  if (platform === 'linux') args.push('--disable-dev-shm-usage');
  return args;
}
```

- [ ] **Step 4: 跑通**

Run: `npm test`
Expected: 新测试 PASS，原有 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/browser-config.ts tests/browser-config.test.ts
git commit -m "feat(browser): browser.json 配置解析 parseBrowserConfig + defaultArgs(损坏抛清晰错)"
```

---

## Task 4: `browser.ts` 重写 ensureBrowser

**Files:**
- Rewrite: `src/browser.ts`

- [ ] **Step 1: 重写（去掉 api 依赖；冷启动读配置/无则 bootstrap/坏则警告；固定 9222）**

```ts
/**
 * browser.ts — 确保 CDP 浏览器就绪(端口固定 9222/CDP_PORT)。
 * 语义:9222 已就绪 → 直接用;未就绪 → 读 ~/.cdp-control/browser.json 拉起
 * (缺失自动发现生成 / 存在则用 / 损坏警告不兜底 / 用户可改)。
 * 依赖 transport + monitor + browser-discover + browser-config。不再依赖 api(无环)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getJson, PORT } from './transport';
import { maybeSpawnDaemon } from './monitor';
import { discoverCandidates, type BrowserKind } from './browser-discover';
import { browserConfigPath, parseBrowserConfig, defaultArgs, type BrowserConfig } from './browser-config';

const USER_DATA = () => process.env.CDP_USER_DATA || join(homedir(), '.cdp-control', 'user-data');

export interface EnsureResult { ready: boolean; started: boolean; browser?: string; userData?: string; }

let child: ReturnType<typeof spawn> | null = null;

function killLast(): void {
  if (!child) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch {}
  child = null;
}

function launch(exe: string, args: string[], userData: string): void {
  killLast();
  child = spawn(exe, [...args, `--remote-debugging-port=${PORT}`, `--user-data-dir=${userData}`], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function waitReady(timeoutMs = 20000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await getJson('/json/version'); if (v?.webSocketDebuggerUrl) return; } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('浏览器启动超时');
}

/** ready 探活(一次 GET,顺带拿浏览器名)。 */
async function probeReady(): Promise<{ ready: boolean; browser?: string }> {
  try {
    const v = await getJson('/json/version');
    if (!v?.webSocketDebuggerUrl) return { ready: false };
    return { ready: true, browser: describeBrowser(v.Browser || '') };
  } catch { return { ready: false }; }
}

function describeBrowser(s: string): string {
  if (/Edg\//i.test(s)) return `Microsoft Edge (${s})`;
  if (/Chrome\//i.test(s)) return `Google Chrome (${s})`;
  return s || '未知浏览器';
}

/** linux 候选名 → 绝对路径;win/mac 已绝对路径,existsSync 过滤。返回 null 表示不可用。 */
function resolveExe(exe: string): string | null {
  if (process.platform === 'linux' && !exe.includes('/')) {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const r = spawnSync('sh', ['-c', `command -v ${exe}`], { encoding: 'utf8' });
    const p = (r.stdout || '').trim();
    return p || null;
  }
  return existsSync(exe) ? exe : null;
}

function writeConfigAtomic(p: string, cfg: BrowserConfig): void {
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(tmp, p);
}

/** 冷启动:有配置则用(坏则抛,不兜底);无配置则 bootstrap 发现并写配置。 */
async function coldStart(): Promise<{ kind: BrowserKind; exe: string; userData: string }> {
  const p = browserConfigPath();
  const userData = USER_DATA();
  mkdirSync(userData, { recursive: true });

  if (existsSync(p)) {
    let cfg: BrowserConfig;
    try { cfg = parseBrowserConfig(readFileSync(p, 'utf8')); }
    catch (e: any) { throw new Error(`${e.message}\n浏览器启动配置损坏，不做兜底，请编辑 ${p}`); }
    if (!existsSync(cfg.exe)) throw new Error(`browser.json 的 exe 不存在: ${cfg.exe}\n请编辑 ${p}`);
    launch(cfg.exe, cfg.args, userData);
    await waitReady();
    maybeSpawnDaemon();
    return { kind: cfg.kind, exe: cfg.exe, userData };
  }

  // 缺失 → bootstrap:逐个候选尝试,首个能拉起者写配置
  for (const c of discoverCandidates()) {
    const exe = resolveExe(c.exe);
    if (!exe) continue;
    const args = defaultArgs();
    try { launch(exe, args, userData); await waitReady(); }
    catch { killLast(); continue; }
    writeConfigAtomic(p, { exe, kind: c.kind, args });
    maybeSpawnDaemon();
    return { kind: c.kind, exe, userData };
  }
  throw new Error(`未找到可用浏览器。可手动创建 ${p} 指定 exe/args`);
}

/** 确保有 CDP 浏览器在跑:就绪零开销(1 GET);未就绪自动拉起。 */
export async function ensureBrowser(): Promise<EnsureResult> {
  const probe = await probeReady();
  if (probe.ready) return { ready: true, started: false, browser: probe.browser };
  const info = await coldStart();
  console.error(`已自动启动浏览器: ${describeBrowser(info.exe)} (端口 ${PORT})`);
  return { ready: true, started: true, browser: describeBrowser(info.exe), userData: info.userData };
}
```

> 注：`child`/`killLast` 仅 bootstrap 多候选降级时用；配置存在时 launch 一次不回收（持久浏览器，不随父进程死）。`require` 在 TS 里经 esbuild 编译成 CJS 可用；也可顶部改 `import { spawnSync }`。

- [ ] **Step 2: 确认编译通过**

Run: `npm run build`
Expected: 无类型/打包错误。若 `require` 报类型错，改顶部 `import { spawn, spawnSync } from 'node:child_process'` 并用 spawnSync。

- [ ] **Step 3: 检查删除项——`browser.ts` 不再 import `./api`**

Run: `grep -n "from './api'" src/browser.ts`
Expected: 无输出（无 api 依赖）

- [ ] **Step 4: Commit**

```bash
git add src/browser.ts
git commit -m "feat(browser): ensureBrowser 重写——读 browser.json 冷启动/就绪1GET/不依赖 api"
```

---

## Task 5: `api.ts` 主动 ensure + 连接失败自愈

**Files:**
- Modify: `src/api.ts`

- [ ] **Step 1: 顶部 import ensureBrowser，加 connectTarget 自愈助手**

在 `src/api.ts` import 区加：
```ts
import { ensureBrowser } from './browser';
```

在 `withPage` 定义处加自愈助手（放 `invoke` 前）：
```ts
/**
 * 连接失败自愈:pageWs 失败(浏览器死/端口死/target stale)→ 确保浏览器 → 按 url 重 resolve → 重试一次。
 * 只包 pageWs 建立阶段,不包命令执行——避免命令错误被误判为连接失败而重复执行。
 */
async function connectTarget(target: Target): Promise<WebSocket> {
  try { return await pageWs(target); }
  catch (e) {
    let revived = target;
    try { await ensureBrowser(); } catch {}
    try { revived = await resolve(target.url || ''); } catch {}
    return await pageWs(revived);
  }
}
```

- [ ] **Step 2: `withPage` 与 `invoke` 改走 connectTarget**

`withPage`（现 `:33-36`）改成：
```ts
async function withPage<T>(target: Target, fn: (ws: WebSocket) => Promise<T>): Promise<T> {
  const ws = await connectTarget(target);
  try { return await fn(ws); } finally { ws.close(); }
}
```

`invoke`（现 `:23-27`）改成走 connectTarget（不再直接调 transport.evaluate）：
```ts
async function invoke<T>(target: Target, expr: string, timeout?: number): Promise<T> {
  const r = await evaluateWithSelfHeal(target, expr, timeout);
  if (r && typeof r === 'object' && (r as any).ok === false && !(r as any).refInvalid) throw new Error((r as any).err || '操作失败');
  return r as T;
}

/** 用 connectTarget 连上后执行 JS(替代 transport.evaluate,获得连接失败自愈)。 */
async function evaluateWithSelfHeal(target: Target, expression: string, timeout?: number): Promise<any> {
  const ws = await connectTarget(target);
  try { return await evalJs(ws, expression, timeout); } finally { ws.close(); }
}
```

> `evalJs` 已从 transport import（`src/api.ts:8`）。`connectTarget` 用到的 `pageWs`/`resolve` 也已 import。daemon（monitor）走 `pageWs`/`send` 不经 `invoke`/`withPage`，天然豁免自愈（不会死循环拉起浏览器）。

- [ ] **Step 3: resolve / list / open 前置 ensureBrowser**

`open`（现 `:45-56`）函数体首行加：
```ts
await ensureBrowser();
```

`coreApi` 里 `resolve`/`list` 的包装处（`src/api.ts` 末尾导出处）改为前置 ensure。找到 `export const coreApi`（或其等价导出），在 resolve/list 前插 ensure：
```ts
export const coreApi = {
  // ...原有成员...
  resolve: async (match?: string) => { await ensureBrowser(); return resolve(match); },
  list: async () => { await ensureBrowser(); return list(); },
  // ...原有其余成员保持不动(open 已在函数体内前置 ensure)...
};
```

> 先 `grep -n "coreApi" src/api.ts` 看现导出结构再改，保持其它成员不动。`open` 是独立 `export async function`，已在 Step 3 首行加 ensure。

- [ ] **Step 4: 确认编译通过**

Run: `npm run build`
Expected: 无错误。确认依赖图无环（api→browser→transport/monitor/discover/config；browser 不再依赖 api）。

- [ ] **Step 5: Commit**

```bash
git add src/api.ts
git commit -m "feat(api): resolve/list/open 主动 ensure + connectTarget 连接失败自愈(堵 stale target)"
```

---

## Task 6: `cdp.ts` 删冗余 ensure + `browser.ts` 导出对齐

**Files:**
- Modify: `src/cdp.ts`

- [ ] **Step 1: 删 list / fetch 的显式 `api.ensure()`**

- `cdp.ts:66`（list）删 `await api.ensure(); // 合并 ensure:...`
- `cdp.ts:82`（fetch）删 `await api.ensure(); // 合并 ensure:...`

> resolve/list/open 现已在 api 层自 ensure，删这两处冗余。确认 `api.ensure` 仍保留在导出的 api 对象里（`cdp.ts:15`）供 run 脚本显式调用。

- [ ] **Step 2: 确认 cdp.ts 里 `api.ensure` 定义仍可用**

`cdp.ts:15` 的 `api = { ...coreApi, logs, ensure: ensureBrowser }` 保持。ensureBrowser 的返回类型由 Task 4 的 `EnsureResult` 提供，签名 `() => Promise<EnsureResult>`，list/fetch 不再使用其返回值，无破坏。

- [ ] **Step 3: 构建 + 全测**

Run: `npm run build && npm test`
Expected: 构建无错，全部测试 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/cdp.ts
git commit -m "refactor(cli): list/fetch 删冗余 api.ensure(api 层已自 ensure)"
```

---

## Task 7: 浏览器实测（Windows + Edge，真实验收）

**Files:** 无（行为验证）

- [ ] **Step 1: 清理旧配置，观察首次自动生成**

```bash
rm -f ~/.cdp-control/browser.json
node dist/cdp.js list
```
Expected: 打印"已自动启动浏览器: Microsoft Edge (端口 9222)"，且生成 `~/.cdp-control/browser.json`（含 msedge.exe 与默认 args）。`cat ~/.cdp-control/browser.json` 目检。

- [ ] **Step 2: 二次调用走就绪路径（零启动、1 GET）**

```bash
node dist/cdp.js list
```
Expected: 不打印"已自动启动"，直接列出 tab（就绪路径）。

- [ ] **Step 3: 全部 target 命令自愈验证（关浏览器后直接 view）**

```bash
node dist/cdp.js close <一个tabid>   # 或 taskkill 浏览器进程
node dist/cdp.js view
```
Expected: 浏览器被关后 `view`（不再先 list/fetch）也能自动拉起浏览器并建树——证明"一切命令自愈"成立。

- [ ] **Step 4: 配置损坏不兜底验证**

```bash
echo '{"exe":"C:/不存在/xxx.exe"}' > ~/.cdp-control/browser.json
node dist/cdp.js list
```
Expected: 报清晰错误（exe 不存在，请编辑 browser.json），**不**自动 fallback 到发现。改回正确配置恢复。

- [ ] **Step 5: macOS/Linux 无法本机实测——依赖 Task 1/3 纯函数单测 + 路径表评审**

记录：跨平台连通性留待真 mac/linux 验收（已知局限）。

---

## Task 8: 文档同步（CLAUDE.md）

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新 CLAUDE.md 的 browser 相关段**

在「源码结构」与「browser 层」处，补/改：
- `src/browser.ts`：`ensureBrowser()` 语义改为"读 `~/.cdp-control/browser.json` 冷启动（缺失生成/存在用/损坏警告不兜底）；就绪 1 GET"，不再依赖 api。
- 新增 `src/browser-discover.ts`（跨平台候选发现）、`src/browser-config.ts`（browser.json 解析 + defaultArgs）。
- 记录 `~/.cdp-control/browser.json` 契约（exe/kind/args 三字段；`--remote-debugging-port` 与 `--user-data-dir` 受保护不进文件）。
- 依赖图更新：browser 不再依赖 api。

- [ ] **Step 2: 构建 + 全测**

Run: `npm run build && npm test`
Expected: 全绿。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: browser 层重设计同步——browser.json 配置契约/发现/ensure 语义"
```

---

## Task 9: 收尾——合并到 main

- [ ] **Step 1: 确认分支全部提交**

Run: `git log --oneline main..feat/browser-connection`
Expected: 列出本特性全部提交（spec + 实现）。

- [ ] **Step 2: 切 main 并 --no-ff 合并**

```bash
git checkout main && git merge --no-ff feat/browser-connection -m "merge(feat/browser-connection): 跨平台浏览器连接——browser.json 配置自愈 + 一切命令自愈"
```

- [ ] **Step 3: 最终验证**

Run: `node dist/cdp.js list`
Expected: 浏览器可用，输出 tab 列表。

---

## 自审记录

- **Spec 覆盖**：D1(启动配置)→Task 3/4；D2(发现)→Task 1/4；D3(ensure)→Task 4；D4(args)→Task 3 defaultArgs；D5(自愈 api 层)→Task 5/6；D6(daemon 不变)→无需改，Task 4 里 maybeSpawnDaemon 保留；D7(有头/window-size)→Task 3 defaultArgs 含 `--window-size`。端口 9222 固定→Task 2/4。删除项(isBrowserReady+probeBrowserName 两次 GET、browser→api、cdp 冗余 ensure、findBrowserExe)→Task 4/6。
- **占位符扫描**：无 TBD/TODO。
- **类型一致性**：`BrowserConfig{exe,kind,args}`、`Candidate{exe,kind}`、`BrowserKind` 跨 Task 1/3/4 一致；`connectTarget`/`evaluateWithSelfHeal` 在 Task 5 内定义与使用一致。
