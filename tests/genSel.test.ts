/**
 * genSel.test.ts — genSel / genXpath 的纯字符串单测(Node 内置 node:test,零依赖)。
 * 两者只依赖 parentElement / children / id / tagName 等普通属性,可用假元素单测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genSel, genXpath } from '../src/inject/lib/genSel.ts';

// Node 无浏览器 CSS.escape,补一个恒等 escape 供 genSel 的 id 分支测试。
(globalThis as any).CSS = { escape: (s: string) => s };

/** 构造假元素:含 parentElement / children / id / getAttribute(模拟真实 DOM 的 id 读取)。 */
function mk(tag: string, parent: any = null, id = '') {
  return {
    tagName: tag, nodeType: 1, id, parentElement: parent, children: [] as any[],
    getAttribute: (n: string) => (n === 'id' && id ? id : null),
  };
}
/** 构造单链假元素(parentElement + children 双向);返回数组,尾部=最深叶。 */
function makeChain(...tags: string[]) {
  const els: any[] = [];
  for (const t of tags) {
    const el = mk(t, els.length ? els[els.length - 1] : null);
    if (els.length) els[els.length - 1].children.push(el);
    els.push(el);
  }
  return els;
}

/* ================= genXpath ================= */

test('genXpath: 无 id 时回退全位置路径,每步 tag+序号', () => {
  const els = makeChain('html', 'body', 'div', 'span');
  assert.equal(genXpath(els[3]), '/html/body[1]/div[1]/span[1]');
});

test('genXpath: 兄弟节点按同名序号编号', () => {
  const els = makeChain('html', 'body');
  const body = els[1];
  const d1 = mk('div', body);
  const d2 = mk('div', body);
  body.children = [d1, d2];
  assert.equal(genXpath(d2), '/html/body[1]/div[2]');
});

test('genXpath: null / 无父的 html 根', () => {
  assert.equal(genXpath(null), '');
  const html = mk('html');
  assert.equal(genXpath(html), '/html');
});

test('genXpath: 就近 id 锚定,不再拼上方位置链', () => {
  const ans = mk('div', null, 'QuestionAnswers-answers');
  const inner = mk('div', ans);
  const leaf = mk('span', inner);
  ans.children.push(inner); inner.children.push(leaf);
  assert.equal(genXpath(leaf), '//*[@id="QuestionAnswers-answers"]/div[1]/span[1]');
});

test('genXpath: 元素自身有 id 直接锚定', () => {
  const el = mk('div', null, 'box');
  assert.equal(genXpath(el), '//*[@id="box"]');
});

/* ================= genSel ================= */

test('genSel: 有 id 优先', () => {
  const el = mk('div', null, 'box');
  assert.equal(genSel(el), '#box');
});

test('genSel: 无 id 用 tag:nth-of-type 路径', () => {
  const html = mk('html');
  const body = mk('body', html);
  html.children.push(body);
  const d1 = mk('div', body);
  const d2 = mk('div', body);
  body.children = [d1, d2];
  // body 下两个 div → d2 为 div:nth-of-type(2);body 是 html 唯一子、不带序号
  assert.equal(genSel(d2), 'html > body > div:nth-of-type(2)');
});
