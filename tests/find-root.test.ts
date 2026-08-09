/**
 * find-root.test.ts — findRoot / refElement / climbAncestors 单测(Node 内置 node:test,零依赖)。
 * 依赖 document.querySelector / 元素 .shadowRoot,可用假对象单测。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { findRoot, refElement, climbAncestors } from '../src/inject/lib/find-root.ts';

// ---- 全局 stub:document.querySelector(各测试填 uniqueSel) ----
const uniqueSel = new Map<string, any>();
function stubDocument() {
  (globalThis as any).document = {
    querySelector: (sel: string) => uniqueSel.get(sel) ?? null,
    get body() { return uniqueSel.get('body'); },
  };
}
beforeEach(() => { uniqueSel.clear(); stubDocument(); });

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

// ---- findRoot:普通 selector + shadow 链 >>> 穿透 ----

test('findRoot: 无 selector 返回 body', () => {
  const body = { tag: 'body' };
  uniqueSel.set('body', body);
  assert.equal(findRoot(undefined), body);
  assert.equal(findRoot(''), body);
});

test('findRoot: 普通 selector 走 document.querySelector', () => {
  const el = { tag: 'main' };
  uniqueSel.set('#main', el);
  assert.equal(findRoot('#main'), el);
  assert.equal(findRoot('.miss'), null);
});

/** 造假 shadowRoot:含独立 querySelector 表。 */
function mkShadow(queryMap: Record<string, any>) {
  return { querySelector: (sel: string) => queryMap[sel] ?? null };
}

test('findRoot: shadow 链 a >>> b 逐段穿透 shadowRoot', () => {
  const inner = { tag: 'a' };
  const host = { tag: 'div', shadowRoot: mkShadow({ 'a': inner }) };
  uniqueSel.set('div', host);
  // 'div >>> a' → document.querySelector('div') → host.shadowRoot.querySelector('a') → inner
  assert.equal(findRoot('div >>> a'), inner);
});

test('findRoot: 多层 shadow 链 a >>> b >>> c', () => {
  const deepest = { tag: 'span' };
  const midShadow = mkShadow({ 'span': deepest });
  const midHost = { tag: 'section', shadowRoot: midShadow };
  const topShadow = mkShadow({ 'section': midHost });
  const topHost = { tag: 'div', shadowRoot: topShadow };
  uniqueSel.set('div', topHost);
  assert.equal(findRoot('div >>> section >>> span'), deepest);
});

test('findRoot: shadow 链第一段在 document 未命中 → null', () => {
  const host = { tag: 'div', shadowRoot: mkShadow({ 'a': {} }) };
  uniqueSel.set('div', host);
  assert.equal(findRoot('.miss >>> a'), null);
});

test('findRoot: 中段元素无 shadowRoot → null', () => {
  // host 命中但没有 shadowRoot(普通元素),第二段无法穿透
  const host = { tag: 'div' }; // 无 shadowRoot
  uniqueSel.set('div', host);
  assert.equal(findRoot('div >>> a'), null);
});

test('findRoot: shadow 内最后一段未命中 → null', () => {
  const host = { tag: 'div', shadowRoot: mkShadow({}) };
  uniqueSel.set('div', host);
  assert.equal(findRoot('div >>> .miss'), null);
});

test('findRoot: >>> 周围带空白会被 trim', () => {
  const inner = { tag: 'a' };
  const host = { tag: 'div', shadowRoot: mkShadow({ 'a': inner }) };
  uniqueSel.set('div', host);
  assert.equal(findRoot('div  >>>  a'), inner);
});
