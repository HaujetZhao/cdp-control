/**
 * browser.ts — 确保 CDP 浏览器就绪。
 * 语义:读 ~/.cdp-control/browser.json 拿到 exe/kind/args/port/userData;
 * 已就绪(该端口有响应)→ 直接用(就绪零开销,1 次 GET);未就绪 → 读配置拉起
 * (缺失自动发现生成 / 存在则用 / 损坏警告不兜底 / 用户可改)。
 *
 * 端口语义:**配置哪个端口就用哪个端口,绝不避让**。9222 是 CDP 共识端口,本工具假设
 * 机器上只有一个 CDP 浏览器实例。端口被占用且不应答 → 占用者坏了 → 杀掉 → 用同一端口重启。
 * (若占用者只是刚拉起、还在启动,probeReadySoon 3s 内等它就绪,不误杀并发冷启动的浏览器。)
 * 依赖 transport + monitor + browser-discover + browser-config + port-detect。不再依赖 api(无环)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getJson, setPort, PORT, sleep } from './transport';
import { maybeSpawnDaemon } from './monitor';
import { discoverCandidates, type BrowserKind } from './browser-discover';
import { browserConfigPath, parseBrowserConfig, defaultArgs, DEFAULT_PORT, type BrowserConfig } from './browser-config';
import { findPortListeners, killPid, freePort } from './port-detect';

export interface EnsureResult { ready: boolean; started: boolean; browser?: string; userData?: string; }
export interface KillResult { ok: boolean; port: number; reason: 'killed' | 'noProcess' | 'stillUp' | 'noConfig' | 'broken'; }

let child: ReturnType<typeof spawn> | null = null;

/** 杀掉上次 bootstrap 尝试的进程(仅多候选降级时用)。 */
function killLast(): void {
  if (!child) return;
  if (child.pid != null) killPid(child.pid);
  child = null;
}

function launch(exe: string, args: string[], port: number, userData: string): void {
  killLast();
  child = spawn(exe, [...args, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function waitReady(timeoutMs = 20000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await getJson('/json/version'); if (v?.webSocketDebuggerUrl) return; } catch {}
    await sleep(400);
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

/** 短暂轮询等就绪(区分「坏实例」与「并发刚拉起、还在启动」的浏览器),超时返回未就绪。 */
async function probeReadySoon(timeoutMs = 3000): Promise<{ ready: boolean; browser?: string }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const p = await probeReady();
    if (p.ready) return p;
    await sleep(200);
  }
  return { ready: false };
}

function describeBrowser(s: string): string {
  if (/Edg\//i.test(s)) return `Microsoft Edge (${s})`;
  if (/Chrome\//i.test(s)) return `Google Chrome (${s})`;
  return s || '未知浏览器';
}

/** linux 候选名 → 绝对路径;win/mac 已绝对路径,existsSync 过滤。返回 null 表示不可用。 */
function resolveExe(exe: string): string | null {
  if (process.platform === 'linux' && !exe.includes('/')) {
    const r = spawnSync('sh', ['-c', `command -v ${exe}`], { encoding: 'utf8' });
    const p = (r.stdout || '').trim();
    return p || null;
  }
  return existsSync(exe) ? exe : null;
}

function writeConfigAtomic(p: string, cfg: BrowserConfig): void {
  // tmp 名带 pid:并发冷启动的两个进程都可能回写端口,共享固定 tmp 名会互踩(rename ENOENT)。
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSync(tmp, p);
}

/** 读配置并同步 transport 端口。无配置返回 null(交由调用方 bootstrap)。 */
function loadConfigOrNull(): BrowserConfig | null {
  const p = browserConfigPath();
  if (!existsSync(p)) return null;
  const cfg = parseBrowserConfig(readFileSync(p, 'utf8'));
  setPort(cfg.port);
  return cfg;
}

/** 冷启动:有配置则用(坏则抛,不兜底);无配置则 bootstrap 发现并写配置。固定端口,不避让。 */
async function coldStart(): Promise<{ kind: BrowserKind; exe: string; userData: string }> {
  const p = browserConfigPath();

  if (existsSync(p)) {
    let cfg: BrowserConfig | null;
    try { cfg = loadConfigOrNull(); }
    catch (e: any) { throw new Error(`${(e as Error).message}\n浏览器启动配置损坏,不做兜底,请编辑 ${p}`); }
    if (!cfg) throw new Error(`浏览器启动配置损坏,不做兜底,请编辑 ${p}`);
    if (!existsSync(cfg.exe)) throw new Error(`browser.json 的 exe 不存在: ${cfg.exe}\n请编辑 ${p}`);
    mkdirSync(cfg.userData, { recursive: true });
    launch(cfg.exe, cfg.args, cfg.port, cfg.userData);
    await waitReady();
    maybeSpawnDaemon();
    return { kind: cfg.kind, exe: cfg.exe, userData: cfg.userData };
  }

  // 缺失 → bootstrap:逐个候选尝试,首个能拉起者写配置(port/userData 用默认值)
  const port = DEFAULT_PORT;
  const userData = join(homedir(), '.cdp-control', 'user-data');
  mkdirSync(userData, { recursive: true });
  for (const c of discoverCandidates()) {
    const exe = resolveExe(c.exe);
    if (!exe) continue;
    const args = defaultArgs();
    try { launch(exe, args, port, userData); await waitReady(); }
    catch { killLast(); continue; }
    writeConfigAtomic(p, { exe, kind: c.kind, args, port, userData });
    maybeSpawnDaemon();
    return { kind: c.kind, exe, userData };
  }
  throw new Error(`未找到可用浏览器。可手动创建 ${p} 指定 exe/args`);
}

/** 确保有 CDP 浏览器在跑:就绪零开销(1 GET);未就绪自动拉起。端口固定、不避让。 */
export async function ensureBrowser(): Promise<EnsureResult> {
  // 先同步端口(有配置则读其 port,无则保持默认 9222),再探活
  const cfg = loadConfigOrNull();
  const port = cfg ? cfg.port : DEFAULT_PORT;
  if (cfg?.userData) mkdirSync(cfg.userData, { recursive: true });

  const probe = await probeReady();
  if (probe.ready) return { ready: true, started: false, browser: probe.browser, userData: cfg?.userData };

  // 未就绪且端口被占用:先短暂等待(也许只是并发刚拉起、还在启动),仍不应答则杀掉占用者。
  if (findPortListeners(port).length > 0) {
    const soon = await probeReadySoon(3000);
    if (soon.ready) return { ready: true, started: false, browser: soon.browser, userData: cfg?.userData };
    const freed = await freePort(port);
    if (!freed) {
      throw new Error(`端口 ${port} 被占用且 3s 内无法释放,请先手动处理(如 cdp-control kill)或修改 browser.json 的 port`);
    }
  }

  const info = await coldStart();
  console.error(`已自动启动浏览器: ${describeBrowser(info.exe)} (端口 ${Number(PORT)})`);
  return { ready: true, started: true, browser: describeBrowser(info.exe), userData: info.userData };
}

/** 强制结束浏览器进程:端口从 browser.json 读;无配置则 kill 不生效。返回是否已无监听。 */
export async function killBrowser(): Promise<KillResult> {
  const p = browserConfigPath();
  if (!existsSync(p)) return { ok: false, port: 9222, reason: 'noConfig' };
  let cfg: BrowserConfig;
  try { cfg = parseBrowserConfig(readFileSync(p, 'utf8')); }
  catch { return { ok: false, port: 9222, reason: 'broken' }; }
  const port = cfg.port;
  const pids = findPortListeners(port);
  for (const pid of pids) killPid(pid);
  // 等端口真正释放(最多 ~3s),Edge 崩溃自启会重绑
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    if (findPortListeners(port).length === 0) return { ok: true, port, reason: pids.length ? 'killed' : 'noProcess' };
    await sleep(300);
  }
  return { ok: false, port, reason: pids.length ? 'stillUp' : 'noProcess' };
}
