/**
 * prune.ts — 会话级排除区域集合单测。registerPrune/clearPrune/listPrune 只依赖
 * __cdpRefs(全局数组)与元素对象属性,用假对象即可单测(与 find-root.test.ts 同手法)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerPrune, clearPrune, listPrune, pruneSet } from '../src/inject/lib/prune.ts';

function makeEl(tag: string, text?: string) {
  return { tagName: tag, nodeType: 1, textContent: text || '', parentElement: null, children: [] as any[] };
}

test('registerPrune: 按 ref 登记元素入 __cdpPrune', () => {
  const a = makeEl('div', '头部导航'), b = makeEl('section', '推荐卡片');
  (globalThis as any).__cdpRefs = [a, b];
  const r = registerPrune([0, 1]);
  assert.equal(r.skipped, 0);
  assert.equal(r.pruned.length, 2);
  assert.equal(r.pruned[0].el, a);
  assert.equal(r.pruned[1].el, b);
  assert.equal(r.pruned[0].summary, '头部导航');
  assert.equal(pruneSet()!.size, 2);
  (globalThis as any).__cdpPrune = undefined;
});

test('registerPrune: 无效 ref 跳过并计数', () => {
  (globalThis as any).__cdpRefs = [makeEl('div')];
  const r = registerPrune([0, 5, -1]);
  assert.equal(r.pruned.length, 1);
  assert.equal(r.skipped, 2);
  (globalThis as any).__cdpPrune = undefined;
});

test('registerPrune: 重复登记去重(Set)', () => {
  const a = makeEl('div', 'x');
  (globalThis as any).__cdpRefs = [a];
  registerPrune([0]); registerPrune([0]);
  assert.equal(pruneSet()!.size, 1);
  (globalThis as any).__cdpPrune = undefined;
});

test('registerPrune: ancestor 爬父到容器再登记', () => {
  const [header, nav, link] = [makeEl('header', ''), makeEl('nav', ''), makeEl('a', '关注')];
  header.children.push(nav); nav.children.push(link); link.parentElement = nav; nav.parentElement = header;
  (globalThis as any).__cdpRefs = [link];
  const r = registerPrune([0], 1);   // 爬 1 级 → nav
  assert.equal(r.skipped, 0);
  assert.equal(r.pruned[0].el, nav); // 登记的是 nav 而非叶子 link
  assert.equal(pruneSet()!.has(header), false);
  (globalThis as any).__cdpPrune = undefined;
});

test('clearPrune: 清空集合', () => {
  (globalThis as any).__cdpRefs = [makeEl('div', 'x')];
  registerPrune([0]);
  clearPrune();
  assert.equal(pruneSet()!.size, 0);
});

test('listPrune: 未登记返回空数组;登记后返回摘要', () => {
  clearPrune();
  assert.deepEqual(listPrune(), []);
  const a = makeEl('header', '导航栏');
  (globalThis as any).__cdpRefs = [a];
  registerPrune([0]);
  const l = listPrune();
  assert.equal(l.length, 1);
  assert.equal(l[0].summary, '导航栏');
  (globalThis as any).__cdpPrune = undefined;
});
