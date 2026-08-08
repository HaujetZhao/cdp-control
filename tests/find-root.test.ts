/**
 * find-root.test.ts — fontoxpath xpath 引擎的纯字符串单测(Node 内置 node:test,零依赖)。
 *
 * 新引擎把页面原样交给 fontoxpath 求值,只靠一个 shadow 穿透的 IDomFacade 让 shadow DOM
 * 对 XPath 透明;轴/谓词/`[n]` 语义由 XPath 3.1 引擎保证。故只单测可脱离 DOM 的纯逻辑:
 *   - normalizeXpath:相对路径 → descendant 前缀
 *   - splitAxis:按顶层 `/`/`//` 切轴,引号/嵌套括号内的 `/` 不切
 * shadow 穿透 facade + fontoxpath 求值依赖真实 DOM 全局 `document`,按项目约定靠浏览器实测验收。
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
  assert.equal(normalizeXpath('bili-comments//div[2]/span'), '//bili-comments//div[2]/span');
});

test('normalize: 完整表达式(括号/函数/字面量/数字)原样不加前缀', () => {
  assert.equal(normalizeXpath('(//div)[1]'), '(//div)[1]');           // 括号分组取第 1 个
  assert.equal(normalizeXpath('count(//div)'), 'count(//div)');        // 函数调用
  assert.equal(normalizeXpath('1 + 2'), '1 + 2');                      // 算术(数字开头)
  assert.equal(normalizeXpath('"首页"'), '"首页"');                    // 字符串字面量
  assert.equal(normalizeXpath("'x'"), "'x'");                          // 单引号字面量
  assert.equal(normalizeXpath('$var'), '$var');                        // 变量
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
