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
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
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
  // 源码跨文件用 `.ts` 扩展名(便于 strip-types 单测直跑),但 standalone 转译产物是 `.js`;
  // esbuild 不打包时原样保留 require 路径,故产物里 `require('./x.ts')` 需改写成 `./x.js`。
  const nodeEntries = readdirSync(src).filter(f => f.endsWith('.ts') && f !== 'cdp.ts');
  if (nodeEntries.length) {
    console.log(`▶ Node 侧(转译):${nodeEntries.join(', ')} → dist/`);
    await build({
      entryPoints: nodeEntries.map(f => join(src, f)),
      outdir: dist, bundle: false, format: 'cjs', platform: 'node', target: 'node21', sourcemap: false,
    });
    // 改写 standalone 产物里的 .ts 相对 require 为 .js(esbuild 不打包不改路径)。
    for (const f of nodeEntries.map(n => n.replace(/\.ts$/, '.js'))) {
      const p = join(dist, f);
      if (!existsSync(p)) continue;
      writeFileSync(p, readFileSync(p, 'utf8').replace(/require\("(\.[^"]+)\.ts"\)/g, 'require("$1.js")'));
    }
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

  // —— 规则模板不再拷进 dist(dist 变纯代码)。规则是数据,住 skill 根 rules/,由 rules-store.ts seed-once
  //    从 src/rules/ 拷默认 / 迁旧 dist csv。此处不覆盖任何规则文件(修 clobber)。

  console.log('✅ build 完成 → dist/');
}

main().catch(e => { console.error(e); process.exit(1); });
