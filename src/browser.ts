/**
 * browser.ts — 确保 CDP 浏览器就绪(端口固定 9222 / CDP_PORT)。
 * 语义:已就绪 → 直接用(就绪零开销,1 次 GET);未就绪 → 读 ~/.cdp-control/browser.json 拉起
 * (缺失自动发现生成 / 存在则用 / 损坏警告不兜底 / 用户可改)。
 * 依赖 transport + monitor + browser-discover + browser-config。不再依赖 api(无环)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getJson, PORT } from './transport';
import { maybeSpawnDaemon } from './monitor';
import { discoverCandidates, type BrowserKind } from './browser-discover';
import { browserConfigPath, parseBrowserConfig, defaultArgs, type BrowserConfig } from './browser-config';

const USER_DATA = () => process.env.CDP_USER_DATA || join(homedir(), '.cdp-control', 'user-data');

export interface EnsureResult { ready: boolean; started: boolean; browser?: string; userData?: string; }

let child: ReturnType<typeof spawn> | null = null;

/** 杀掉上次 bootstrap 尝试的进程(仅多候选降级时用)。 */
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
    catch (e: any) { throw new Error(`${e.message}\n浏览器启动配置损坏,不做兜底,请编辑 ${p}`); }
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

/** 找出监听 PORT 的进程 pid(win 走 netstat,posix 走 lsof);无则 null。 */
function pidOnPort(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const pid = Number(line.trim().split(/\s+/).pop());
          if (pid) return pid;
        }
      }
    } else {
      const out = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' }).trim();
      if (out) return Number(out.split('\n')[0]);
    }
  } catch {}
  return null;
}

/** 强制结束 9222(PORT)上监听的浏览器进程,并等端口释放。返回是否已无监听。 */
export async function killBrowser(): Promise<boolean> {
  const port = Number(PORT);
  const pid = pidOnPort(port);
  if (pid) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    } catch {}
  }
  // 等端口真正释放(最多 ~3s),Edge 可能崩溃自启重绑端口
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    if (pidOnPort(port) === null) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return pidOnPort(port) === null;
}
