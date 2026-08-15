/**
 * cli-guard-order.test.ts — 锁定「防呆拦在第一步」:CLI action 里参数防呆必须先于 needTarget(浏览器探测/启动)。
 *
 * 做法:esbuild 把**真实** src/cdp.ts 打成 CJS,`commander` 保持 external(与测试共享同一个 `program` 单例),
 * `./api`/`./monitor`/`./browser`/`./run-script`/`./recipe-runner` 换成记录调用的桩(桩把每次 api 调用推进
 * globalThis.__cliCalls;`resolve` 即 needTarget 的第一步)。每个用例重新 require bundle 拿干净的单例,
 * `program.exitOverride()` 后用 `parseAsync([...], {from:'user'})` 驱动真实 action。
 * 断言:非法 URL / XPath / Playwright / shadow 链 / `{ref:N}` 字面量 / 非法 info-article ref / 未知按键
 * 都直接抛防呆错误且 **resolve 零调用**(不探测、不启动浏览器、不装 observer);合法 CSS / ref / 按键行为不变。
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const out = join(root, 'tmp', 'cli-guard-order');
const bundle = join(out, 'cdp.cjs');
const require = createRequire(import.meta.url);
type Call = { fn: string; args: unknown[] };
const g = globalThis as typeof globalThis & { __cliCalls?: Call[] };

const STUB_API = `
const RESULT = {
  resolve: { id: 'T1', url: 'http://fake.test/', title: 'fake' },
  click: { ok: true, tag: 'button', selector: '#ok', feedback: null },
  fill: { ok: true, tag: 'input', selector: '#ok', feedback: null },
  focus: { ok: true, tag: 'input', selector: '#ok', feedback: null },
  hover: { ok: true, tag: 'a', selector: '#ok', feedback: null },
  info: { chain: [] },
  article: { lines: [] },
  pressKey: { ok: true, feedback: null },
  view: { lines: ['body [ref=0]'] },
};
const rec = (fn) => async (...args) => { (globalThis.__cliCalls ||= []).push({ fn, args }); return RESULT[fn]; };
export const coreApi = Object.fromEntries(Object.keys(RESULT).map(fn => [fn, rec(fn)]));
`;
const STUB_THROW = (names: string[]) => names.map(n => `export function ${n}(){ throw new Error('测试桩:不得触达 ${n}'); }`).join('\n');

before(async () => {
  mkdirSync(out, { recursive: true });
  const stubs: Record<string, string> = {
    './api': STUB_API,
    './monitor': STUB_THROW(['logs', 'cmdListen']),
    './browser': STUB_THROW(['ensureBrowser', 'killBrowser']),
    './run-script': STUB_THROW(['runScript']),
    './recipe-runner': STUB_THROW(['runRecipe']),
  };
  const paths = new Map<string, string>();
  for (const [spec, src] of Object.entries(stubs)) {
    const p = join(out, `stub-${spec.slice(2)}.ts`);
    writeFileSync(p, src);
    paths.set(spec, p);
  }
  await build({
    entryPoints: [join(root, 'src', 'cdp.ts')],
    outfile: bundle,
    bundle: true, format: 'cjs', platform: 'node', target: 'node21', logLevel: 'silent',
    external: ['commander'],
    plugins: [{
      name: 'stub-runtime',
      setup(b) {
        b.onResolve({ filter: /^\.\/(api|monitor|browser|run-script|recipe-runner)$/ }, args => ({ path: paths.get(args.path)! }));
      },
    }],
  });
});

/** 每个用例拿一份干净的 commander 单例 + 重新注册的命令(清 require 缓存后重新 require bundle)。 */
function freshProgram() {
  for (const k of Object.keys(require.cache)) {
    if (k === bundle || k.includes(`${join('node_modules', 'commander')}`)) delete require.cache[k];
  }
  require(bundle);
  const { program } = require('commander');
  // exitOverride 只对之后创建的子命令继承;bundle 已注册的子命令要逐个补,否则 commander 的
  // 用法错误(如多余位置参数)会直接 process.exit 杀掉测试进程。
  const quiet = { writeErr: () => {}, writeOut: () => {} };
  program.exitOverride().configureOutput(quiet);
  for (const c of program.commands) c.exitOverride().configureOutput(quiet);
  return program as { parseAsync(argv: string[], opts: { from: 'user' }): Promise<unknown> };
}

let restoreErr: typeof console.error;
before(() => { restoreErr = console.error; console.error = () => {}; });
after(() => { console.error = restoreErr; });
beforeEach(() => { g.__cliCalls = []; });

const calls = () => g.__cliCalls ?? [];
const resolved = () => calls().filter(c => c.fn === 'resolve').length;

async function run(argv: string[]): Promise<{ err: Error | null }> {
  g.__cliCalls = [];
  try { await freshProgram().parseAsync(argv, { from: 'user' }); return { err: null }; }
  catch (e) { return { err: e as Error }; }
}

const BAD_TARGETS: Array<[string, RegExp]> = [
  ['https://example.com/x', /不是网址/],
  ['//example.com/path', /不是网址/],
  ['//div[@id="x"]', /像是 XPath 写法/],
  ['(//button)[1]', /像是 XPath 写法/],
  ['text=登录', /像是 Playwright 写法/],
  ['div >> span', /像是 Playwright 写法/],
  ['host >>> inner', /shadow 链/],
  ['{ref:80}', /对象字面量字符串/],
];

for (const cmd of ['click', 'focus', 'hover']) {
  test(`${cmd}:非法目标在 needTarget 之前被拒(resolve 零调用),不探测/启动浏览器`, async () => {
    for (const [target, re] of BAD_TARGETS) {
      const { err } = await run([cmd, target]);
      assert.ok(err, `${cmd} ${target} 应抛防呆错误`);
      assert.match(err.message, re, `${cmd} ${target}: ${err.message}`);
      assert.equal(resolved(), 0, `${cmd} ${target}: 不得调用 resolve/needTarget`);
      assert.equal(calls().length, 0, `${cmd} ${target}: 不得触达任何 api`);
    }
  });
}

test('fill:非法目标同样先于 needTarget 被拒', async () => {
  for (const [target, re] of BAD_TARGETS) {
    const { err } = await run(['fill', target, 'value']);
    assert.ok(err); assert.match(err.message, re);
    assert.equal(calls().length, 0, `fill ${target}: 不得触达任何 api`);
  }
});

test('info/article:非法 ref(网址/非数字)先于 needTarget 被拒', async () => {
  for (const cmd of ['info', 'article']) {
    for (const bad of ['https://example.com/q/1', 'abc', '#main']) {
      const { err } = await run([cmd, bad]);
      assert.ok(err, `${cmd} ${bad} 应抛`);
      assert.match(err.message, new RegExp(`${cmd} 的位置参数是 view 输出的 ref 序号`));
      assert.equal(calls().length, 0, `${cmd} ${bad}: 不得触达任何 api`);
    }
  }
});

test('view:位置参数网址/非数字先于 needTarget 被拒(既有行为回归锁定);合法 ref 正常建树', async () => {
  for (const bad of ['https://example.com/x', 'abc']) {
    const { err } = await run(['view', bad]);
    assert.ok(err); assert.match(err.message, /view 的位置参数是 view 输出的 ref 序号/);
    assert.equal(calls().length, 0, `view ${bad}: 不得触达任何 api`);
  }
  const { err } = await run(['view', '5']);
  assert.equal(err, null);
  assert.deepEqual(calls().map(c => c.fn), ['resolve', 'view']);
  assert.equal((calls()[1].args[1] as { ref: number }).ref, 5);
});

test('press-key:未知按键 / 缺主键先于 needTarget 被拒', async () => {
  for (const [bad, re] of [['Foo', /未知按键/], ['Ctrl+', /缺少主键/]] as Array<[string, RegExp]>) {
    const { err } = await run(['press-key', bad]);
    assert.ok(err); assert.match(err.message, re);
    assert.equal(calls().length, 0, `press-key ${bad}: 不得触达任何 api`);
  }
});

test('合法 CSS / ref / 按键:行为不变——先 resolve 一次,再以归一化参数调 api', async () => {
  let r = await run(['click', '#ok']);
  assert.equal(r.err, null);
  assert.deepEqual(calls().map(c => c.fn), ['resolve', 'click']);
  assert.equal(calls()[1].args[1], '#ok');

  r = await run(['click', '12', '--ancestor', '2', '--no-feedback']);
  assert.equal(r.err, null);
  assert.deepEqual(calls().map(c => c.fn), ['resolve', 'click']);
  assert.deepEqual(calls()[1].args[1], { ref: 12, ancestor: 2 });
  assert.deepEqual(calls()[1].args[2], { noFeedback: true, feedbackDelay: 1000 });

  r = await run(['fill', 'input[value="text()"]', 'hi']);
  assert.equal(r.err, null, '属性值里的方言字样是数据,不得误拒');
  assert.deepEqual(calls().map(c => c.fn), ['resolve', 'fill']);
  assert.equal(calls()[1].args[2], 'hi');

  r = await run(['hover', 'a[href*="contains("]']);
  assert.equal(r.err, null);
  assert.deepEqual(calls().map(c => c.fn), ['resolve', 'hover']);

  r = await run(['focus', '/* c */ div']);
  assert.equal(r.err, null, 'CSS 注释打头是合法 CSS');
  assert.deepEqual(calls().map(c => c.fn), ['resolve', 'focus']);

  r = await run(['info', '7', '--ancestor', '1']);
  assert.equal(r.err, null);
  assert.deepEqual(calls().map(c => c.fn), ['resolve', 'info']);
  assert.deepEqual(calls()[1].args.slice(1), [7, 1]);

  r = await run(['article', '3']);
  assert.equal(r.err, null);
  assert.deepEqual(calls().map(c => c.fn), ['resolve', 'article']);
  assert.equal(calls()[1].args[1], 3);

  r = await run(['press-key', 'Ctrl+Shift+A']);
  assert.equal(r.err, null);
  assert.deepEqual(calls().map(c => c.fn), ['resolve', 'pressKey']);
  assert.equal(calls()[1].args[1], 'Ctrl+Shift+A');
});

test('多余位置参数仍被拒(不静默丢弃),且不触达 api', async () => {
  const { err } = await run(['click', '#ok', 'https://example.com']);
  assert.ok(err);
  assert.equal(calls().length, 0);
});
