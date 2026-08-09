/**
 * genSel.test.ts — genSel 的纯字符串单测(Node 内置 node:test,零依赖)。
 * 只依赖 parentElement / children / id / tagName 等普通属性,可用假元素单测。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { genSel } from '../src/inject/lib/genSel.ts';

// Node 无浏览器 CSS.escape,补一个恒等 escape 供 genSel 的 id 分支测试。
(globalThis as any).CSS = { escape: (s: string) => s };

/** 构造假元素:含 parentElement / children / id / getAttribute(模拟真实 DOM 的 id 读取)。 */
function mk(tag: string, parent: any = null, id = '') {
  return {
    tagName: tag, nodeType: 1, id, parentElement: parent, children: [] as any[],
    getAttribute: (n: string) => (n === 'id' && id ? id : null),
  };
}

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
