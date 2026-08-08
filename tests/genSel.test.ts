/**
 * genSel.test.ts — genSel / genXpath 的纯字符串单测(Node 内置 node:test,零依赖)。
 * 两者只依赖 parentElement / children / id / tagName 等普通属性,可用假元素单测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genSel, genXpath } from '../src/inject/lib/genSel.ts';

// Node 无浏览器 CSS.escape,补一个恒等 escape 供 genSel 的 id 分支测试。
(globalThis as any).CSS = { escape: (s: string) => s };

/** 构造含 parentElement/children 的假元素链;返回数组(尾部=最深叶)。 */
function makeChain(...tags: string[]) {
  const els: any[] = [];
  for (const t of tags) {
    const el = { tagName: t, nodeType: 1, id: '', parentElement: null as any, children: [] as any[] };
    if (els.length) { el.parentElement = els[els.length - 1]; els[els.length - 1].children.push(el); }
    els.push(el);
  }
  return els;
}

test('genXpath: 单链绝对路径,每步 tag+序号', () => {
  const els = makeChain('html', 'body', 'div', 'span');
  assert.equal(genXpath(els[3]), '/html/body[1]/div[1]/span[1]');
});

test('genXpath: 兄弟节点按位置编号', () => {
  const html = makeChain('html', 'body');
  const body = html[1];
  const d1 = { tagName: 'div', nodeType: 1, parentElement: body, children: [], id: '' };
  const d2 = { tagName: 'div', nodeType: 1, parentElement: body, children: [], id: '' };
  body.children = [d1, d2];
  assert.equal(genXpath(d2), '/html/body[1]/div[2]');
});

test('genXpath: null / 无父的 html 根', () => {
  assert.equal(genXpath(null), '');
  const html = { tagName: 'html', nodeType: 1, parentElement: null, children: [], id: '' };
  assert.equal(genXpath(html), '/html');
});

test('genSel: 有 id 优先', () => {
  const el = { tagName: 'div', nodeType: 1, id: 'box', parentElement: null, children: [] };
  assert.equal(genSel(el), '#box');
});

test('genSel: 无 id 用 tag:nth-of-type 路径', () => {
  const html = { tagName: 'html', nodeType: 1, id: '', parentElement: null, children: [] as any[] };
  const body = { tagName: 'body', nodeType: 1, id: '', parentElement: html, children: [] as any[] };
  html.children.push(body);
  const d1 = { tagName: 'div', nodeType: 1, id: '', parentElement: body, children: [] as any[] };
  const d2 = { tagName: 'div', nodeType: 1, id: '', parentElement: body, children: [] as any[] };
  body.children = [d1, d2];
  // body 下两个 div → d2 为 div:nth-of-type(2);body 是 html 唯一子、不带序号
  assert.equal(genSel(d2), 'html > body > div:nth-of-type(2)');
});
