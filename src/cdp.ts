/**
 * cdp.ts — 通过 CDP 控制本地浏览器的脚本入口(commander CLI)。
 * 编译产物为 dist/cdp.js(esbuild bundle,含 commander,dist 自包含)。
 * 运行 `node dist/cdp.js <子命令>`;require 本文件时导出 api。
 */
import { program } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { coreApi } from './api';
import { logs, cmdListen } from './monitor';
import { ensureBrowser } from './browser';

const api = { ...coreApi, logs, ensure: ensureBrowser };

/** 读 --selector-file 内容(去首尾空白)。 */
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

program.command('list').description('确保浏览器就绪并列出所有 page tab(含手动开的)')
  .action(async () => {
    await api.ensure(); // 合并 ensure:CDP 未起则自动启动(已就绪则无开销),agent 无需先 ensure 再 list。
    const list = await api.list();
    console.log(`共 ${list.length} 个 tab:`);
    if (list.length === 0) return;
    const line = (t: any) => `${t.id}  ${t.title || '(无标题)'}  ${t.url}`;
    console.log(list.map((t: any, i: number) => `${i + 1}. ${line(t)}`).join('\n'));
  });

program.command('open').argument('<url>', '要打开的网址').description('新开一个 tab')
  .action(async (url) => { const tid = await api.open(url || 'about:blank'); console.log(`已打开: ${url}\ntargetId: ${tid}`); });

program.command('close').argument('<target>', '目标匹配').description('关闭 tab')
  .action(async (tgt) => { const t = await api.resolve(tgt); await api.close(t); console.log(`已关闭: ${t.title || t.url}`); });

// 隐藏命令:内部 daemon 自重生入口(cmdListen)。用户不直接调——监听 daemon 由 open/ensure/logs
// 自动拉起,浏览器关闭后看门狗自退,无需手动 listen/listen-stop 管理(见 SKILL「读控制台日志」)。
program.command('__daemon', { hidden: true }).description('(内部)控制台监听注入守护')
  .action(async () => { await cmdListen(); });

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

targetCmd('tree', '结构树:整页 body 的文本+结构紧凑层级树(锚点互斥:--ref 优先,其次 --selector-file,缺省 body;--ancestor 统一爬父;--visible-only 只输出视口内可见)')
  .option('--ref <n>', '按 tree 输出的 ref 序号建树根(与 --selector-file 二选一)')
  .option('--ancestor <n>', '从建树根向上爬 N 层父级再建树(默认 0;与 --ref/selector 任一锚点配合)')
  .option('--selector-file <file>', '从文件读 selector')
  .option('--visible-only', '只输出当前视口内几何可见且非隐藏(display:none/opacity:0)的元素,模拟 agent 看到的当前屏幕;视口外的祖先退化为纯容器骨架')
  .option('--scroll-to-load', '先滚动触发懒加载(评论区等首屏外的内容)再建树——模拟真实用户滚动,防 agent 找不到未加载区域(默认 ±1 屏回弹)')
  .option('--scroll-pages <n>', '与 --scroll-to-load 配合:循环向下滚 N 屏(边滚边检测 scrollHeight 增长,连续 2 次不增长提前停),用于无限流')
  .option('--scroll-to <selector>', '与 --scroll-to-load 配合:先滚到匹配该 selector 的元素(如 B站评论区 #bili-comments),命中不到优雅降级')
  .action(async (opts) => {
    const sel = readOptFile(opts.selectorFile);
    if (opts.ref != null && sel) throw new Error('--ref 与 --selector-file 只能选其一');
    if ((opts.scrollPages != null || opts.scrollTo != null) && !opts.scrollToLoad) {
      throw new Error('--scroll-pages / --scroll-to 必须与 --scroll-to-load 配合使用');
    }
    const r = await api.tree(await needTarget(opts.target), {
      selector: sel, visibleOnly: !!opts.visibleOnly,
      ref: opts.ref != null ? Number(opts.ref) : undefined,
      ancestor: opts.ancestor != null ? Number(opts.ancestor) : undefined,
      scrollToLoad: !!opts.scrollToLoad,
      scrollPages: opts.scrollPages != null ? Number(opts.scrollPages) : undefined,
      scrollTo: opts.scrollTo || undefined,
    });
    if (!r.lines?.length) { console.log('(空树)'); return; }
    console.log(r.lines.join('\n'));
  });

targetCmd('locate', '从 tree 的 ref 序号反查稳定 CSS selector。ref 是会话句柄,页面刷新后失效;此命令把 ref 翻译成刷新后仍可用的 selector,供 tree --selector-file 复用')
  .argument('<n>', 'tree 输出的 ref 序号')
  .option('--ancestor <n>', '向上爬 N 层父级再定位(默认 0;把内容叶子抬升到语义区域容器)')
  .action(async (n, opts) => {
    const r = await api.locate(await needTarget(opts.target), Number(n), opts.ancestor != null ? Number(opts.ancestor) : undefined);
    if (printRefInvalid(r)) return; // ref 失效(含从未存在):打印自愈提示,不打印 selector
    console.log(`[${r.tag}] "${r.text || ''}"`);
    if (r.shadow) {
      // shadow 内元素:标准 selector 在 document 上查不到(querySelector 返 null),不能用。
      // 给 shadowChain(hostSel >>> innerSel >>> ...)——tree --selector-file 能解析它穿透。
      console.log(`  ⚠ 该元素在 shadow DOM 内,标准 CSS selector 无法穿透(上面 selector 仅指向最外层 host)。`);
      console.log(`  shadow 链(可写入 selector-file 复用): ${r.shadowChain || '(生成失败)'}`);
      console.log(`  或直接用 ref=${n} 操作(操作命令穿透 shadow)。`);
    } else {
      console.log(`  selector: ${r.selector || '(无)'}`);
    }
  });

targetCmd('find', '按文本或 selector 找元素,登记新 ref 返回(类 uBlock :has-text())。ref 失效后不必整页 tree,直接 find --text "关键词" 拿新 ref')
  .option('--text <关键词>', '在整页(穿透 shadow)搜文本含该关键词的元素(自身或后代文本)')
  .option('--selector <css>', '按 CSS selector 命中(支持 `>>>` shadow 链)')
  .option('--ancestor <n>', '命中后向上爬 N 层父级到区域容器(默认 0)')
  .option('--all', '返回全部命中并各自登记 ref(默认仅首个)')
  .action(async (opts) => {
    if (!opts.text && !opts.selector) throw new Error('需提供 --text 或 --selector');
    if (opts.text && opts.selector) throw new Error('--text 与 --selector 只能选其一');
    const r = await api.find(await needTarget(opts.target), {
      text: opts.text, selector: opts.selector,
      ancestor: opts.ancestor != null ? Number(opts.ancestor) : undefined,
      all: !!opts.all,
    });
    if (!r.hits?.length) { console.log(r.err || '未找到'); return; }
    for (const h of r.hits) {
      console.log(`[ref=${h.ref}] ${h.line}`);
    }
  });

targetCmd('lineage', '列目标元素(爬 ancestor 后)从 html 到自身的祖先链:每层 tag/id/class/语义 data-* /aria/role。挑稳定锚点写 fold add 这种 uBlock 式短规则(如 #biliMainHeader)')
  .argument('<n>', 'tree 输出的 ref 序号')
  .option('--ancestor <n>', '向上爬 N 层父级再列祖先链(默认 0;把内容叶子抬升到语义区域容器)')
  .action(async (n, opts) => {
    const r = await api.lineage(await needTarget(opts.target), Number(n), opts.ancestor != null ? Number(opts.ancestor) : undefined);
    if (printRefInvalid(r)) return; // ref 失效(含从未存在):打印自愈提示
    if (!r.chain?.length) { console.log('(空祖先链)'); return; }
    // 缩进树:html 在 depth 0,每层 2 空格缩进;目标元素(最深层)标 [ref=N]
    for (const node of r.chain) {
      const indent = '  '.repeat(node.depth);
      const parts: string[] = [node.tag];
      if (node.id) parts.push('#' + node.id);
      if (node.classes?.length) {
        const cls = Array.isArray(node.classes) ? node.classes.join('.') : node.classes;
        parts.push('.' + cls);
      }
      if (node.dataAttrs) for (const [k, v] of Object.entries(node.dataAttrs)) parts.push(`${k}="${v}"`);
      if (node.role) parts.push(`role="${node.role}"`);
      if (node.aria) parts.push(`aria="${node.aria}"`);
      const mark = node.depth === r.targetDepth ? `  [ref=${n}]` : '';
      console.log(`${indent}${parts.join(' ')}${mark}`);
    }
    console.log(`\n建议 selector(genSel): ${r.suggested || '(无)'}`);
  });

targetCmd('fold', '折叠规则(类 uBlock Origin:域名+selector+备注,tree 时命中区域折叠成一行 ▸,跨会话持久)。子命令:add/list/rm;或 --ref [--save] 折叠')
  .argument('[args...]', 'add <域名> <selector> <备注> | list | rm <id>;或省略走 --ref 模式')
  .option('--ref <n>', '按 ref 折叠其区域(可选 --ancestor 爬父到容器)')
  .option('--ancestor <n>', '按 ref 定位后向上爬 N 层父级再折叠(默认 0;把内容叶子抬到区域容器)')
  .option('--note <备注>', '折叠备注(tree 里 ▸ 后显示)')
  .option('--save', '落盘为持久规则(默认仅会话级临时折叠,刷新失效)')
  .option('--domain <d>', '持久规则的域名(默认当前页 hostname;支持 *.suffix 通配)')
  .option('--path <前缀>', '持久规则的 URL pathname 前缀(限定只在该路径下命中,修同域名跨页错位,如 /video)')
  .action(async (args, opts) => {
    const t = await needTarget(opts.target);
    const [cmd, ...rest] = args || [];
    if (cmd === 'list') {
      const r = await api.fold(t, { list: true });
      if (!r.persist?.length && !r.tmp?.length) { console.log('无折叠规则(用 fold add 或 fold --ref --save 添加)'); return; }
      if (r.persist?.length) {
        console.log('持久规则(folds.txt):');
        r.persist.forEach((f: any) => console.log(`  [${f.id}] ${f.domain}${f.pathPrefix ? ' ' + f.pathPrefix : ''}  ${f.selector}  # ${f.note}`));
      }
      if (r.tmp?.length) { console.log('会话级临时(刷新失效):'); r.tmp.forEach((f: any, i: number) => console.log(`  [t${i}] ${f.selector}  # ${f.note}`)); }
      return;
    }
    if (cmd === 'rm') {
      const id = Number(rest[0]);
      const r = await api.fold(t, { rm: id });
      console.log(r.ok ? `已删除规则 [${id}]` : `未找到规则 [${id}]`);
      return;
    }
    if (cmd === 'add') {
      const [domain, selector, ...noteParts] = rest;
      if (!domain || !selector) throw new Error('用法: fold add <域名> <selector> <备注> [--path <前缀>]');
      const r = await api.fold(t, { add: { domain, selector, note: noteParts.join(' '), path: opts.path } });
      console.log(`已添加持久规则 [${r.rule.id}]: ${domain}${r.rule.pathPrefix ? ' ' + r.rule.pathPrefix : ''}  ${selector}  # ${r.rule.note}`);
      return;
    }
    if (opts.ref == null) throw new Error('用法: fold --ref <n> [备注] [--save] [--domain d] [--path <前缀>];或 fold add/list/rm');
    // --ref 模式:未被识别的位置参数(非 add/list/rm)当作备注
    const note = opts.note || (args && args.length ? args.join(' ') : undefined);
    const r = await api.fold(t, {
      ref: Number(opts.ref), ancestor: opts.ancestor != null ? Number(opts.ancestor) : undefined,
      note, save: !!opts.save, domain: opts.domain, path: opts.path,
    });
    if (printRefInvalid(r)) return; // ref 失效(含从未存在):打印自愈提示,不打印"已折叠"
    if (r.rule) console.log(`已添加持久规则 [${r.rule.id}]: ${r.rule.domain}${r.rule.pathPrefix ? ' ' + r.rule.pathPrefix : ''}  ${r.rule.selector}  # ${r.rule.note}`);
    else console.log(`已临时折叠: ${r.selector}  # ${r.note}`);
  });

// ref 操作目标:--ref 优先,否则用位置参数 selector(见 api.TargetArg)。两者都没给时报错。
function refOrSel(sel: string | undefined, opts: any): string | { ref: number; ancestor?: number } {
  if (opts.ref != null) return { ref: Number(opts.ref), ancestor: opts.ancestor != null ? Number(opts.ancestor) : undefined };
  if (sel) return sel;
  throw new Error('需提供 selector 或 --ref');
}
const refOpt = (c: any) => c
  .option('--ref <n>', '按 tree 输出的 ref 序号操作(穿透 shadow,与 selector 二选一)')
  .option('--ancestor <n>', '按 --ref 定位后向上爬 N 层父级再操作(默认 0;把内容叶子抬到区域容器)');

/** 操作后自动反馈 option(click/fill/focus/hover/press-key 共用)。默认开启,等 feedbackDelay 后回报新增内容 + tab 变化。 */
const feedbackOpt = (c: any) => c
  .option('--no-feedback', '关闭操作后自动反馈(不等待、不观察、不 diff tab)')
  .option('--feedback-delay <ms>', '操作后等待时长,毫秒(默认 1000;给异步/懒加载内容出现留时间)', (v: string) => parseInt(v, 10), 1000);

/** 组装反馈配置(供 api 动作方法):--no-feedback 或 --feedback-delay。
 * 注意 commander 的 `--no-feedback` 生成布尔 option 名为 `feedback`(默认 true,传 --no-feedback 时 false)。 */
const feedbackCfg = (opts: any): { noFeedback: boolean; feedbackDelay: number } => ({
  noFeedback: opts.feedback === false,
  feedbackDelay: opts.feedbackDelay != null ? Number(opts.feedbackDelay) : 1000,
});

/**
 * ref 失效自愈的三态文案(共享:click/fill/focus/hover/locate/fold 失效都走这套)。
 *  - 从未存在(agent 打错号):提示检查 ref 号,不走自愈(别误导成"页面刷新")。
 *  - 失效但找到存活祖先:打印最近存活容器 + 局部 tree,提示用新 ref 重试。
 *  - 整链 detached(页面刷新/重建):提示重新 tree。
 * 返回是否已打印(调用方据此跳过自己的正常输出)。
 */
function printRefInvalid(r: any): boolean {
  if (!r?.refInvalid) return false;
  const rec = r.recovered;
  if (rec?.never) {
    console.log(`ref 失效: ${rec.msg}`);
  } else if (rec) {
    console.log(`ref 失效 → 已自动 tree 最近存活容器 [ref=${rec.rootRef}],用里面的新 [ref] 重试:`);
    console.log(rec.lines.join('\n'));
  } else {
    console.log('ref 失效: 整条祖先链均已失效(页面可能已刷新/重建),请重新 tree 拿新 ref');
  }
  return true;
}

/** 操作结果行 + 附唯一 selector(同一行,逗号分隔)。后续对该元素操作优先用此 selector,避免 ref 失效。
 * selector 超长截断(位置链常很长);shadow 内元素不返回 selector,提示用 ref 操作。
 * ref 失效自愈:打印"最近存活容器 + 局部 tree",提示 agent 用里面的新 ref 重试(不打印"已操作")。 */
function printAction(line: string, r: any): void {
  if (printRefInvalid(r)) return;
  if (r?.shadow) {
    console.log(line + ' （该元素在 shadow 内,继续用 --ref 操作)');
  } else {
    const sel = r?.selector;
    const shown = sel ? (sel.length > 80 ? sel.slice(0, 80) + '…' : sel) : '';
    console.log(line + (shown ? ` ，该元素的 selector 为: ${shown}` : ''));
  }
}

/** 打印操作反馈:新增内容 / 文本变化 / tab 变化分块,内容 2 空格缩进。fb 为 null(--no-feedback)时无输出。 */
function printFeedback(fb: any): void {
  if (!fb) return;
  const out: string[] = [];
  if (fb.blocks?.length) {
    out.push('页面变化 · 新增内容:');
    for (const b of fb.blocks) {
      for (const l of b.lines) out.push('  ' + l);
      if (b.count > 1) out.push(`  (重复 ${b.count} 次,已折叠)`);
    }
  }
  if (fb.changes?.length) {
    out.push('页面变化 · 文本变化:');
    for (const c of fb.changes) out.push('  · ' + (c.before ? `${c.before} → ${c.after}` : `"${c.after}"`));
  }
  if (fb.tabs?.opened?.length) {
    out.push('新开 tab:');
    for (const t of fb.tabs.opened) out.push('  · ' + `${t.title || t.url} [${t.id}]`);
  }
  if (fb.tabs?.closed?.length) {
    out.push('关闭 tab:');
    for (const t of fb.tabs.closed) out.push('  · ' + (t.title || t.url));
  }
  if (out.length) console.log(out.join('\n'));
}

/** 日志用目标描述:selector 或 ref=12(↑3 表示爬 3 层父)。 */
const argLabel = (a: string | { ref: number; ancestor?: number }): string =>
  typeof a === 'string' ? a : 'ref=' + a.ref + (a.ancestor ? `↑${a.ancestor}` : '');

feedbackOpt(refOpt(targetCmd('click', '点击元素'))).argument('[selector]', 'selector 或 --ref')
  .action(async (sel: string, opts: any) => { const arg = refOrSel(sel, opts); const r = await api.click(await needTarget(opts.target), arg, feedbackCfg(opts)); printAction(`已点击: ${argLabel(arg)} (${r.tag})`, r); printFeedback(r.feedback); });

feedbackOpt(refOpt(targetCmd('fill', '填输入框并触发 input/change'))).argument('[selector]', 'selector 或 --ref').argument('<value>', '值')
  .action(async (sel: string, val: string, opts: any) => { const arg = refOrSel(sel, opts); const r = await api.fill(await needTarget(opts.target), arg, val, feedbackCfg(opts)); printAction(`已填入: ${argLabel(arg)} ← ${val}`, r); printFeedback(r.feedback); });

feedbackOpt(refOpt(targetCmd('focus', '聚焦元素'))).argument('[selector]', 'selector 或 --ref')
  .action(async (sel: string, opts: any) => { const arg = refOrSel(sel, opts); const r = await api.focus(await needTarget(opts.target), arg, feedbackCfg(opts)); printAction(`已聚焦: ${argLabel(arg)} (${r.tag})`, r); printFeedback(r.feedback); });

targetCmd('get-focus', '查看当前焦点元素在哪')
  .action(async (opts) => { const f = await api.getFocus(await needTarget(opts.target)); if (!f) { console.log('(当前无焦点元素)'); return; } console.log(`焦点在: [${f.tag}] "${f.text || ''}" ${f.id ? '#' + f.id : ''} sel=${f.selector}`); });

feedbackOpt(targetCmd('press-key', '按键/组合键,如 Enter、Ctrl+Shift+A、Tab')).argument('<key>', '按键')
  .action(async (key: string, opts: any) => { const r = await api.pressKey(await needTarget(opts.target), key, feedbackCfg(opts)); console.log(`已按键: ${key}`); printFeedback(r?.feedback); });

feedbackOpt(refOpt(targetCmd('hover', '鼠标移到元素上'))).argument('[selector]', 'selector 或 --ref')
  .action(async (sel: string, opts: any) => { const arg = refOrSel(sel, opts); const r = await api.hover(await needTarget(opts.target), arg, feedbackCfg(opts)); printAction(`已悬停: ${argLabel(arg)}`, r); printFeedback(r?.feedback); });

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
  program.parseAsync(process.argv).catch((err: any) => {
    console.error(`错误: ${err.message}`);
    // 用 exitCode 而非 process.exit(1):强制退出会在 undici fetch 连接残留时触发 libuv 断言崩溃(Windows UV_HANDLE_CLOSING)。
    process.exitCode = 1;
  });
}

export = api;
