/**
 * refs-table.ts — __cdpRefs 只追加不回收的容量/复杂度压测(`npm run bench:refs` = node --expose-gc --experimental-strip-types bench/refs-table.ts)。
 * 度量:① 每槽常驻字节(元素已释放 vs 仍存活);② registerRef/classifyRef/refElement/recoverRef/
 * nearestRegisteredAncestor 在 1e3..1e6 槽位时的单次耗时是否与表大小无关;③ 一次性 ensureRefIndex 回填成本。
 * 注意 V8 KeepDuringJob:同一 job 内 new WeakRef / deref 过的目标保活到 job 结束,故每个阶段之间
 * await 一个宏任务(浏览器里每次 Runtime.evaluate 本就是独立 job),GC 才能真正回收元素。
 */
import { performance } from 'node:perf_hooks';
import { classifyRef, entryEl, nearestRegisteredAncestor, refElement, registerRef, type RefEntry } from '../src/inject/lib/find-root.ts';
import { recoverRef } from '../src/inject/lib/find.ts';

class FakeElement {
  readonly nodeType = 1;
  readonly tagName = 'DIV';
  readonly children: FakeElement[] = [];
  readonly childNodes: FakeElement[] = [];
  readonly shadowRoot = null;
  parentElement: FakeElement | null = null;
  isConnected = true;
  getAttribute(): null { return null; }
  hasAttribute(): boolean { return false; }
  matches(): boolean { return false; }
  getRootNode(): FakeElement { return this; }
  getBoundingClientRect() { return { width: 100, height: 20, top: 0, bottom: 20, left: 0, right: 100 }; }
}
Object.defineProperty(globalThis, 'Element', { configurable: true, value: FakeElement });
Object.defineProperty(globalThis, 'ShadowRoot', { configurable: true, value: class FakeShadowRoot {} });
Object.defineProperty(globalThis, 'innerHeight', { configurable: true, value: 800 });
Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 1200 });

type G = typeof globalThis & { __cdpRefs?: RefEntry[]; __cdpRefIndex?: WeakMap<Element, number>; gc?: () => void };
const g = globalThis as G;
if (!g.gc) { console.error('需要 --expose-gc'); process.exit(1); }
const tick = () => new Promise<void>(r => setTimeout(r, 0));
const heap = async () => { await tick(); for (let i = 0; i < 3; i++) { g.gc!(); await tick(); } return process.memoryUsage().heapUsed; };
const DEPTH = 30; // 每 30 个元素一条父链(模拟 DOM 深度 30 的子树),链根 isConnected 保持 true
const fmt = (n: number) => n.toLocaleString('en-US');
const us = (ms: number, ops: number) => `${((ms * 1000) / ops).toFixed(3)} µs/op`;
const reset = () => { delete g.__cdpRefs; delete g.__cdpRefIndex; };

for (const N of [1_000, 10_000, 100_000, 1_000_000]) {
  reset();
  const base = await heap();
  let els: FakeElement[] | null = new Array(N);
  // ① 追加 N 个新元素(显式 parentRef,和 buildView 遍二一致)
  let t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const e = new FakeElement();
    if (i % DEPTH !== 0) { e.parentElement = els[i - 1]; els[i - 1].children.push(e); }
    els[i] = e;
    registerRef(e as unknown as Element, i % DEPTH === 0 ? null : i - 1);
  }
  const tReg = performance.now() - t0;
  const heapLive = (await heap()) - base;

  // ② 表大小为 N 时的单次操作耗时(随机 ref;各 1e5 次)
  const OPS = 100_000;
  const rnd = () => (Math.random() * N) | 0;
  t0 = performance.now(); for (let i = 0; i < OPS; i++) classifyRef(rnd()); const tCls = performance.now() - t0;
  t0 = performance.now(); for (let i = 0; i < OPS; i++) refElement(rnd()); const tRefEl = performance.now() - t0;
  t0 = performance.now(); for (let i = 0; i < OPS; i++) { const k = rnd(); registerRef(els[k] as unknown as Element, k % DEPTH === 0 ? null : k - 1); } const tReReg = performance.now() - t0;
  // 省略 parentRef:O(深度) 的 DOM 上爬(链尾元素深 29 层)
  t0 = performance.now(); for (let i = 0; i < OPS; i++) { const k = (rnd() / DEPTH | 0) * DEPTH + DEPTH - 1; if (k < N) nearestRegisteredAncestor(els[k] as unknown as Element); } const tNear = performance.now() - t0;
  // recoverRef:把每条链除根外全部 detach,从链尾自愈 → 走 29 跳到链根再 buildView(根无 kids,极小)
  for (let i = 0; i < N; i++) if (i % DEPTH !== 0) els[i].isConnected = false;
  const RO = 10_000;
  t0 = performance.now(); let ok = 0; for (let i = 0; i < RO; i++) { const k = (rnd() / DEPTH | 0) * DEPTH + DEPTH - 1; if (k < N) { const r = recoverRef(k); if (r && 'rootRef' in r) ok++; } } const tRec = performance.now() - t0;

  // ③ 释放全部元素强引用 → 跨 job GC → 表里只剩 WeakRef 壳:每槽常驻字节
  els = null;
  const heapDead = (await heap()) - base;
  const refs = g.__cdpRefs!;
  let dead = 0; for (let i = 0; i < refs.length; i++) if (!entryEl(refs[i])) dead++;
  // 元素全死后再随机 refElement/classifyRef(死槽读路径)
  t0 = performance.now(); for (let i = 0; i < OPS; i++) refElement(rnd()); const tDeadRead = performance.now() - t0;

  // ④ 一次性 ensureRefIndex 回填(删掉索引后首次 registerRef 触发)——只在旧表首次接触时发生
  delete g.__cdpRefIndex;
  const probe = new FakeElement();
  t0 = performance.now(); registerRef(probe as unknown as Element, null); const tIdx = performance.now() - t0;

  console.log(`N=${fmt(N)} 槽`);
  console.log(`  追加 ${fmt(N)} 次 registerRef: ${tReg.toFixed(1)} ms (${us(tReg, N)})`);
  console.log(`  常驻: 元素存活 ${fmt(heapLive)} B (${(heapLive / N).toFixed(0)} B/槽,含假元素本身) | 元素释放后 ${fmt(heapDead)} B (${(heapDead / N).toFixed(0)} B/槽; WeakRef 已释放 ${fmt(dead)}/${fmt(N)})`);
  console.log(`  classifyRef ${us(tCls, OPS)} | refElement ${us(tRefEl, OPS)} | 死槽 refElement ${us(tDeadRead, OPS)} | registerRef(复用) ${us(tReReg, OPS)} | nearestRegisteredAncestor(深 29) ${us(tNear, OPS)} | recoverRef(29 跳) ${us(tRec, RO)} (成功 ${ok}/${RO})`);
  console.log(`  ensureRefIndex 一次性回填 ${fmt(N)} 槽: ${tIdx.toFixed(1)} ms`);
}
