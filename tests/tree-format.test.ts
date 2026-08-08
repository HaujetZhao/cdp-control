/**
 * tree-format.test.ts — 结构树纯变换(formatTree / markText / TreeNode)的单元测试
 * (Node 内置 node:test,零依赖)。直接 import src/inject/lib/tree-format,锁定折叠/内联行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markText, formatTree, type TreeNode } from '../src/inject/lib/tree-format.ts';

/** 构造 TreeNode 的便捷 helper:size 由 markText 前手动填,hasText 由 markText 重算。 */
function mk(over: Partial<TreeNode>): TreeNode {
  return { tag: 'div', isContent: false, text: '', inter: false, imgAlt: '', kids: [], size: 1, hasText: false, ...over };
}

test('formatTree: 纯包装节点折叠(productive.length===1 时递归,输出不含中间标签)', () => {
  const btn = mk({ tag: 'button', isContent: true, text: '点击', inter: true, size: 1 });
  const wrap = mk({ tag: 'div', isContent: false, size: 2, kids: [btn] });
  const root = mk({ tag: 'html', isContent: false, size: 3, kids: [wrap] });
  markText(root);
  // wrapper div 被折叠:不出现 "div" 行,只有 button 一行
  assert.deepEqual(formatTree(root), ['html', '  button "点击"']);
});

test('formatTree: 多个短文本后代被内联成一行', () => {
  const s1 = mk({ tag: 'span', isContent: true, text: '首页', size: 1 });
  const s2 = mk({ tag: 'span', isContent: true, text: '发现', size: 1 });
  const s3 = mk({ tag: 'span', isContent: true, text: '我的', size: 1 });
  const nav = mk({ tag: 'nav', isContent: false, size: 4, kids: [s1, s2, s3] });
  const root = mk({ tag: 'div', isContent: false, size: 5, kids: [nav] });
  markText(root);
  // 三个短文本后代全部 inlineable,合并成 "nav 首页 发现 我的" 一行
  assert.deepEqual(formatTree(root), ['div', '  nav "首页" "发现" "我的"']);
});

test('formatTree: 两个以上非内联 productive 后代各自成行', () => {
  const long1 = '核心'.repeat(13); // 26 字符,>24 不可内联
  const long2 = '要点'.repeat(13); // 26 字符
  const p1 = mk({ tag: 'p', isContent: true, text: long1, size: 1 });
  const h2 = mk({ tag: 'h2', isContent: true, text: long2, size: 1 });
  const sec = mk({ tag: 'section', isContent: false, size: 3, kids: [p1, h2] });
  const root = mk({ tag: 'div', isContent: false, size: 4, kids: [sec] });
  markText(root);
  // section 作为分支标签单独一行,两个长后代各自缩进成行
  assert.deepEqual(formatTree(root), [
    'div',
    '  section',
    '    p "' + long1 + '"',
    '    h2 "' + long2 + '"',
  ]);
});

test('formatTree: span 单文本行(!hasChildText && span && text → "text")', () => {
  const span = mk({ tag: 'span', isContent: true, text: '标题', size: 1 });
  const root = mk({ tag: 'div', isContent: false, size: 2, kids: [span] });
  markText(root);
  // span 无子文本,走引号裸文案行(无标签)
  assert.deepEqual(formatTree(root), ['div', '  "标题"']);
});

test('formatTree: leafValue 节点输出 "leafValue 后代首文本" 行', () => {
  const txt = mk({ tag: 'span', isContent: true, text: '22.9万', size: 1 });
  const item = mk({ tag: 'li', isContent: true, leafValue: '点赞', size: 2, kids: [txt] });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [item] });
  markText(root);
  // leafValue 项拼上后代首文本
  assert.deepEqual(formatTree(root), ['div', '  "点赞 22.9万"']);
});

test('formatTree: leafish 叶(inter 或 img)输出 leafLabel 行', () => {
  const img = mk({ tag: 'img', isContent: true, imgAlt: '封面', size: 1 });
  const btn = mk({ tag: 'button', isContent: true, text: '登录', inter: true, size: 1 });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [img, btn] });
  markText(root);
  // img 叶:img "封面";inter 叶 button:button "登录"
  assert.deepEqual(formatTree(root), ['div', '  img "封面"', '  button "登录"']);
});

test('formatTree: 自身直接文本 + 文本子节点并存时,ownText 不丢(富文本段落)', () => {
  // 模拟知乎富文本段落 <p>own<span>nested</span></p>:p 既有自身文本又有文本子节点。
  const span = mk({ tag: 'span', isContent: true, text: '你的大脑其实已经在腹腔了。', size: 1 });
  const p = mk({ tag: 'p', isContent: true, text: '肠子才是动物进化路中最先出现的大脑，', size: 2, kids: [span] });
  const root = mk({ tag: 'div', isContent: false, size: 3, kids: [p] });
  markText(root);
  // p 的 ownText 必须出现,不能只显示子 span(否则段落前半截整段丢失)
  assert.deepEqual(formatTree(root), ['div', '  "肠子才是动物进化路中最先出现的大脑，"', '  p "你的大脑其实已经在腹腔了。"']);
});

test('markText: 自身文本或后代文本都置 hasText=true', () => {
  const child = mk({ tag: 'span', isContent: true, text: '子', size: 1 });
  const root = mk({ tag: 'div', isContent: false, size: 2, kids: [child] });
  assert.equal(markText(root), true);
  assert.equal(root.hasText, true);
  assert.equal(child.hasText, true);
  const empty = mk({ tag: 'div', isContent: false, size: 1 });
  assert.equal(markText(empty), false);
  assert.equal(empty.hasText, false);
});

test('formatTree: 聚合文本节点(agg)输出 ~ 前缀,字面文本不加', () => {
  const agg = mk({ tag: 'a', isContent: true, text: '首页', inter: true, agg: true, size: 1 });
  const lit = mk({ tag: 'a', isContent: true, text: '下载', inter: true, size: 1 });
  const root = mk({ tag: 'nav', isContent: false, size: 3, kids: [agg, lit] });
  markText(root);
  assert.deepEqual(formatTree(root), ['nav', '  a ~"首页"', '  a "下载"']);
});
