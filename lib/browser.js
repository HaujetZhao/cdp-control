'use strict';
/**
 * browser.js — 确保 CDP 浏览器就绪(冷启动自动探测 Edge/Chrome)。
 * 依赖 transport(连接)+ api(open/navigate)+ monitor(maybeSpawnDaemon)。
 */

const { getJson, listTargets, resolveTarget, PORT, sleep } = require('./transport');
const { open, navigate } = require('./api');
const { maybeSpawnDaemon } = require('./monitor');

async function isBrowserReady() {
  try {
    const v = await getJson('/json/version');
    return !!(v && v.webSocketDebuggerUrl);
  } catch { return false; }
}

async function findBrowserExe() {
  const { existsSync } = await import('node:fs');
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
// 未识别返回 null,由调用方决定回退(原串 / '未知浏览器')。
function browserLabel(str) {
  if (!str) return null;
  if (/Edge|Edg\//i.test(str)) return 'Microsoft Edge';
  if (/Chrome/i.test(str)) return 'Google Chrome';
  return null;
}

function browserNameFromExe(exe) {
  return browserLabel(exe) || exe || '未知浏览器';
}

// 热启动时浏览器非本次启动,exe 拿不到;从 /json/version 的 Browser 字段推断浏览器名(如 "Edg/127"/"Chrome/126")。
async function probeBrowserName() {
  try {
    const v = await getJson('/json/version');
    const b = (v && v.Browser) || '';
    const label = browserLabel(b);
    return label ? `${label} (${b})` : (b || '未知浏览器');
  } catch { return '未知浏览器'; }
}

/**
 * 确保有 CDP 浏览器在跑。没有则自动探测 Edge/Chrome 并用独立用户数据目录启动(不干扰用户平时浏览器)。
 * @param {string} [url] 可选:浏览器就绪后打开该 url
 * @returns {Promise<{ready:boolean, started:boolean, browser?:string, userData?:string, url?:string, targetId?:string}>}
 *   started=true 冷启动(本次启动);false 热启动(浏览器本就就绪,exe/userData 无法可靠获取)。
 */
async function ensureBrowser(url) {
  let started = false;
  let exe = null;
  let userData = null;
  if (!(await isBrowserReady())) {
    exe = await findBrowserExe();
    if (!exe) throw new Error('未找到可用的 Edge/Chrome,请手动用 --remote-debugging-port 启动浏览器');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    userData = process.env.CDP_USER_DATA || path.join(os.homedir(), '.cdp-browser');
    fs.mkdirSync(userData, { recursive: true });
    const { spawn } = await import('node:child_process');
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
  const browser = started ? browserNameFromExe(exe) : await probeBrowserName();
  const res = { ready: true, started, browser, userData }; // 热启动时 browser 从 /json/version 推断,userData 为 null
  if (url) {
    let targetId;
    if (started) {
      // 冷启动:本次由 ensure 启动的浏览器自带一个空白首 tab,直接导航它,不再 open 新开(避免留多余空 tab)。
      const pages = await listTargets();
      const first = resolveTarget(pages, undefined); // 取第一个普通网页
      await navigate(first, url);
      targetId = first.id;
    } else {
      // 热启动:浏览器已就绪,新开一个 tab 放链接,不覆盖用户现有页面。
      targetId = await open(url);
    }
    res.url = url;
    res.targetId = targetId;
    maybeSpawnDaemon(); // 打开页面即自动种上控制台监听
  }
  return res;
}

module.exports = { ensureBrowser };
