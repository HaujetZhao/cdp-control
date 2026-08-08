/**
 * browser.ts — 确保 CDP 浏览器就绪(冷启动自动探测 Edge/Chrome)。
 * 依赖 transport(连接)+ api(open/navigate)+ monitor(maybeSpawnDaemon)。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getJson, listTargets, resolveTarget, PORT, sleep } from './transport';
import { open, navigate } from './api';
import { maybeSpawnDaemon } from './monitor';

async function isBrowserReady(): Promise<boolean> {
  try {
    const v = await getJson('/json/version');
    return !!(v && v.webSocketDebuggerUrl);
  } catch { return false; }
}

async function findBrowserExe(): Promise<string | null> {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA || ''}/Microsoft/Edge/Application/msedge.exe`,
    `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
  ];
  return cands.find(p => existsSync(p)) || null;
}

// 从任意标识串(exe 路径 / /json/version 的 Browser 字段)推断浏览器名,供冷热启动两条路径共用。
function browserLabel(str: string): string | null {
  if (!str) return null;
  if (/Edge|Edg\//i.test(str)) return 'Microsoft Edge';
  if (/Chrome/i.test(str)) return 'Google Chrome';
  return null;
}

function browserNameFromExe(exe: string): string {
  return browserLabel(exe) || exe || '未知浏览器';
}

// 热启动时浏览器非本次启动,exe 拿不到;从 /json/version 的 Browser 字段推断浏览器名。
async function probeBrowserName(): Promise<string> {
  try {
    const v = await getJson('/json/version');
    const b = (v && v.Browser) || '';
    const label = browserLabel(b);
    return label ? `${label} (${b})` : (b || '未知浏览器');
  } catch { return '未知浏览器'; }
}

export interface EnsureResult {
  ready: boolean; started: boolean; browser?: string; userData?: string; url?: string; targetId?: string;
}

/**
 * 确保有 CDP 浏览器在跑。没有则自动探测 Edge/Chrome 并用独立用户数据目录启动。
 */
export async function ensureBrowser(url?: string): Promise<EnsureResult> {
  let started = false;
  let exe: string | null = null;
  let userData: string | null = null;
  if (!(await isBrowserReady())) {
    exe = await findBrowserExe();
    if (!exe) throw new Error('未找到可用的 Edge/Chrome,请手动用 --remote-debugging-port 启动浏览器');
    userData = process.env.CDP_USER_DATA || join(homedir(), '.cdp-browser');
    mkdirSync(userData, { recursive: true });
    const child = spawn(exe, [
      `--remote-debugging-port=${PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${userData}`,
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    started = true;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      await sleep(500);
      if (await isBrowserReady()) break;
    }
    if (!(await isBrowserReady())) throw new Error('浏览器启动超时,请检查(或手动打开一个 Edge/Chrome)');
  }
  const browser = started ? browserNameFromExe(exe!) : await probeBrowserName();
  const res: EnsureResult = { ready: true, started, browser, userData: userData ?? undefined };
  if (url) {
    let targetId: string;
    if (started) {
      const pages = await listTargets();
      const first = resolveTarget(pages, undefined);
      await navigate(first, url);
      targetId = first.id;
    } else {
      targetId = await open(url);
    }
    res.url = url;
    res.targetId = targetId;
    maybeSpawnDaemon();
  }
  return res;
}
