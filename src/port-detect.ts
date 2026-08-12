/**
 * port-detect.ts — 端口占用检测与释放(浏览器启动 / kill 共用)。
 * 语义:findPortListeners 找「监听指定端口的全部 pid」;freePort 杀光并等端口释放。
 * 纯函数 parseNetstatListeners 按列解析,避免 ':9222' 子串误命中 ':92220' / ESTABLISHED 远端口。
 */
import { execFileSync } from 'node:child_process';

export interface Listener { port: number; pid: number; }

/** 解析 netstat -ano 输出,取「本地地址端口精确匹配 + LISTENING」的 (port, pid) 对。纯函数,可跨平台单测。 */
export function parseNetstatListeners(out: string): Listener[] {
  const rows: Listener[] = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== 'TCP') continue;   // 只认 TCP
    if (cols[3] !== 'LISTENING') continue;                // 只认 LISTENING(跳过 ESTABLISHED 等)
    const m = /:(\d+)$/.exec(cols[1]);                    // 本地地址尾端口(兼容 [::]:9222 / 0.0.0.0:9222)
    const pid = Number(cols[4]);
    if (!m || !Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ port: Number(m[1]), pid });
  }
  return rows;
}

/** 找监听 port 的全部 pid。win 走 netstat 解析,posix 走 lsof。失败返回空。 */
export function findPortListeners(port: number): number[] {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
      return parseNetstatListeners(out).filter(r => r.port === port).map(r => r.pid);
    }
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    return out.split(/\r?\n/).map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  } catch { return []; }
}

/** 杀一个 pid(win taskkill 带子进程树,posix SIGKILL)。失败静默。 */
export function killPid(pid: number): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch {}
}

/** 杀掉监听 port 的全部进程并等端口释放(最多 timeoutMs)。返回是否已释放。 */
export async function freePort(port: number, timeoutMs = 3000): Promise<boolean> {
  for (const pid of findPortListeners(port)) killPid(pid);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (findPortListeners(port).length === 0) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}
