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
 *
 * CLI 分发用命令表(commands: Record<子命令, handler>),main() 只管「解析参数 → 查表 → 调用」。
 * 每个 handler 自行决定是否需要 target:需要则调用 ctx.resolveTarget()。
 */
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { sleep } from './transport';
import { coreApi } from './api';
import { logs, cmdListen, daemonHealthy, LOGS_PORT, pidFilePath as joinPidPath } from './monitor';
import { ensureBrowser } from './browser';
import { parseArgs } from './cli-args';

// 最终 api 对象:核心页面操作 + 控制台监听读取 + 浏览器 ensure。require 本文件时导出它。
const api = { ...coreApi, logs, ensure: ensureBrowser };

// ==================== CLI ====================

/** 从 --xpath-file/--selector-file 读内容(去首尾空白),没给 flag 返回 undefined。 */
function readOptFile(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  try { return readFileSync(file, 'utf8').trim(); }
  catch (e: any) { throw new Error(`读取参数文件失败: ${file} — ${e.message}`); }
}

// 命令表上下文:每个 handler 从这里拿位置参数/opts/api,以及按需解析 target。
type Ctx = {
  args: string[];
  opts: Record<string, any>;
  api: typeof api;
  /** 按 opts.target 解析目标 tab;带 target 的命令在 handler 开头调它。 */
  resolveTarget: () => Promise<any>;
};

type Handler = (ctx: Ctx) => Promise<void>;

// 需要 target 的命令统一从这里拿目标并打印提示(消除各命令重复的 resolve+console.error 样板)。
async function needTarget(ctx: Ctx): Promise<any> {
  const t = await ctx.api.resolve(ctx.opts.target);
  console.error(`→ target: ${t.title || ''} ${t.url}`);
  return t;
}

const commands: Record<string, Handler> = {
  // help:不传参或 `help`/`--help`/`-h` 都打印用法。
  help: async () => {
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
                         读 target 控制台日志(常驻 daemon,支持过滤;自动补种);
                         --since 单位为毫秒
  listen                 启动/前台运行控制台监听 daemon(常驻后台,一般不手动调)
  listen-stop            停止控制台监听 daemon
  run <脚本文件>         执行自动化脚本(脚本里用全局 cdp API,可循环/等待)
环境变量: CDP_HOST / CDP_PORT(默认 127.0.0.1:9222)
         CDP_LOGS_PORT(监听 daemon 端口,默认 9333)
<匹配>: target id,或 url/title 子串;不传则自动选第一个普通网页`);
  },

  // run:执行脚本文件(把 cdp API 注入全局,包装成 async,支持顶层 await)。
  run: async ({ args }) => {
    const file = args[0];
    if (!file) throw new Error('run 需要脚本文件路径');
    const abs = pathResolve(file);
    const code = readFileSync(abs, 'utf8');
    (globalThis as any).cdp = api;
    const BUILTIN_ALLOW = new Set(['os', 'path', 'fs', 'child_process', 'crypto', 'util', 'stream', 'url']);
    const safeRequire = (id: string): any => {
      if (BUILTIN_ALLOW.has(id)) return require(id);
      throw new Error(`脚本不可 require '${id}',仅允许 Node 内建: ${[...BUILTIN_ALLOW].join('/')}`);
    };
    const fn = new Function('cdp', 'require', `return (async () => {\n${code}\n})();`);
    await fn(api, safeRequire);
  },

  ensure: async ({ api: a, opts }) => {
    const r = await a.ensure(opts.url);
    const lines: string[] = [];
    lines.push(r.started ? '模式: 冷启动(本次由 ensure 启动浏览器)' : '模式: 热启动(浏览器本就已通过 CDP 就绪)');
    lines.push(`浏览器: ${r.browser || '未知'}`);
    lines.push(r.userData
      ? `用户数据目录: ${r.userData}`
      : `用户数据目录: 未知(浏览器非本次启动,可设环境变量 CDP_USER_DATA 指定)`);
    if (r.url) { lines.push(`已打开: ${r.url}`); lines.push(`targetId: ${r.targetId}`); }
    else lines.push('已连接: 未导航');
    console.log(lines.join('\n'));
  },

  list: async ({ api: a }) => {
    const list = await a.list();
    if (list.length === 0) { console.log('(没有 page tab)'); return; }
    const line = (t: any) => `${t.id}  ${t.title || '(无标题)'}  ${t.url}`;
    console.log(list.map((t: any, i: number) => `${i + 1}. ${line(t)}`).join('\n'));
  },

  open: async ({ api: a, args }) => {
    const url = args[0] || 'about:blank';
    const tid = await a.open(url);
    console.log(`已打开: ${url}\ntargetId: ${tid}`);
  },

  close: async (ctx) => {
    const t = await ctx.api.resolve(ctx.args[0]);
    await ctx.api.close(t);
    console.log(`已关闭: ${t.title || t.url}`);
  },

  listen: async () => { await cmdListen(); },

  'listen-stop': async () => {
    try { await fetch(`http://127.0.0.1:${LOGS_PORT}/shutdown`, { method: 'POST' }); } catch {}
    let stopped = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      if (!(await daemonHealthy(LOGS_PORT))) { stopped = true; break; }
      await sleep(200);
    }
    if (!stopped) {
      const pf = joinPidPath();
      if (existsSync(pf)) {
        const pid = Number(readFileSync(pf, 'utf8'));
        try { process.kill(pid); stopped = true; } catch {}
        try { unlinkSync(pf); } catch {}
      }
    }
    console.log(stopped ? '已停止监听 daemon' : '未发现运行中的监听 daemon');
  },

  logs: async (ctx) => {
    const t = await needTarget(ctx);
    const entries = await ctx.api.logs(t, { level: ctx.opts.level, since: ctx.opts.since });
    if (ctx.opts.json) { console.log(JSON.stringify(entries, null, 2)); return; }
    if (entries.length === 0) { console.log(`(无控制台日志 · ${t.title || t.url})`); return; }
    console.log(`→ ${t.title} ${t.url}`);
    for (const e of entries) {
      const ts = new Date(e.ts).toTimeString().slice(0, 8);
      const loc = (e.line != null) ? ` (${e.line}:${e.col ?? ''})` : '';
      const argsText = (e.args || []).map((a: any) => a == null ? 'undefined' : (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      console.log(`[${ts}][${e.level}] ${argsText}${loc}`);
    }
  },

  // ———— 以下命令需要 resolve target ————
  navigate: async (ctx) => {
    const url = ctx.args[0];
    if (!url) throw new Error('navigate 需要 url');
    await ctx.api.navigate(await needTarget(ctx), url);
    console.log(`已导航到: ${url}`);
  },

  eval: async (ctx) => {
    const js = ctx.args.join(' ');
    if (!js) throw new Error('eval 需要要执行的 JS');
    console.log(JSON.stringify(await ctx.api.eval(await needTarget(ctx), js), null, 2));
  },

  snapshot: async (ctx) => {
    const value = await ctx.api.snapshot(await needTarget(ctx));
    if (!Array.isArray(value) || value.length === 0) { console.log('(没有可交互元素)'); return; }
    console.log(value.map((e: any, i: number) =>
      `${i + 1}. [${e.tag}] "${e.text || e.placeholder || ''}"  ${e.href ? e.href : ''}  sel=${e.selector}`
    ).join('\n'));
  },

  tree: async (ctx) => {
    const sel = ctx.opts.selector ?? readOptFile(ctx.opts['selector-file']);
    const xp = ctx.opts.xpath ?? readOptFile(ctx.opts['xpath-file']);
    const r = await ctx.api.tree(await needTarget(ctx), { selector: sel, xpath: xp });
    if (!r.lines?.length) { console.log('(空树)'); return; }
    console.log(r.lines.join('\n'));
  },

  click: async (ctx) => {
    const sel = ctx.args[0];
    if (!sel) throw new Error('click 需要 selector');
    const r = await ctx.api.click(await needTarget(ctx), sel);
    console.log(`已点击: ${sel} (${r.tag})`);
  },

  fill: async (ctx) => {
    const sel = ctx.args[0], val = ctx.args[1];
    if (!sel || val === undefined) throw new Error('fill 需要 selector 和 值');
    await ctx.api.fill(await needTarget(ctx), sel, val);
    console.log(`已填入: ${sel} ← ${val}`);
  },

  focus: async (ctx) => {
    const sel = ctx.args[0];
    if (!sel) throw new Error('focus 需要 selector');
    const r = await ctx.api.focus(await needTarget(ctx), sel);
    console.log(`已聚焦: ${sel} (${r.tag})`);
  },

  get_focus: async (ctx) => {
    const f = await ctx.api.getFocus(await needTarget(ctx));
    if (!f) { console.log('(当前无焦点元素)'); return; }
    console.log(`焦点在: [${f.tag}] "${f.text || ''}" ${f.id ? '#' + f.id : ''} sel=${f.selector}`);
  },

  press_key: async (ctx) => {
    const key = ctx.args[0];
    if (!key) throw new Error('press_key 需要按键,如 Enter、Ctrl+Shift+A');
    await ctx.api.pressKey(await needTarget(ctx), key);
    console.log(`已按键: ${key}`);
  },

  hover: async (ctx) => {
    const sel = ctx.args[0];
    if (!sel) throw new Error('hover 需要 selector');
    await ctx.api.hover(await needTarget(ctx), sel);
    console.log(`已悬停: ${sel}`);
  },

  outline: async (ctx) => {
    const o = await ctx.api.outline(await needTarget(ctx));
    console.log(`标题: ${o.title}\nURL: ${o.url}\n`);
    console.log('— 标题层级 —');
    console.log(o.headings.map((h: any) => '  '.repeat(Math.max(0, h.level - 1)) + `H${h.level}: ${h.text}  sel=${h.selector}`).join('\n') || '(无标题)');
    console.log('\n— 关键链接 —');
    console.log(o.links.map((l: any, i: number) => `${i + 1}. ${l.text}  ${l.href}`).join('\n') || '(无)');
  },

  content: async (ctx) => {
    const c = await ctx.api.content(await needTarget(ctx));
    console.log(`标题: ${c.title}\nURL: ${c.url}\n`);
    console.log(c.text || '(无正文)');
  },

  shot: async (ctx) => {
    const file = await ctx.api.shot(await needTarget(ctx), ctx.opts.file);
    console.log(`已截图: ${file}`);
  },
};

async function main(): Promise<void> {
  const { args, opts } = parseArgs(process.argv.slice(2));
  const cmd = args.shift();

  // 不传参,或 help/--help/-h 都归到 help handler。
  const name = !cmd || cmd === '--help' || cmd === '-h' ? 'help' : cmd;

  const handler = commands[name];
  if (!handler) throw new Error(`未知命令: ${cmd}(用 node dist/cdp.js help 看用法)`);

  // 构造并发给 handler 的上下文;按需解析 target。
  const ctx: Ctx = {
    args,
    opts,
    api,
    resolveTarget: () => api.resolve(opts.target),
  };
  await handler(ctx);
}

// 作为模块被 require 时导出 API;作为脚本运行时走 CLI
// (esbuild CJS 输出下 require.main === module 语义保留)。
if (require.main === module) {
  main().catch((err: any) => { console.error(`错误: ${err.message}`); process.exit(1); });
} else {
  module.exports = api;
}
