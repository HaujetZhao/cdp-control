/**
 * view-utils.test.ts — 结构树纯函数的单元测试(Node 内置 node:test,零依赖)。
 * 覆盖 inlineLen / inlineable / leafText / firstTxt / isTrivialLeaf 的语义,锁定重构前行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineLen, inlineable, leafText, firstTxt, isTrivialLeaf } from '../src/inject/lib/view-utils.ts';

// —— inlineLen ——
test('inlineLen: 自身文本长度', () => {
  assert.equal(inlineLen({ text: 'abcde', kids: [] }), 5);
});

test('inlineLen: imgAlt 计为 2', () => {
  assert.equal(inlineLen({ imgAlt: '封面', kids: [] }), 2);
});

test('inlineLen: title 自含项 = leafValue + 后代首个文本', () => {
  const n = { leafValue: '点赞（Q）', kids: [{ text: '22.9万', kids: [] }] };
  assert.equal(inlineLen(n), '点赞（Q）'.length + '22.9万'.length);
});

test('inlineLen: 递归求和并提前停(超 24 不继续累加)', () => {
  // 第一个子就 >24,提前停
  const n = { kids: [{ text: 'x'.repeat(30), kids: [] }, { text: 'y', kids: [] }] };
  assert.ok(inlineLen(n) > 24);
});

// —— inlineable ——
test('inlineable: 短文本内联', () => {
  assert.ok(inlineable({ text: '首页', kids: [] }));
});

test('inlineable: 长文本不可内联', () => {
  assert.ok(!inlineable({ text: 'x'.repeat(30), kids: [] }));
});

test('inlineable: 空文本不可内联', () => {
  assert.ok(!inlineable({ text: '', kids: [] }));
});

// —— leafText ——
test('leafText: 自身文本优先', () => {
  assert.equal(leafText({ text: 'self', kids: [{ text: 'child', kids: [] }] }), 'self');
});

test('leafText: 自身无文本取首个有文本后代', () => {
  assert.equal(leafText({ kids: [{ text: '', kids: [] }, { text: 'found', kids: [] }] }), 'found');
});

test('leafText: 全空返回空串', () => {
  assert.equal(leafText({ kids: [{ text: '', kids: [] }] }), '');
});

// —— firstTxt ——
test('firstTxt: 取后代数组里首个有文本项', () => {
  const arr = [{ text: '', kids: [] }, { text: 'A', kids: [] }, { text: 'B', kids: [] }];
  assert.equal(firstTxt(arr), 'A');
});

test('firstTxt: 递归深入无文本项的 kids', () => {
  const arr = [{ kids: [{ text: '', kids: [] }, { text: 'deep', kids: [] }] }];
  assert.equal(firstTxt(arr), 'deep');
});

test('firstTxt: 全空返回空串', () => {
  assert.equal(firstTxt([{ kids: [] }]), '');
});

// —— isTrivialLeaf ——
test('isTrivialLeaf: 空文本是琐碎叶', () => {
  assert.ok(isTrivialLeaf({ text: '', kids: [] }));
});

test('isTrivialLeaf: 纯符号短串是琐碎叶(如 "/" 分隔)', () => {
  assert.ok(isTrivialLeaf({ text: '/', kids: [] }));
  assert.ok(isTrivialLeaf({ text: '·', kids: [] }));
});

test('isTrivialLeaf: 含字词的短串非琐碎(如 "游戏")', () => {
  assert.ok(!isTrivialLeaf({ text: '游戏', kids: [] }));
});

test('isTrivialLeaf: 长纯符号串也非琐碎(如 "/usr/bin")', () => {
  assert.ok(!isTrivialLeaf({ text: '/usr/bin', kids: [] }));
});
