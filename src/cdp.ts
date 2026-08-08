/**
 * cdp.ts — 通过 CDP 控制本地浏览器的脚本入口(commander CLI)。
 * 编译产物为 dist/cdp.js(esbuild bundle,含 commander,dist 自包含)。
 * 运行 `node dist/cdp.js <子命令>`;require 本文件时导出 api。
 */
import { program } from 'commander';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { sleep } from './transport';
import { coreApi } from './api';
import { logs, cmdListen, daemonHealthy, LOGS_PORT, pidFilePath as joinPidPath } from './monitor';
import { ensureBrowser } from './browser';

const api = { ...coreApi, logs, ensure: ensureBrowser };

/** 读 --xpath-file/--selector-file 内容(去首尾空白)。 */
function readOptFile(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  try { return readFileSync(file, 'utf8').trim(); }
  catch (e: any) { throw new Error(`读取参数文件失败: ${file} — ${e.message}`); }
}

/** 带 target 的命令统一拿目标并打印提示。target 为该命令 option 解析出的值。 */
async function needTarget(target?: string): Promise<any> {
  const t = await api.resolve(target ?? undefined);
  console.error(`→ target: ${t.title || ''} ${t.url}`);
  return t;
}

/** 需要 target 的命令模板:给子命令挂 --target option。 */
function targetCmd(name: string, desc: string) {
  return program.command(name).description(desc).option('-t, --target <匹配>', '目标 tab(id/url/title 子串)');
}

// —— 不需要 target 的命令 ——
program
  .name('cdp')
  .version('1.0.0')
  .description('CDP 浏览器控制(取代 chrome-devtools MCP)');

program.command('ensure')
  .description('确保浏览器已通过 CDP 就绪(自动探测 Edge/Chrome),可选 --url 直接导航')
  .option('--url <url>', '打开指定网页')
  .action(async (opts) => {
    const r = await api.ensure(opts.url);
    const lines: string[] = [r.started ? '模式: 冷启动(本次由 ensure 启动浏览器)' : '模式: 热启动(浏览器本就已通过 CDP 就绪)', `浏览器: ${r.browser || '未知'}`];
    lines.push(r.userData ? `用户数据目录: ${r.userData}` : '用户数据目录: 未知(可设环境变量 CDP_USER_DATA 指定)');
    if (r.url) { lines.push(`已打开: ${r.url}`); lines.push(`targetId: ${r.targetId}`); }
    else lines.push('已连接: 未导航');
    console.log(lines.join('\n'));
  });

program.command('list').description('列出所有 page tab(含手动开的)')
  .action(async () => {
    const list = await api.list();
    if (list.length === 0) { console.log('(没有 page tab)'); return; }
    const line = (t: any) => `${t.id}  ${t.title || '(无标题)'}  ${t.url}`;
    console.log(list.map((t: any, i: number) => `${i + 1}. ${line(t)}`).join('\n'));
  });

program.command('open').argument('<url>', '要打开的网址').description('新开一个 tab')
  .action(async (url) => { const tid = await api.open(url || 'about:blank'); console.log(`已打开: ${url}\ntargetId: ${tid}`); });

program.command('close').argument('<target>', '目标匹配').description('关闭 tab')
  .action(async (tgt) => { const t = await api.resolve(tgt); await api.close(t); console.log(`已关闭: ${t.title || t.url}`); });

program.command('listen').description('启动/前台运行控制台监听 daemon')
  .action(async () => { await cmdListen(); });

program.command('listen-stop').description('停止控制台监听 daemon')
  .action(async () => {
    try { await fetch(`http://127.0.0.1:${LOGS_PORT}/shutdown`, { method: 'POST' }); } catch {}
    let stopped = false; const t0 = Date.now();
    while (Date.now() - t0 < 3000) { if (!(await daemonHealthy(LOGS_PORT))) { stopped = true; break; } await sleep(200); }
    if (!stopped) { const pf = joinPidPath(); if (existsSync(pf)) { const pid = Number(readFileSync(pf, 'utf8')); try { process.kill(pid); stopped = true; } catch {} try { unlinkSync(pf); } catch {} } }
    console.log(stopped ? '已停止监听 daemon' : '未发现运行中的监听 daemon');
  });

program.command('run').argument('<file>', '脚本文件').description('执行自动化脚本(脚本里用全局 cdp API,可顶层 await)')
  .action(async (file) => {
    const abs = pathResolve(file); const code = readFileSync(abs, 'utf8');
    (globalThis as any).cdp = api;
    const BUILTIN_ALLOW = new Set(['os', 'path', 'fs', 'child_process', 'crypto', 'util', 'stream', 'url']);
    const safeRequire = (id: string): any => { if (BUILTIN_ALLOW.has(id)) return require(id); throw new Error(`脚本不可 require '${id}',仅允许 Node 内建: ${[...BUILTIN_ALLOW].join('/')}`); };
    const fn = new Function('cdp', 'require', `return (async () => {\n${code}\n})();`);
    await fn(api, safeRequire);
  });

// —— 需要 target 的命令(每个挂 --target option,action 末参为 opts,含 opts.target) ——
targetCmd('navigate', '导航到 url').argument('<url>', '网址')
  .action(async (url, opts) => { await api.navigate(await needTarget(opts.target), url); console.log(`已导航到: ${url}`); });

targetCmd('eval', '在页面执行 JS,返回 JSON 值').argument('<js...>', '要执行的 JS')
  .action(async (js, opts) => { const code = (js as string[]).join(' '); console.log(JSON.stringify(await api.eval(await needTarget(opts.target), code), null, 2)); });

targetCmd('tree', '结构树:整页 body 的文本+结构紧凑层级树(锚点互斥:--ref 优先,其次 --selector-file/--xpath-file,缺省 body;--ancestor 统一爬父;--visible-only 只输出视口内可见)')
  .option('--ref <n>', '按 tree 输出的 ref 序号建树根(与 --selector-file/--xpath-file 二选一)')
  .option('--ancestor <n>', '从建树根向上爬 N 层父级再建树(默认 0;与 --ref/selector/xpath 任一锚点配合)')
  .option('--selector-file <file>', '从文件读 selector')
  .option('--xpath-file <file>', '从文件读 xpath')
  .option('--visible-only', '只输出当前视口内几何可见且非隐藏(display:none/opacity:0)的元素,模拟 agent 看到的当前屏幕;视口外的祖先退化为纯容器骨架')
  .action(async (opts) => {
    const sel = readOptFile(opts.selectorFile);
    const xp = readOptFile(opts.xpathFile);
    if (opts.ref != null && (sel || xp)) throw new Error('--ref 与 --selector-file/--xpath-file 只能选其一');
    const r = await api.tree(await needTarget(opts.target), {
      selector: sel, xpath: xp, visibleOnly: !!opts.visibleOnly,
      ref: opts.ref != null ? Number(opts.ref) : undefined,
      ancestor: opts.ancestor != null ? Number(opts.ancestor) : undefined,
    });
    if (!r.lines?.length) { console.log('(空树)'); return; }
    console.log(r.lines.join('\n'));
  });

targetCmd('xpath', '按 xpath 查元素(shadow 穿透,含分步诊断)')
  .argument('<file>', 'xpath 文件路径(从文件读 xpath,免 shell 转义)')
  .action(async (file, opts) => {
    const xp = readOptFile(file);
    if (!xp) throw new Error('需传 xpath 文件');
    const r = await api.xpath(await needTarget(opts.target), xp);
    if (!r.count) {
      console.log(`未命中: ${xp}`);
      console.log('— 分步诊断 —');
      for (const s of r.trace || []) {
        const axis = s.axis === 'desc' ? '//' : '/';
        console.log(`  ${axis}${s.text}  输入 ${s.input} → 命中 ${s.matched}${s.sample ? `   (当时候选: <${s.sample}>)` : ''}`);
      }
      return;
    }
    console.log(`命中 ${r.count} 个:`);
    for (const m of r.matches || []) console.log(`  [${m.tag}] "${m.text || ''}"  sel=${m.selector || ''}`);
    if (r.count > (r.matches || []).length) console.log(`  …(还有 ${r.count - (r.matches || []).length} 个未列出)`);
  });

targetCmd('locate', '从 tree 的 ref 序号反查稳定定位器(selector + xpath)。ref 是会话句柄,页面刷新后失效;此命令把 ref 翻译成刷新后仍可用的定位器,供 tree --selector-file/--xpath-file 复用')
  .argument('<n>', 'tree 输出的 ref 序号')
  .option('--ancestor <n>', '向上爬 N 层父级再定位(默认 0;把内容叶子抬升到语义区域容器)')
  .action(async (n, opts) => {
    const r = await api.locate(await needTarget(opts.target), Number(n), opts.ancestor != null ? Number(opts.ancestor) : undefined);
    console.log(`[${r.tag}] "${r.text || ''}"`);
    console.log(`  selector: ${r.selector || '(无)'}`);
    console.log(`  xpath:    ${r.xpath || '(无)'}`);
  });

// ref 操作目标:--ref 优先,否则用位置参数 selector(见 api.TargetArg)。两者都没给时报错。
function refOrSel(sel: string | undefined, opts: any): string | { ref: number } {
  if (opts.ref != null) return { ref: Number(opts.ref) };
  if (sel) return sel;
  throw new Error('需提供 selector 或 --ref');
}
const refOpt = (c: any) => c.option('--ref <n>', '按 tree 输出的 ref 序号操作(穿透 shadow,与 selector 二选一)');

refOpt(targetCmd('click', '点击元素')).argument('[selector]', 'selector 或 --ref')
  .action(async (sel: string, opts: any) => { const arg = refOrSel(sel, opts); const r = await api.click(await needTarget(opts.target), arg); console.log(`已点击: ${typeof arg === 'string' ? arg : 'ref=' + arg.ref} (${r.tag})`); });

refOpt(targetCmd('fill', '填输入框并触发 input/change')).argument('[selector]', 'selector 或 --ref').argument('<value>', '值')
  .action(async (sel: string, val: string, opts: any) => { const arg = refOrSel(sel, opts); await api.fill(await needTarget(opts.target), arg, val); console.log(`已填入: ${typeof arg === 'string' ? arg : 'ref=' + arg.ref} ← ${val}`); });

refOpt(targetCmd('focus', '聚焦元素')).argument('[selector]', 'selector 或 --ref')
  .action(async (sel: string, opts: any) => { const arg = refOrSel(sel, opts); const r = await api.focus(await needTarget(opts.target), arg); console.log(`已聚焦: ${typeof arg === 'string' ? arg : 'ref=' + arg.ref} (${r.tag})`); });

targetCmd('get-focus', '查看当前焦点元素在哪')
  .action(async (opts) => { const f = await api.getFocus(await needTarget(opts.target)); if (!f) { console.log('(当前无焦点元素)'); return; } console.log(`焦点在: [${f.tag}] "${f.text || ''}" ${f.id ? '#' + f.id : ''} sel=${f.selector}`); });

targetCmd('press-key', '按键/组合键,如 Enter、Ctrl+Shift+A、Tab').argument('<key>', '按键')
  .action(async (key, opts) => { await api.pressKey(await needTarget(opts.target), key); console.log(`已按键: ${key}`); });

refOpt(targetCmd('hover', '鼠标移到元素上')).argument('[selector]', 'selector 或 --ref')
  .action(async (sel: string, opts: any) => { const arg = refOrSel(sel, opts); await api.hover(await needTarget(opts.target), arg); console.log(`已悬停: ${typeof arg === 'string' ? arg : 'ref=' + arg.ref}`); });

targetCmd('shot', '截图').option('-f, --file <file>', '输出文件')
  .action(async (opts) => { const file = await api.shot(await needTarget(opts.target), opts.file); console.log(`已截图: ${file}`); });

targetCmd('logs', '读 target 控制台日志(常驻 daemon,支持过滤)')
  .option('--level <level>', '过滤级别,如 error,warn')
  .option('--since <ms>', '仅最近 N 毫秒,单位毫秒')
  .option('--json', 'JSON 输出')
  .action(async (opts) => {
    const t = await needTarget(opts.target); const entries = await api.logs(t, { level: opts.level, since: opts.since });
    if (opts.json) { console.log(JSON.stringify(entries, null, 2)); return; }
    if (!entries.length) { console.log(`(无控制台日志 · ${t.title || t.url})`); return; }
    console.log(`→ ${t.title} ${t.url}`);
    for (const e of entries) { const ts = new Date(e.ts).toTimeString().slice(0, 8); const loc = (e.line != null) ? ` (${e.line}:${e.col ?? ''})` : ''; const argsText = (e.args || []).map((a: any) => a == null ? 'undefined' : (typeof a === 'string' ? a : JSON.stringify(a))).join(' '); console.log(`[${ts}][${e.level}] ${argsText}${loc}`); }
  });

if (require.main === module) {
  program.parseAsync(process.argv).catch((err: any) => { console.error(`错误: ${err.message}`); process.exit(1); });
}

export = api;
