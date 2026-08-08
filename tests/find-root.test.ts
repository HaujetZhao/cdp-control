/**
 * find-root.test.ts — shadow 穿透 xpath 引擎的完备单测(Node 内置 node:test,零依赖)。
 *
 * 引擎依赖真实 DOM 全局 `document`(nodeType 判定,跨 realm 安全),这里用假 DOM 替换
 * globalThis.document 驱动:元素含 children/shadowRoot/attrs/textContent,文档/片段按
 * nodeType(9/11)区分。document.evaluate 实现最小子集(谓词布尔 + 简单路径),足以覆盖
 * tokenizer / 拼接树遍历 / `[n]` 索引 / 谓词分发 / 诊断 / 快速路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeSteps, parseTest, xpathEval, xpathRoot, shadowContexts, findRoot } from '../src/inject/lib/find-root.ts';

/* ================= 假 DOM ================= */

class FakeEl {
  nodeType = 1;
  tagName: string;
  children: FakeEl[] = [];
  attrs: Record<string, string> = {};
  textContent = '';
  shadowRoot: FakeFrag | null = null;
  constructor(tag: string, o: { children?: FakeEl[]; attrs?: Record<string, string>; text?: string; shadow?: FakeFrag } = {}) {
    this.tagName = tag.toUpperCase();
    if (o.children) this.children = o.children;
    if (o.attrs) this.attrs = o.attrs;
    if (o.text != null) this.textContent = o.text;
    if (o.shadow) this.shadowRoot = o.shadow;
  }
  getAttribute(n: string) { return this.attrs[n] ?? null; }
}

class FakeFrag {
  nodeType = 11; // DocumentFragment(shadowRoot)
  children: FakeEl[] = [];
  constructor(ch: FakeEl[]) { this.children = ch; }
}

/** 拼接子:light 子 + shadowRoot 顶层子(与引擎 splicedChildren 同构)。 */
function spliced(c: FakeEl): FakeEl[] {
  return c.children.concat(c.shadowRoot ? c.shadowRoot.children : []);
}

/** 扁平子孙-or-self 收集(文档序,去重)。 */
function collectAll(node: FakeEl, tag: string, out: FakeEl[]): void {
  for (const c of spliced(node)) {
    if (tag === '*' || c.tagName === tag.toUpperCase()) out.push(c);
    collectAll(c, tag, out);
  }
}

/** 最小 xpath 求值器:FIRST(9)=简单路径,BOOLEAN(1)=谓词子集。 */
class FakeDoc {
  nodeType = 9;
  children: FakeEl[] = [];
  body: FakeEl | null = null;
  constructor(ch: FakeEl[]) { this.children = ch; this.body = ch[0]; }
  querySelector(sel: string): FakeEl | null {
    const m = sel.match(/^#([\w-]+)$/);
    if (!m) return null;
    const out: FakeEl[] = []; collectAll({ tagName: '', children: this.children, shadowRoot: null } as any, '*', out);
    return out.find(e => e.attrs.id === m[1]) || null;
  }
  evaluate(expr: string, ctx: any): { singleNodeValue: FakeEl | null } | { booleanValue: boolean } {
    const type1 = /^\[/.test(expr) || expr.includes('(') && !expr.startsWith('/');
    if (type1 || expr.startsWith('@') || expr.includes('text()') || expr.includes('contains')) {
      return { booleanValue: evalBool(expr, ctx) };
    }
    return { singleNodeValue: evalFirst(expr, ctx) };
  }
}

/** 谓词布尔子集(以 ctx 元素为 context)。 */
function evalBool(expr: string, ctx: FakeEl): boolean {
  const t = ctx.textContent || '';
  let m: RegExpMatchArray | null;
  if ((m = expr.match(/^contains\(@([\w-]+),\s*['"](.*)['"]\)$/))) return (ctx.attrs[m[1]] || '').includes(m[2]);
  if ((m = expr.match(/^contains\(text\(\),\s*['"](.*)['"]\)$/))) return t.includes(m[1]);
  if ((m = expr.match(/^@([\w-]+)\s*=\s*['"](.*)['"]$/))) return (ctx.attrs[m[1]] || '') === m[2];
  if ((m = expr.match(/^@([\w-]+)$/))) return !!ctx.attrs[m[1]];
  if (expr === 'true()') return true;
  if (expr === 'false()') return false;
  return !!t;
}

/** 简单路径求值:支持 `/a/b[2]`(绝对)、`//a`(desc)、`a[2]`(相对)、混合。 */
function evalFirst(expr: string, ctx: any): FakeEl | null {
  const abs = expr.startsWith('/');
  let nodes: FakeEl[] = [abs ? fakeDoc as any : ctx];
  const rest = expr.replace(/^\/+/, '');
  let desc = expr.startsWith('//');
  for (const seg of rest.split('/')) {
    if (!seg) { desc = true; continue; }
    const m = seg.match(/^([a-zA-Z*]+)(?:\[(\d+)\])?$/);
    if (!m) return null;
    const [, tag, idx] = m;
    const next: FakeEl[] = [];
    for (const n of nodes) {
      if (desc) collectAll(n, tag, next);
      else {
        const matched = spliced(n).filter(c => tag === '*' || c.tagName === tag.toUpperCase());
        next.push(...(idx ? [matched[+idx - 1]] : matched));
      }
    }
    nodes = next.filter(Boolean) as FakeEl[];
    desc = false;
  }
  return nodes[0] || null;
}

/* ================= 夹具:含两层嵌套 shadow 的 B 站式结构 ================= */

const replyspan = new FakeEl('span', { attrs: { id: 'replyspan' }, text: 'hi' });
const r1 = new FakeEl('bili-reply', { children: [replyspan], attrs: { id: 'r1' } });
const ts1 = new FakeEl('div', { attrs: { id: 'ts1' } });
const t1shadow = new FakeFrag([ts1, r1]);
const t1 = new FakeEl('bili-thread', { attrs: { id: 't1' }, shadow: t1shadow });
const s1 = new FakeEl('div', { attrs: { id: 's1' } });
const s2 = new FakeEl('div', { attrs: { id: 's2' }, children: [t1] });
const s3 = new FakeEl('div', { attrs: { id: 's3' } });
const bcshadow = new FakeFrag([s1, s2, s3]);
const light1 = new FakeEl('div', { attrs: { id: 'light1' } });
const bc = new FakeEl('bili-comments', { attrs: { id: 'bc' }, shadow: bcshadow, children: [light1] });
const a1 = new FakeEl('div', { attrs: { id: 'a1' } });
const a2 = new FakeEl('div', { attrs: { id: 'a2' }, children: [bc] });
const a3 = new FakeEl('div', { attrs: { id: 'a3' } });
const body = new FakeEl('body', { children: [a1, a2, a3] });
const html = new FakeEl('html', { children: [body] });
const fakeDoc = new FakeDoc([html]);
(globalThis as any).document = fakeDoc;

/** 断言一次求值命中 id 列表(按扁平文档序)。 */
function idsOf(xp: string): string[] {
  return xpathEval(xp).nodes.map(e => (e as any).attrs.id).filter(Boolean);
}

/* ================= tokenizer ================= */

test('tokenize: 绝对路径 /html/body/div[2]', () => {
  assert.deepEqual(tokenizeSteps('/html/body/div[2]'), [
    { text: 'html', axis: 'child', tag: 'html', preds: [] },
    { text: 'body', axis: 'child', tag: 'body', preds: [] },
    { text: 'div[2]', axis: 'child', tag: 'div', preds: ['2'] },
  ]);
});

test('tokenize: 纯 // 相对路径', () => {
  assert.deepEqual(tokenizeSteps('//div'), [{ text: 'div', axis: 'desc', tag: 'div', preds: [] }]);
});

test('tokenize: 混合 / 与 // 连续路径', () => {
  assert.deepEqual(tokenizeSteps('/bili-comments//div[2]/span'), [
    { text: 'bili-comments', axis: 'child', tag: 'bili-comments', preds: [] },
    { text: 'div[2]', axis: 'desc', tag: 'div', preds: ['2'] },
    { text: 'span', axis: 'child', tag: 'span', preds: [] },
  ]);
});

test('tokenize: 引号内含 / 不被切分(谓词字面量)', () => {
  assert.deepEqual(tokenizeSteps('//div[contains(text(),"a/b")]'), [
    { text: 'div[contains(text(),"a/b")]', axis: 'desc', tag: 'div', preds: ['contains(text(),"a/b")'] },
  ]);
});

test('tokenize: 单引号 + 空格值 + 多谓词', () => {
  assert.deepEqual(tokenizeSteps("//div[contains(@class,'x y')][2]"), [
    { text: "div[contains(@class,'x y')][2]", axis: 'desc', tag: 'div', preds: ["contains(@class,'x y')", '2'] },
  ]);
});

test('tokenize: 嵌套括号内的 / 不切分', () => {
  assert.deepEqual(tokenizeSteps('//div[a[1]/b]'), [
    { text: 'div[a[1]/b]', axis: 'desc', tag: 'div', preds: ['a[1]/b'] },
  ]);
});

test('tokenize: 通配符与属性步', () => {
  assert.deepEqual(tokenizeSteps("//*[@id='x']"), [
    { text: "*[@id='x']", axis: 'desc', tag: '*', preds: ["@id='x'"] },
  ]);
});

test('tokenize: 无前置斜杠的相对路径默认 desc', () => {
  assert.deepEqual(tokenizeSteps('div'), [{ text: 'div', axis: 'desc', tag: 'div', preds: [] }]);
});

/* ================= parseTest ================= */

test('parseTest: 纯标签', () => {
  assert.deepEqual(parseTest('span'), { tag: 'span', preds: [] });
});

test('parseTest: 通配符', () => {
  assert.deepEqual(parseTest('*'), { tag: '*', preds: [] });
});

test('parseTest: 大写归一为小写', () => {
  assert.deepEqual(parseTest('DIV'), { tag: 'div', preds: [] });
});

test('parseTest: 索引 + 谓词有序', () => {
  assert.deepEqual(parseTest("div[contains(@class,'a')][3]"), { tag: 'div', preds: ["contains(@class,'a')", '3'] });
});

/* ================= 拼接树遍历(shadow 穿透) ================= */

test('穿透: // 找到嵌套 shadow 内的 span', () => {
  assert.deepEqual(idsOf('//span'), ['replyspan']);
});

test('穿透: 绝对 child 链直达宿主', () => {
  assert.deepEqual(idsOf('/html/body/div[2]'), ['a2']);
});

test('穿透: //desc 按扁平文档序取索引(light 在前、shadow 依宿主序)', () => {
  // bili-comments 拼接子:[light1, s1, s2, s3];desc divs 文档序:light1,s1,s2,ts1,s3
  assert.deepEqual(idsOf('/html/body/div[2]/bili-comments//div[1]'), ['light1']);
  assert.deepEqual(idsOf('/html/body/div[2]/bili-comments//div[2]'), ['s1']);
  assert.deepEqual(idsOf('/html/body/div[2]/bili-comments//div[5]'), ['s3']);
  assert.deepEqual(idsOf('/html/body/div[2]/bili-comments//div[6]'), []);
});

test('穿透: 嵌套 shadow 逐层穿透到叶', () => {
  assert.deepEqual(idsOf('/html/body/div[2]/bili-comments//bili-thread//bili-reply/span'), ['replyspan']);
});

test('穿透: //div 全量命中一次(去重)', () => {
  const r = xpathEval('//div');
  assert.equal(r.count, 8); // a1,a2,a3,light1,s1,s2,ts1,s3
  assert.equal(idsOf('//div').length, 8);
});

test('穿透: 通配 * 命中所有元素', () => {
  assert.ok(xpathEval('//*').count >= 10);
});

test('穿透: 未命中返回空 + ok=false', () => {
  const r = xpathEval('/html/body/div[2]/bili-comments//nope');
  assert.equal(r.ok, false);
  assert.equal(r.count, 0);
});

/* ================= 谓词分发(假 evaluate) ================= */

test('谓词: contains(@id, 子串) 过滤', () => {
  // 含 's' 的 div:s1,s2,s3 与 ts1(ts1 含 's');按扁平文档序
  assert.deepEqual(idsOf("/html/body/div[2]/bili-comments//div[contains(@id,'s')]"), ['s1', 's2', 'ts1', 's3']);
});

test('谓词: @attr=val 精确匹配', () => {
  assert.deepEqual(idsOf("//*[@id='replyspan']"), ['replyspan']);
});

test('谓词: 索引与谓词组合', () => {
  assert.deepEqual(idsOf("/html/body/div[2]/bili-comments//div[contains(@id,'s')][2]"), ['s2']);
});

/* ================= 诊断 ================= */

test('诊断: 断链定位到失败步与当时候选', () => {
  const r = xpathEval('/html/body/div[2]/bili-comments//div[2]/bili-nothing');
  const last = r.trace[r.trace.length - 1];
  assert.deepEqual(last, { text: 'bili-nothing', axis: 'child', input: 1, matched: 0, sample: 'div' });
});

test('诊断: 早期即断(第二步无匹配,走分步引擎)', () => {
  const r = xpathEval('/html//nope'); // 含 // 强制走分步引擎
  assert.deepEqual(r.trace, [
    { text: 'html', axis: 'child', input: 1, matched: 1, sample: undefined },
    { text: 'nope', axis: 'desc', input: 1, matched: 0, sample: 'html' },
  ]);
});

test('诊断: 命中路径每步都有 matched 且无 sample', () => {
  const r = xpathEval('/html/body/div[2]');
  assert.ok(r.ok);
  assert.ok(r.trace.every(s => s.matched > 0 && s.sample === undefined));
});

/* ================= xpathRoot / findRoot ================= */

test('xpathRoot: 取首个命中,未命中返回 null', () => {
  assert.equal((xpathRoot('/html/body/div[2]') as any).attrs.id, 'a2');
  assert.equal(xpathRoot('/html/nope'), null);
});

test('findRoot: xpath 建根', () => {
  assert.equal((findRoot(undefined, '/html/body/div[2]') as any).attrs.id, 'a2');
});

test('findRoot: 缺省返回 body', () => {
  assert.equal(findRoot(), fakeDoc.body);
});

/* ================= 快速路径(不含 //) ================= */

test('快速路径: 不含 // 走 document.evaluate 单条 trace', () => {
  const r = xpathEval('/html/body/div[2]');
  assert.equal(r.ok, true);
  assert.equal(r.trace.length, 1);
  assert.equal(r.trace[0].axis, 'child');
  assert.equal((r.nodes[0] as any).attrs.id, 'a2');
});

test('快速路径: 未命中返回空', () => {
  const r = xpathEval('/html/body/div[9]');
  assert.equal(r.ok, false);
  assert.equal(r.count, 0);
});

/* ================= shadowContexts ================= */

test('shadowContexts: document + 各 shadowRoot 顶层子,按 DFS 预序', () => {
  const ctxs = shadowContexts();
  assert.equal(ctxs[0], fakeDoc);
  // bc.shadow 顶层子 s1,s2,s3;t1.shadow 顶层子 ts1,r1 —— 预序:doc,s1,s2,s3,ts1,r1
  assert.deepEqual(ctxs.slice(1).map((c: any) => c.attrs?.id), ['s1', 's2', 's3', 'ts1', 'r1']);
});
