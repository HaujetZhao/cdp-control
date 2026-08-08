/**
 * cdp.ts — 通过 Chrome DevTools Protocol (CDP) 控制本地浏览器的脚本入口。
 *
 * 取代 chrome-devtools-mcp:直接连 CDP 9222,能操作"手动开的 tab"(MCP 会漏看的那种)。
 * 编译产物为 dist/cdp.js(esbuild CJS),运行 `node dist/cdp.js <子命令>`。
 *
 * 代码拆在 src/ 下按职责分模块:
 *   src/transport.ts     低级连接与 target 级原语(getJson/ws/send/evaluate/resolve)
 *   src/inject-loader.ts 注入脚本加载与 __CDP_ARG__ 参数装配(打包产物在 dist/inject/)
 *   src/api.ts           高层页面操作 API(snapshot/click/fill/wait/...)
 *   src/monitor.ts       控制台监听:注入守护 daemon + logs 读取
 *   src/browser.ts       确保浏览器就绪(冷启动自动探测 Edge/Chrome)
 *   本入口               组装最终 api + CLI 子命令分发
 */
import { sleep } from './transport';
import { coreApi } from './api';
import { logs, cmdListen, daemonHealthy, LOGS_PORT } from './monitor';
import { ensureBrowser } from './browser';

// 最终 api 对象:核心页面操作 + 控制台监听读取 + 浏览器 ensure。require 本文件时导出它。
const api = { ...coreApi, logs, ensure: ensureBrowser };

// ==================== CLI ====================

const VALUE_OPTS = new Set(['target', 'file', 'url', 'level', 'since', 'xpath', 'selector', 'xpath-file', 'selector-file']);

function parseArgs(argv: string[]): { args: string[]; opts: Record<string, any> } {
  const args: string[] = [];
  const opts: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const name = a.slice(2);
    if (VALUE_OPTS.has(name)) opts[name] = argv[++i];
    else if (a.startsWith('--')) opts[name] = true;
    else args.push(a);
  }
  return { args, opts };
}

/** 从 --xpath-file/--selector-file 读内容(去首尾空白),没给 flag 返回 undefined。 */
function readOptFile(fs: any, file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  try { return fs.readFileSync(file, 'utf8').trim(); }
  catch (e: any) { throw new Error(`读取参数文件失败: ${file} — ${e.message}`); }
}

async function main(): Promise<void> {
  const { args, opts } = parseArgs(process.argv.slice(2));
  const cmd = args.shift();

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`用法: node dist/cdp.js <子命令> [参数]
  ensure [--url <url>]     确保浏览器已打开(自动探测 Edge/Chrome 启动 CDP),可选 --url 直接导航
  list                     列出所有 page tab(含手动开的)
  open <url>               新开一个 tab
  close <target>           关闭 tab
  navigate <url> [--target]导航到 url
  eval "<js>" [--target]   在页面执行 JS,返回 JSON 值
  snapshot [--target]      提取可交互元素清单(标签/文本/选择器/坐标)
  tree [--target] [--selector <sel>|--selector-file <file>] [--xpath <xp>|--xpath-file <file>]
                       结构树:整页 body 的文本+结构紧凑层级树(不做可见性判定,只输出文本与结构);
                       --selector/--xpath(或从文件读)可选,只建该区域(取第一个匹配)
  click <selector> [--target] 点击元素
  fill <selector> <值> [--target] 填入输入框并触发 input/change
  focus <selector> [--target] 聚焦元素(配合按键用)
  get_focus [--target]   查看当前焦点元素在哪
  press_key <键> [--target] 按键/组合键,如 Enter、Ctrl+Shift+A、Tab
  hover <selector> [--target] 鼠标移到元素上(触发 mouseover)
  outline [--target]     页面大纲:标题层级 + 关键链接
  content [--target]     提取主内容文本(去导航/页脚,截断)
  shot [--file out.png] [--target] 截图
  logs [--target] [--level error,warn] [--since <ms>] [--json]
                         读 target 控制台日志(常驻 daemon,支持过滤;自动补种)
  listen                 启动/前台运行控制台监听 daemon(常驻后台,一般不手动调)
  listen-stop            停止控制台监听 daemon
  run <脚本文件>         执行自动化脚本(脚本里用全局 cdp API,可循环/等待)
环境变量: CDP_HOST / CDP_PORT(默认 127.0.0.1:9222)
         CDP_LOGS_PORT(监听 daemon 端口,默认 9333)
<匹配>: target id,或 url/title 子串;不传则自动选第一个普通网页`);
    return;
  }

  // run:执行脚本文件(把 cdp API 注入全局,包装成 async,支持顶层 await)
  if (cmd === 'run') {
    const file = args[0];
    if (!file) throw new Error('run 需要脚本文件路径');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const abs = path.resolve(file);
    const code = fs.readFileSync(abs, 'utf8');
    (globalThis as any).cdp = api;
    const BUILTIN_ALLOW = new Set(['os', 'path', 'fs', 'child_process', 'crypto', 'util', 'stream', 'url']);
    const safeRequire = (id: string): any => {
      if (BUILTIN_ALLOW.has(id)) return require(id);
      throw new Error(`脚本不可 require '${id}',仅允许 Node 内建: ${[...BUILTIN_ALLOW].join('/')}`);
    };
    const fn = new Function('cdp', 'require', `return (async () => {\n${code}\n})();`);
    await fn(api, safeRequire);
    return;
  }

  if (cmd === 'ensure') {
    const r = await api.ensure(opts.url);
    const lines: string[] = [];
    lines.push(r.started ? '模式: 冷启动(本次由 ensure 启动浏览器)' : '模式: 热启动(浏览器本就已通过 CDP 就绪)');
    lines.push(`浏览器: ${r.browser || '未知'}`);
    lines.push(r.userData
      ? `用户数据目录: ${r.userData}`
      : `用户数据目录: 未知(浏览器非本次启动,可设环境变量 CDP_USER_DATA 指定)`);
    if (r.url) { lines.push(`已打开: ${r.url}`); lines.push(`targetId: ${r.targetId}`); }
    else lines.push('已连接: 未导航');
    console.log(lines.join('\n'));
    return;
  }

  if (cmd === 'list') {
    const list = await api.list();
    if (list.length === 0) { console.log('(没有 page tab)'); return; }
    const line = (t: any) => `${t.id}  ${t.title || '(无标题)'}  ${t.url}`;
    console.log(list.map((t: any, i: number) => `${i + 1}. ${line(t)}`).join('\n'));
    return;
  }

  if (cmd === 'open') {
    const url = args[0] || 'about:blank';
    const tid = await api.open(url);
    console.log(`已打开: ${url}\ntargetId: ${tid}`);
    return;
  }
  if (cmd === 'close') {
    const t = await api.resolve(args[0]);
    await api.close(t);
    console.log(`已关闭: ${t.title || t.url}`);
    return;
  }

  if (cmd === 'listen') { await cmdListen(); return; }

  if (cmd === 'listen-stop') {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    try { await fetch(`http://127.0.0.1:${LOGS_PORT}/shutdown`, { method: 'POST' }); } catch {}
    let stopped = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      if (!(await daemonHealthy(LOGS_PORT))) { stopped = true; break; }
      await sleep(200);
    }
    if (!stopped) {
      const pf = path.join(os.tmpdir(), 'cdp-listen.pid');
      if (fs.existsSync(pf)) {
        const pid = Number(fs.readFileSync(pf, 'utf8'));
        try { process.kill(pid); stopped = true; } catch {}
        try { fs.unlinkSync(pf); } catch {}
      }
    }
    console.log(stopped ? '已停止监听 daemon' : '未发现运行中的监听 daemon');
    return;
  }

  if (cmd === 'logs') {
    const t = await api.resolve(opts.target);
    const entries = await api.logs(t, { level: opts.level, since: opts.since });
    if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return; }
    if (entries.length === 0) { console.log(`(无控制台日志 · ${t.title || t.url})`); return; }
    console.log(`→ ${t.title} ${t.url}`);
    for (const e of entries) {
      const ts = new Date(e.ts).toTimeString().slice(0, 8);
      const loc = (e.line != null) ? ` (${e.line}:${e.col ?? ''})` : '';
      const argsText = (e.args || []).map((a: any) => a == null ? 'undefined' : (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      console.log(`[${ts}][${e.level}] ${argsText}${loc}`);
    }
    return;
  }

  const target = await api.resolve(opts.target);
  console.error(`→ target: ${target.title || ''} ${target.url}`);

  switch (cmd) {
    case 'navigate': {
      const url = args[0];
      if (!url) throw new Error('navigate 需要 url');
      await api.navigate(target, url);
      console.log(`已导航到: ${url}`);
      break;
    }
    case 'eval': {
      const js = args.join(' ');
      if (!js) throw new Error('eval 需要要执行的 JS');
      console.log(JSON.stringify(await api.eval(target, js), null, 2));
      break;
    }
    case 'snapshot': {
      const value = await api.snapshot(target);
      if (!Array.isArray(value) || value.length === 0) { console.log('(没有可交互元素)'); break; }
      console.log(value.map((e: any, i: number) =>
        `${i + 1}. [${e.tag}] "${e.text || e.placeholder || ''}"  ${e.href ? e.href : ''}  sel=${e.selector}`
      ).join('\n'));
      break;
    }
    case 'tree': {
      const fs = await import('node:fs');
      const sel = opts.selector ?? readOptFile(fs, opts['selector-file']);
      const xp = opts.xpath ?? readOptFile(fs, opts['xpath-file']);
      const r = await api.tree(target, { selector: sel, xpath: xp });
      if (!r.lines?.length) { console.log('(空树)'); break; }
      console.log(r.lines.join('\n'));
      break;
    }
    case 'click': {
      const sel = args[0];
      if (!sel) throw new Error('click 需要 selector');
      const r = await api.click(target, sel);
      console.log(`已点击: ${sel} (${r.tag})`);
      break;
    }
    case 'fill': {
      const sel = args[0], val = args[1];
      if (!sel || val === undefined) throw new Error('fill 需要 selector 和 值');
      await api.fill(target, sel, val);
      console.log(`已填入: ${sel} ← ${val}`);
      break;
    }
    case 'focus': {
      const sel = args[0];
      if (!sel) throw new Error('focus 需要 selector');
      const r = await api.focus(target, sel);
      console.log(`已聚焦: ${sel} (${r.tag})`);
      break;
    }
    case 'get_focus': {
      const f = await api.getFocus(target);
      if (!f) { console.log('(当前无焦点元素)'); break; }
      console.log(`焦点在: [${f.tag}] "${f.text || ''}" ${f.id ? '#' + f.id : ''} sel=${f.selector}`);
      break;
    }
    case 'press_key': {
      const key = args[0];
      if (!key) throw new Error('press_key 需要按键,如 Enter、Ctrl+Shift+A');
      await api.pressKey(target, key);
      console.log(`已按键: ${key}`);
      break;
    }
    case 'hover': {
      const sel = args[0];
      if (!sel) throw new Error('hover 需要 selector');
      await api.hover(target, sel);
      console.log(`已悬停: ${sel}`);
      break;
    }
    case 'outline': {
      const o = await api.outline(target);
      console.log(`标题: ${o.title}\nURL: ${o.url}\n`);
      console.log('— 标题层级 —');
      console.log(o.headings.map((h: any) => '  '.repeat(Math.max(0, h.level - 1)) + `H${h.level}: ${h.text}  sel=${h.selector}`).join('\n') || '(无标题)');
      console.log('\n— 关键链接 —');
      console.log(o.links.map((l: any, i: number) => `${i + 1}. ${l.text}  ${l.href}`).join('\n') || '(无)');
      break;
    }
    case 'content': {
      const c = await api.content(target);
      console.log(`标题: ${c.title}\nURL: ${c.url}\n`);
      console.log(c.text || '(无正文)');
      break;
    }
    case 'shot': {
      const file = await api.shot(target, opts.file);
      console.log(`已截图: ${file}`);
      break;
    }
    default:
      throw new Error(`未知命令: ${cmd}(用 node dist/cdp.js help 看用法)`);
  }
}

// 作为模块被 require 时导出 API;作为脚本运行时走 CLI
// (esbuild CJS 输出下 require.main === module 语义保留)。
if (require.main === module) {
  main().catch((err: any) => { console.error(`错误: ${err.message}`); process.exit(1); });
} else {
  module.exports = api;
}
