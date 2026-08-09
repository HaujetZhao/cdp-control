/**
 * find-root.test.ts — refElement / climbAncestors 单测(Node 内置 node:test,零依赖)。
 * 两者只依赖 __cdpRefs(全局数组)与 parentElement(普通属性),可用假对象单测。
 * xpath 已退役(findRoot 仅 selector),不再有 normalize/split 逻辑可测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refElement, climbAncestors } from '../src/inject/lib/find-root.ts';

/** 构造含 parentElement/children 的假元素链。 */
function makeChain(...tags: string[]) {
  const els: any[] = [];
  for (const t of tags) {
    const el = { tagName: t, nodeType: 1, parentElement: null as any, children: [] as any[] };
    if (els.length) { el.parentElement = els[els.length - 1]; els[els.length - 1].children.push(el); }
    els.push(el);
  }
  return els; // [0]=最上层根 ... [n-1]=最深层叶
}

test('refElement: 按序号取真实元素', () => {
  const [a, mid, leaf] = makeChain('div', 'div', 'span');
  (globalThis as any).__cdpRefs = [a, mid, leaf];
  assert.equal(refElement(0), a);
  assert.equal(refElement(2), leaf);
  assert.equal(refElement(3), null);      // 越界
  assert.equal(refElement(-1), null);
});

test('refElement: 非元素节点(如文本节点)不入 ref,返回 null', () => {
  (globalThis as any).__cdpRefs = [{ nodeType: 3, textContent: 'x' }];
  assert.equal(refElement(0), null);
  (globalThis as any).__cdpRefs = undefined;
  assert.equal(refElement(0), null);
});

test('climbAncestors: 不爬返回自身;按层爬父;遇根停', () => {
  const [a, b, c, leaf] = makeChain('div', 'div', 'div', 'span');
  assert.equal(climbAncestors(leaf, 0), leaf);
  assert.equal(climbAncestors(leaf, 1), c);
  assert.equal(climbAncestors(leaf, 3), a);
  assert.equal(climbAncestors(leaf, 99), a); // 超过根停在最上层
  assert.equal(climbAncestors(null, 2), null);
});
