/**
 * stash.ts — 会话级暂存区域集合单测。stash/stashList/stashPop/stashClear/stashSet 只依赖
 * __cdpRefs(全局数组)与元素对象属性,用假对象即可单测(与 find-root.test.ts 同手法)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stash, stashList, stashPop, stashClear, stashSet } from '../src/inject/lib/stash.ts';

function makeEl(tag: string, text?: string) {
  return { tagName: tag, nodeType: 1, textContent: text || '', parentElement: null, children: [] as any[] };
}

test('stash: 按 ref 暂存元素入 __cdpStash', () => {
  const a = makeEl('div', '头部导航'), b = makeEl('section', '推荐卡片');
  (globalThis as any).__cdpRefs = [a, b];
  const r = stash([0, 1]);
  assert.equal(r.skipped, 0);
  assert.equal(r.stashed.length, 2);
  assert.equal(r.stashed[0].el, a);
  assert.equal(r.stashed[1].el, b);
  assert.equal(r.stashed[0].summary, '头部导航');
  assert.equal(stashSet()!.length, 2);
  (globalThis as any).__cdpStash = undefined;
});

test('stash: 无效 ref 跳过并计数', () => {
  (globalThis as any).__cdpRefs = [makeEl('div')];
  const r = stash([0, 5, -1]);
  assert.equal(r.stashed.length, 1);
  assert.equal(r.skipped, 2);
  (globalThis as any).__cdpStash = undefined;
});

test('stash: 重复暂存去重', () => {
  const a = makeEl('div', 'x');
  (globalThis as any).__cdpRefs = [a];
  stash([0]); stash([0]);
  assert.equal(stashSet()!.length, 1);
  (globalThis as any).__cdpStash = undefined;
});

test('stash: ancestor 爬父到容器再暂存', () => {
  const [header, nav, link] = [makeEl('header', ''), makeEl('nav', ''), makeEl('a', '关注')];
  header.children.push(nav); nav.children.push(link); link.parentElement = nav; nav.parentElement = header;
  (globalThis as any).__cdpRefs = [link];
  const r = stash([0], 1);   // 爬 1 级 → nav
  assert.equal(r.skipped, 0);
  assert.equal(r.stashed[0].el, nav); // 暂存的是 nav 而非叶子 link
  assert.equal(stashSet()!.includes(header), false);
  (globalThis as any).__cdpStash = undefined;
});

test('stashPop: 默认恢复最新一个并移除(可逆)', () => {
  const a = makeEl('header', '导航'), b = makeEl('section', '广告');
  (globalThis as any).__cdpRefs = [a, b];
  stash([0]); stash([1]);
  const popped = stashPop();   // 默认最新 → b(广告)
  assert.equal(popped!.el, b);
  assert.equal(stashSet()!.length, 1);
  assert.equal(stashSet()![0], a);
  (globalThis as any).__cdpStash = undefined;
});

test('stashPop: 按索引恢复指定区域;越界返回 null', () => {
  const a = makeEl('header', '导航'), b = makeEl('section', '广告');
  (globalThis as any).__cdpRefs = [a, b];
  stash([0]); stash([1]);
  assert.equal(stashPop(0)!.el, a);        // 列表下标 0 → a
  assert.equal(stashPop(5), null);         // 越界
  (globalThis as any).__cdpStash = undefined;
});

test('stashClear: 清空集合', () => {
  (globalThis as any).__cdpRefs = [makeEl('div', 'x')];
  stash([0]);
  stashClear();
  assert.equal(stashSet()!.length, 0);
});

test('stashList: 未暂存返回空数组;暂存后返回摘要', () => {
  stashClear();
  assert.deepEqual(stashList(), []);
  const a = makeEl('header', '导航栏');
  (globalThis as any).__cdpRefs = [a];
  stash([0]);
  const l = stashList();
  assert.equal(l.length, 1);
  assert.equal(l[0].summary, '导航栏');
  (globalThis as any).__cdpStash = undefined;
});
