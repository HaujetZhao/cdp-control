/**
 * find-root.test.ts — 合成拼接树 xpath 引擎的纯字符串单测(Node 内置 node:test,零依赖)。
 *
 * 新引擎把整页镜像成"无 shadow 的合成树"后整条路径交原生 document.evaluate 求值,
 * 轴/谓词/`[n]` 语义由浏览器标准 XPath 引擎保证,故只单测可脱离 DOM 的纯逻辑:
 *   - normalizeXpath:相对路径 → descendant 前缀
 *   - splitAxis:按顶层 `/`/`//` 切轴,引号/嵌套括号内的 `/` 不切
 * 合成树物化 + 原生求值 + 映射依赖真实 DOM 全局 `document`,按项目约定靠浏览器实测验收。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeXpath, splitAxis } from '../src/inject/lib/find-root.ts';

/* ================= normalizeXpath ================= */

test('normalize: 以 / 开头不改(绝对或 //)', () => {
  assert.equal(normalizeXpath('/html/body'), '/html/body');
  assert.equal(normalizeXpath('//div'), '//div');
});

test('normalize: 无前置斜杠的相对路径补 //(desc 搜索)', () => {
  assert.equal(normalizeXpath('div'), '//div');
  assert.equal(normalizeXpath('html/body'), '//html/body');
});

/* ================= splitAxis ================= */

test('splitAxis: 绝对路径 /html/body/div[2]', () => {
  assert.deepEqual(splitAxis('/html/body/div[2]'), [
    { axis: 'child', step: 'html' },
    { axis: 'child', step: 'body' },
    { axis: 'child', step: 'div[2]' },
  ]);
});

test('splitAxis: 纯 // 相对路径', () => {
  assert.deepEqual(splitAxis('//div'), [{ axis: 'desc', step: 'div' }]);
});

test('splitAxis: 混合 / 与 // 连续路径', () => {
  assert.deepEqual(splitAxis('/bili-comments//div[2]/span'), [
    { axis: 'child', step: 'bili-comments' },
    { axis: 'desc', step: 'div[2]' },
    { axis: 'child', step: 'span' },
  ]);
});

test('splitAxis: 引号内含 / 不被切分(谓词字面量)', () => {
  assert.deepEqual(splitAxis('//div[contains(text(),"a/b")]'), [
    { axis: 'desc', step: 'div[contains(text(),"a/b")]' },
  ]);
});

test('splitAxis: 单引号 + 空格值 + 多谓词', () => {
  assert.deepEqual(splitAxis("//div[contains(@class,'x y')][2]"), [
    { axis: 'desc', step: "div[contains(@class,'x y')][2]" },
  ]);
});

test('splitAxis: 嵌套括号内的 / 不切分', () => {
  assert.deepEqual(splitAxis('//div[a[1]/b]'), [{ axis: 'desc', step: 'div[a[1]/b]' }]);
});

test('splitAxis: 通配符与属性步', () => {
  assert.deepEqual(splitAxis("//*[@id='x']"), [{ axis: 'desc', step: "*[@id='x']" }]);
});

test('splitAxis: 轴前缀 parent::/ancestor:: 作为本步字面量(交给原生求值)', () => {
  assert.deepEqual(splitAxis('//h1/ancestor::div'), [
    { axis: 'desc', step: 'h1' },
    { axis: 'child', step: 'ancestor::div' },
  ]);
});
