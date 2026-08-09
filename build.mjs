/**
 * build.mjs — 编译 cdp 项目到 dist/ 再运行。
 *
 * 两个世界:
 *   1. Node 侧:src/*.ts → dist/*.js(esbuild 转译 CJS,不打包,保留文件边界与相对 require)。
 *   2. 注入页侧:src/inject/<入口>.ts → dist/inject/<入口>.js(esbuild bundle 成自包含 IIFE,
 *      每个入口一行(共享模块放 src/inject/lib/,被打进各入口)。
 *
 * 注入返回值契约:页面 JS 把结果写到 globalThis.__cdpResult,footer 追加一行"读取+删除+返回",
 * 使 Runtime.evaluate 的 returnByValue 拿到整体完成值(esbuild 的 module wrapper 会吞掉入口 IIFE 的返回值)。
 */
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const src = join(__dirname, 'src');
const dist = join(__dirname, 'dist');

// 注入脚本统一的返回值 footer(读全局 + 删除 + 返回)。
// async:支持入口把 __cdpResult 设成 promise(如 view --scroll-to-load 先异步滚动再建树),
// footer await 后返回解析值;同步入口 __cdpResult 是普通值,await 原样通过。awaitPromise 生效。
const RESULT_FOOTER = `;(async () => { const r = await globalThis.__cdpResult; delete globalThis.__cdpResult; return r; })()`;

async function main() {
  console.log('🔍 tsc --noEmit (类型检查)…');
  execSync('npx tsc --noEmit', { stdio: 'inherit', cwd: __dirname });

  // —— Node 侧:转译 CJS,不打包 ——
  const nodeEntries = readdirSync(src).filter(f => f.endsWith('.ts') && f !== 'cdp.ts');
  if (nodeEntries.length) {
    console.log(`▶ Node 侧(转译):${nodeEntries.join(', ')} → dist/`);
    await build({
      entryPoints: nodeEntries.map(f => join(src, f)),
      outdir: dist, bundle: false, format: 'cjs', platform: 'node', target: 'node21', sourcemap: false,
    });
  }
  console.log('▶ Node 侧(入口 bundle): cdp.ts → dist/cdp.js');
  await build({
    entryPoints: [join(src, 'cdp.ts')],
    outfile: join(dist, 'cdp.js'),
    bundle: true, format: 'cjs', platform: 'node', target: 'node21', sourcemap: false,
    external: ['node:fs', 'node:path'],
    logLevel: 'info',
  });

  // —— 注入页侧:每个顶层入口 bundle 成 IIFE ——
  const injectDir = join(src, 'inject');
  const injectEntries = readdirSync(injectDir).filter(f => f.endsWith('.ts'));
  if (injectEntries.length) {
    console.log(`▶ 注入页侧:${injectEntries.join(', ')} → dist/inject/`);
    await build({
      entryPoints: injectEntries.map(f => join(injectDir, f)),
      outdir: join(dist, 'inject'),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
      write: true,
      footer: { js: RESULT_FOOTER },
      logLevel: 'info',
    });
  } else {
    console.log('▶ 注入页侧:(暂无 src/inject/*.ts,跳过)');
  }

  // —— 拷贝 fold 规则模板(src/folds.csv → dist/folds.csv)——
  // 每次构建都强制覆盖:src/folds.csv 是唯一权威副本,dist 只是产物。
  const foldTpl = join(src, 'folds.csv');
  const foldOut = join(dist, 'folds.csv');
  if (existsSync(foldTpl)) {
    copyFileSync(foldTpl, foldOut);
    console.log('▶ fold 规则模板 → dist/folds.csv(覆盖)');
  }

  console.log('✅ build 完成 → dist/');
}

main().catch(e => { console.error(e); process.exit(1); });
