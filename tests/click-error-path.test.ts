/**
 * click-error-path.test.ts — 端到端锁定 click 的错误语义:注入侧 {ok:false, err}(遮挡/零尺寸/selector 未命中)
 * 必须原样成为 api.click 抛出的错误信息,而不是被坐标守卫吞成"点击坐标缺失";refInvalid 透传不 dispatch;
 * 成功路径按 moved→pressed→released 派发三段 Input.dispatchMouseEvent;--dom 不派发。
 *
 * 做法:用 esbuild 把**真实** src/api.ts 依赖图打成 CJS(仅把 ./browser、./monitor 换成"到达即抛"的桩,
 * 保证测试绝不拉起浏览器/守护进程),注入脚本也用真实 src/inject/*.ts 打包(inject-loader 按 __dirname/inject 读),
 * 唯一伪造的是 CDP 端点(tests/helpers/fake-cdp.ts):对 Runtime.evaluate 回放 inject/click.ts 各分支的字面结果。
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalValue, startFakeCdp, type FakeCdp } from './helpers/fake-cdp.ts';

const root = join(import.meta.dirname, '..');
const out = join(root, 'tmp', 'click-error-path');
const RESULT_FOOTER = `;(async () => { const r = await globalThis.__cdpResult; delete globalThis.__cdpResult; return r; })()`;

/** 注入侧 click.ts 各分支的字面结果(与 src/inject/click.ts 一一对应),按 selector 回放。 */
const CLICK_RESULTS: Record<string, unknown> = {
  '#occluded': { ok: false, err: '被 <div.mask> 遮挡' },
  '#zero': { ok: false, err: '元素不可见/无尺寸' },
  '#missing': { ok: false, err: '未找到: #missing' },
  '#ok': { ok: true, x: 12, y: 34, tag: 'button', shadow: false, selector: '#ok' },
  '#dom': { ok: true, tag: 'button', shadow: false, selector: '#dom' },
  '#nocoords': { ok: true, tag: 'button', shadow: false, selector: '#nocoords' },
};
const DEAD_REF = 7;

let fake: FakeCdp;
let api: any;
const mouseEvents = () => fake.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
const evalCount = (needle: string) => fake.calls.filter(c => c.method === 'Runtime.evaluate' && String(c.params.expression).includes(needle)).length;

before(async () => {
  mkdirSync(join(out, 'inject'), { recursive: true });
  const stubBrowser = join(out, 'stub-browser.ts');
  const stubMonitor = join(out, 'stub-monitor.ts');
  writeFileSync(stubBrowser, `export async function ensureBrowser(){ throw new Error('测试桩:click 路径不得触达 ensureBrowser'); }\nexport async function killBrowser(){ throw new Error('测试桩'); }\n`);
  writeFileSync(stubMonitor, `export async function maybeSpawnDaemon(){ throw new Error('测试桩:不得拉起 daemon'); }\nexport function injectMonitor(){ throw new Error('测试桩'); }\n`);
  await build({
    entryPoints: [join(root, 'src', 'api.ts')],
    outfile: join(out, 'api.cjs'),
    bundle: true, format: 'cjs', platform: 'node', target: 'node21', logLevel: 'silent',
    plugins: [{
      name: 'stub-browser-monitor',
      setup(b) {
        b.onResolve({ filter: /^\.\/browser$/ }, () => ({ path: stubBrowser }));
        b.onResolve({ filter: /^\.\/monitor$/ }, () => ({ path: stubMonitor }));
      },
    }],
  });
  const injectDir = join(root, 'src', 'inject');
  await build({
    entryPoints: readdirSync(injectDir).filter(f => f.endsWith('.ts')).map(f => join(injectDir, f)),
    outdir: join(out, 'inject'),
    bundle: true, format: 'iife', platform: 'browser', target: 'es2020', footer: { js: RESULT_FOOTER }, logLevel: 'silent',
  });

  fake = await startFakeCdp((method, params) => {
    if (method === 'Runtime.evaluate') {
      const expr = String(params.expression);
      if (!expr.startsWith('var __CDP_ARG__ = ')) return evalValue({ ok: true, blocks: [], changes: [], reloaded: false }); // feedback-start/collect
      const arg = JSON.parse(expr.slice('var __CDP_ARG__ = '.length, expr.indexOf(';\n')));
      if (arg.ref === DEAD_REF) return evalValue({ ok: false, refInvalid: true, recovered: null });
      if (arg.sel in CLICK_RESULTS) return evalValue(CLICK_RESULTS[arg.sel]);
      throw new Error(`fake-cdp: 未预期的 click 参数 ${JSON.stringify(arg)}`);
    }
    return {};
  });
  process.env.CDP_PORT = String(fake.port);
  api = createRequire(import.meta.url)(join(out, 'api.cjs'));
});

after(async () => { await fake.close(); });

test('遮挡:注入 err 原样抛出,不派发鼠标事件(noFeedback 与默认反馈路径都一样)', async () => {
  fake.calls.length = 0;
  await assert.rejects(api.click(fake.target, '#occluded', { noFeedback: true }), { message: '被 <div.mask> 遮挡' });
  assert.equal(mouseEvents().length, 0);

  fake.calls.length = 0;
  await assert.rejects(api.click(fake.target, '#occluded'), { message: '被 <div.mask> 遮挡' });
  assert.equal(mouseEvents().length, 0);
  assert.equal(evalCount('__cdpFeedback'), 2, '反馈路径:动作抛错后仍 collect 断开 observer,再原样重抛');
});

test('零尺寸/视口外与 selector 未命中:各自的注入 err 原样抛出', async () => {
  fake.calls.length = 0;
  await assert.rejects(api.click(fake.target, '#zero', { noFeedback: true }), { message: '元素不可见/无尺寸' });
  await assert.rejects(api.click(fake.target, '#missing', { noFeedback: true }), { message: '未找到: #missing' });
  assert.equal(mouseEvents().length, 0);
});

test('ref 失效:refInvalid 结果透传给调用方,不抛、不派发', async () => {
  fake.calls.length = 0;
  const r = await api.click(fake.target, { ref: DEAD_REF }, { noFeedback: true });
  assert.equal(r.refInvalid, true);
  assert.equal(r.recovered, null);
  assert.equal(mouseEvents().length, 0);
});

test('成功:同一连接按 moved→pressed→released 派发到注入返回的坐标,回显 selector', async () => {
  fake.calls.length = 0;
  const r = await api.click(fake.target, '#ok', { noFeedback: true });
  assert.equal(r.selector, '#ok');
  assert.equal(r.tag, 'button');
  const ev = mouseEvents().map(c => c.params);
  assert.deepEqual(ev.map(p => p.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(ev.every(p => p.x === 12 && p.y === 34));
  assert.equal(ev[1].button, 'left');
  assert.equal(ev[1].clickCount, 1);
});

test('--dom:注入侧已 el.click(),Node 侧不派发坐标事件也不要求坐标', async () => {
  fake.calls.length = 0;
  const r = await api.click(fake.target, '#dom', { noFeedback: true, dom: true });
  assert.equal(r.selector, '#dom');
  assert.equal(mouseEvents().length, 0);
});

test('契约守卫:只有注入返回 ok 却缺坐标(不可能来自 {ok:false} 分支)才是"点击坐标缺失"', async () => {
  fake.calls.length = 0;
  await assert.rejects(api.click(fake.target, '#nocoords', { noFeedback: true }), { message: '点击坐标缺失' });
  assert.equal(mouseEvents().length, 0);
});
