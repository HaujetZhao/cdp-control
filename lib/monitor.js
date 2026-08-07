'use strict';
/**
 * monitor.js — 控制台监听:常驻注入守护 daemon(cmdListen)+ 读取(logs)。
 * 依赖 transport(连接原语)+ scripts(MONITOR_JS/buildReadExpr),不依赖 api → 无环。
 */

const { pageWs, send, listTargets, resolve, evaluate, sleep } = require('./transport');
const { MONITOR_JS, buildReadExpr } = require('./scripts');

const LOGS_PORT = Number(process.env.CDP_LOGS_PORT) || 9333;

async function spawnDaemon() {
  const { spawn } = await import('node:child_process');
  const script = process.argv[1] || __filename;
  const child = spawn(process.execPath, [script, 'listen'], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function daemonHealthy(port = LOGS_PORT) {
  try { const r = await fetch(`http://127.0.0.1:${port}/health`); return r.ok; } catch { return false; }
}

// 异步确保 daemon 在跑(打开页面时自动注入守护;失败不阻塞主流程)。
async function maybeSpawnDaemon() {
  try { await ensureDaemon(); } catch {}
}

async function ensureDaemon(port = LOGS_PORT) {
  if (await daemonHealthy(port)) return port;
  await spawnDaemon();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    await sleep(300);
    if (await daemonHealthy(port)) return port;
  }
  throw new Error('监听 daemon 启动失败');
}

async function pidFilePath() {
  const os = await import('node:os');
  const path = await import('node:path');
  return path.join(os.tmpdir(), 'cdp-listen.pid');
}

/**
 * 注入守护 daemon(listen 子命令)。不做日志缓冲/读取——职责是保证**每个 tab 都装上
 * 页面监控脚本**。attach 时 Page.addScriptToEvaluateOnNewDocument 注册一次,之后每次
 * document 创建(含刷新)自动重跑监控脚本 → 刷新自动补,无需探测。轮询 /json/list 自动
 * 覆盖新开的 tab(含手动开的)。读取交给 logs 命令去 eval 页面 window.__cdpLogs。
 */
async function cmdListen() {
  const http = await import('node:http');
  const fs = await import('node:fs');
  const attached = new Map(); // targetId -> ws

  async function inject(target) {
    let ws;
    try { ws = await pageWs(target); } catch { return; }
    attached.set(target.id, ws);
    ws.onclose = () => attached.delete(target.id); // 断了下轮重连,重注册
    try {
      await send(ws, 'Page.enable', {}, 5000);
      // 关键:注册到 target 会话,刷新后新 document 自动先跑监控脚本
      await send(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: MONITOR_JS }, 5000);
      // 对当前已加载页面立即注入一次(幂等)
      await send(ws, 'Runtime.evaluate', { expression: MONITOR_JS, returnByValue: true }, 5000);
    } catch {}
  }

  async function sync() {
    let list;
    try { list = await listTargets(); } catch { return; }
    for (const t of list) if (!attached.has(t.id)) await inject(t);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${LOGS_PORT}`);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (url.pathname === '/health') { res.end(JSON.stringify({ ok: true, targets: attached.size })); return; }
    if (url.pathname === '/shutdown') { try { fs.unlinkSync(await pidFilePath()); } catch {} server.close(); process.exit(0); }
    res.statusCode = 404; res.end('{}');
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(LOGS_PORT, '127.0.0.1', resolve); });
  await sync();
  setInterval(() => { sync().catch(() => {}); }, 500);
  fs.writeFileSync(await pidFilePath(), String(process.pid));
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  console.error(`注入守护 daemon 就绪 :${LOGS_PORT},tabs=${attached.size}`);
}

/**
 * 读 target 的控制台日志:幂等注入监控脚本 + 读取 window.__cdpLogs(结构化嵌套对象)。
 * @param {object|string} target target 对象或 id/url/title 子串
 * @param {{level?:string, since?:number}} [opts] level 逗号分隔;since 毫秒时间戳
 * @returns {Promise<Array>} 日志条目(结构化,含 args 嵌套 + stack 调用链)
 */
async function logs(target, opts = {}) {
  maybeSpawnDaemon().catch(() => {}); // 确保 daemon 在跑(持续守护注入)
  if (typeof target === 'string') target = await resolve(target);
  const levelSet = opts.level ? opts.level.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : null;
  const since = opts.since || 0;
  const value = await evaluate(target, buildReadExpr(levelSet, since), 30000);
  return Array.isArray(value) ? value : [];
}

module.exports = { LOGS_PORT, spawnDaemon, daemonHealthy, ensureDaemon, maybeSpawnDaemon, pidFilePath, cmdListen, logs };
