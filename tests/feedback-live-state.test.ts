/**
 * feedback-live-state.test.ts — 用 jsdom(真实 DOM 语义)锁定反馈对 live 语义状态的采集:
 * checkbox/radio 的 checked、option 的 selected 只存在于 IDL property(点击/赋值 .checked、选中 option、
 * select.value= 都**不改 content attribute**),MutationObserver 的 attributes 看不到,必须 start 时快照、
 * collect 时按 property 比对。同时锁定:仍反映到 attribute 的状态(details.open)继续走属性通道、
 * 同一语义变化不双报、无变化不误报、shadow 内元素与已移除元素的处理。
 * 每次动作后 await 一个宏任务再 collect,对应真实流程里 collect 是另一次 Runtime.evaluate。
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { collectFeedback, startFeedback, type FeedbackAttr } from '../src/inject/lib/feedback.ts';

const GLOBALS = ['document', 'Element', 'Node', 'Document', 'DocumentFragment', 'ShadowRoot', 'MutationObserver',
  'HTMLElement', 'HTMLInputElement', 'HTMLOptionElement', 'HTMLSelectElement', 'HTMLDetailsElement', 'Text', 'NodeList',
  'getComputedStyle', 'innerHeight', 'innerWidth'] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
let dom: JSDOM;
const g = globalThis as any;

before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  for (const k of GLOBALS) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: (dom.window as any)[k] });
  }
});
after(() => {
  for (const [k, d] of saved) {
    if (d) Object.defineProperty(globalThis, k, d);
    else Reflect.deleteProperty(globalThis, k);
  }
  dom.window.close();
});
beforeEach(() => {
  g.__cdpFeedback = null;
  delete g.__cdpRefs;
  delete g.__cdpRefIndex;
  dom.window.document.body.innerHTML = '';
});

const tick = () => new Promise<void>(r => setTimeout(r, 0));
const html = (s: string) => { dom.window.document.body.innerHTML = s; return dom.window.document; };
const byId = (id: string) => dom.window.document.getElementById(id) as any;
/** 一次动作的属性/状态反馈:start → act → 等一拍 → collect,只取 attrs。 */
async function attrsAfter(act: () => void): Promise<FeedbackAttr[]> {
  startFeedback();
  act();
  await tick();
  return collectFeedback().attrs;
}
const pick = (attrs: FeedbackAttr[], attr: string) => attrs.filter(a => a.attr === attr).map(a => `${a.desc} · ${a.attr}: ${a.before} → ${a.after}`);

test('checkbox 点击:checked 变化被反馈,尽管 content attribute 没变(observer 单独看不到)', async () => {
  html('<label>同意条款 <input id="agree" type="checkbox" aria-label="同意条款"></label>');
  const box = byId('agree');
  const attrs = await attrsAfter(() => box.click());
  assert.equal(box.checked, true);
  assert.equal(box.hasAttribute('checked'), false, '真实 DOM:点击只改 checkedness,不写 attribute');
  assert.deepEqual(pick(attrs, 'checked'), ['input#agree "同意条款" · checked: false → true']);
  assert.equal(attrs.length, 1, '同一语义变化只报一条');
});

test('脚本赋值 .checked = true / false:同样被反馈', async () => {
  html('<input id="c" type="checkbox" checked>');
  const box = byId('c');
  assert.equal(box.checked, true);
  let attrs = await attrsAfter(() => { box.checked = false; });
  assert.deepEqual(pick(attrs, 'checked'), ['input#c · checked: true → false']);
  assert.equal(box.hasAttribute('checked'), true, 'attribute 仍在(默认态),但 property 已变');
  attrs = await attrsAfter(() => { box.checked = true; });
  assert.deepEqual(pick(attrs, 'checked'), ['input#c · checked: false → true']);
});

test('radio 组:点击 B 同时反馈 A 取消选中与 B 选中', async () => {
  html('<input id="a" type="radio" name="g" aria-label="甲" checked><input id="b" type="radio" name="g" aria-label="乙">');
  const attrs = await attrsAfter(() => byId('b').click());
  assert.deepEqual(pick(attrs, 'checked').sort(), [
    'input#a "甲" · checked: true → false',
    'input#b "乙" · checked: false → true',
  ]);
});

test('select:select.value= 与 option.selected= 都按 option 反馈 selected 变化(attribute 不动)', async () => {
  html('<select id="s"><option value="1" selected>One</option><option value="2">Two</option><option value="3">Three</option></select>');
  const s = byId('s');
  let attrs = await attrsAfter(() => { s.value = '2'; });
  assert.deepEqual(pick(attrs, 'selected').sort(), [
    'option "One" · selected: true → false',
    'option "Two" · selected: false → true',
  ]);
  assert.equal(s.options[0].hasAttribute('selected'), true, '真实 DOM:旧 option 的 selected attribute 仍在');
  assert.equal(s.options[1].hasAttribute('selected'), false);
  attrs = await attrsAfter(() => { s.options[2].selected = true; });
  assert.deepEqual(pick(attrs, 'selected').sort(), [
    'option "Three" · selected: false → true',
    'option "Two" · selected: true → false',
  ]);
});

test('无变化不误报;点击后又点回去也不误报(快照与终态相同)', async () => {
  html('<input id="c" type="checkbox"><select id="s"><option>x</option><option>y</option></select>');
  assert.deepEqual(await attrsAfter(() => {}), []);
  assert.deepEqual(await attrsAfter(() => { byId('c').click(); byId('c').click(); }), []);
});

test('反映到 attribute 的状态(details.open)仍走属性通道;setAttribute("checked") 只按语义结果报一次', async () => {
  html('<details id="d"><summary>更多</summary>正文</details><input id="clean" type="checkbox"><input id="dirty" type="checkbox">');
  const dirty = byId('dirty');
  dirty.click(); dirty.click(); // 用户交互后 dirty checkedness flag 置位:再设 attribute 不改 checkedness
  const attrs = await attrsAfter(() => {
    byId('d').open = true;
    byId('clean').setAttribute('checked', '');   // clean:attribute 让 checkedness 变 true → 报一次(来自 live 快照)
    dirty.setAttribute('checked', '');           // dirty:checkedness 不变 → 不报(旧实现会误报 attribute)
  });
  assert.deepEqual(pick(attrs, 'open'), ['details#d "正文" · open: null → ']);
  assert.deepEqual(pick(attrs, 'checked'), ['input#clean · checked: false → true']);
  assert.equal(byId('clean').checked, true);
  assert.equal(dirty.checked, false);
});

test('shadow root 内的 checkbox 也被快照/比对;动作期间被移除的元素跳过不抛', async () => {
  html('<div id="host"></div><input id="gone" type="checkbox">');
  const host = byId('host');
  const sr = host.attachShadow({ mode: 'open' });
  sr.innerHTML = '<input id="inner" type="checkbox" aria-label="影子">';
  const inner = sr.getElementById('inner') as any;
  const attrs = await attrsAfter(() => { inner.click(); byId('gone').remove(); });
  assert.deepEqual(pick(attrs, 'checked'), ['input#inner "影子" · checked: false → true']);
});
