/**
 * recover-chain-dom.test.ts — 用最小假 DOM 锁定「整页 view → 局部 view → 节点移除 → recoverRef」链路。
 * 不起浏览器、不用 jsdom;重点:局部 view/find/feedback/自愈自身的 buildView 都以某元素为根建树,
 * 根的 parentRef 必须接回既有登记表(DOM 最近已登记祖先),不能被写成 null 切断跳表。
 */
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { entryParent, registerRef, type RefEntry } from '../src/inject/lib/find-root.ts';
import { buildView } from '../src/inject/lib/view-core.ts';
import { recoverRef } from '../src/inject/lib/find.ts';

class FakeText {
  readonly nodeType = 3;
  readonly nodeValue: string;
  constructor(nodeValue: string) { this.nodeValue = nodeValue; }
}

class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly shadowRoot = null;
  parentElement: FakeElement | null = null;
  isConnected = true;
  private readonly attrs = new Map<string, string>();

  constructor(tag: string, text?: string) {
    this.tagName = tag.toUpperCase();
    if (text) this.childNodes.push(new FakeText(text));
  }
  append(child: FakeElement): this {
    child.parentElement = this;
    this.children.push(child);
    this.childNodes.push(child);
    return this;
  }
  /** 模拟 SPA 重渲染:自身脱离父节点,整棵子树 isConnected=false。 */
  remove(): void {
    const p = this.parentElement;
    if (p) {
      p.children.splice(p.children.indexOf(this), 1);
      p.childNodes.splice(p.childNodes.indexOf(this), 1);
    }
    this.parentElement = null;
    const mark = (e: FakeElement) => { e.isConnected = false; e.children.forEach(mark); };
    mark(this);
  }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  matches(): boolean { return false; }
  getRootNode(): FakeElement { return this; }
  getBoundingClientRect() { return { width: 100, height: 20, top: 0, bottom: 20, left: 0, right: 100 }; }
}

interface TestGlobals {
  __cdpRefs?: RefEntry[];
  __cdpRefIndex?: WeakMap<Element, number>;
  __cdpFolds?: Array<{ selector: string; note: string }>;
}
const globals = globalThis as typeof globalThis & TestGlobals;
const el = (e: FakeElement) => e as unknown as Element;
const parentOf = (ref: number) => entryParent(globals.__cdpRefs?.[ref]);

const originals = ['Element', 'ShadowRoot', 'innerHeight', 'innerWidth'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
Object.defineProperty(globalThis, 'Element', { configurable: true, value: FakeElement });
Object.defineProperty(globalThis, 'ShadowRoot', { configurable: true, value: class FakeShadowRoot {} });
Object.defineProperty(globalThis, 'innerHeight', { configurable: true, value: 800 });
Object.defineProperty(globalThis, 'innerWidth', { configurable: true, value: 1200 });
after(() => {
  for (const [k, d] of originals) {
    if (d) Object.defineProperty(globalThis, k, d);
    else Reflect.deleteProperty(globalThis, k);
  }
});
beforeEach(() => {
  delete globals.__cdpRefs;
  delete globals.__cdpRefIndex;
  globals.__cdpFolds = [];
});

/** body > main > section > (p 正文, button 展开)。整页 view 先序登记:body0 main1 section2 p3 button4。 */
function page() {
  const p = new FakeElement('p', '正文段落');
  const button = new FakeElement('button', '展开评论');
  const section = new FakeElement('section').append(p).append(button);
  const main = new FakeElement('main').append(section);
  const body = new FakeElement('body').append(main);
  return { body, main, section, p, button };
}

test('整页 view → 局部 view:局部根保留跳表父链,节点移除后 recoverRef 沿原链找到存活祖先', () => {
  const { body, main, section } = page();
  const full = buildView(el(body), { viewport: true });
  assert.equal(full.kids[0].kids[0].kids[0].ref, 3, 'p 应是 ref=3(body0 main1 section2 先序)');
  assert.equal(parentOf(2), 1, '整页 view 后 section 的 parentRef 指向 main');
  assert.equal(parentOf(3), 2);

  const partial = buildView(el(section), { viewport: true });
  assert.equal(partial.kids[0].ref, 3, '局部 view 复用 p 的号');
  assert.equal(parentOf(2), 1, '局部 view 以 section 为根,不得把 section 的 parentRef 覆盖成 null');

  section.remove();
  const rec = recoverRef(3);
  assert.ok(rec && 'rootRef' in rec, 'p 失效后应沿 3→2→1 找到仍 connected 的 main');
  assert.equal(rec.rootRef, 1);
  assert.ok(rec.lines[0].startsWith('main'), `自愈局部 view 以 main 为根:${rec.lines[0]}`);

  // 自愈自身的 buildView(main) 也不得切断 main 的链:main 再被移除时还能二次自愈到 body。
  assert.equal(parentOf(1), 0, 'recoverRef 的局部 buildView 不覆盖恢复根的 parentRef');
  main.remove();
  const rec2 = recoverRef(3);
  assert.ok(rec2 && 'rootRef' in rec2, '二级自愈:3→2→1→0');
  assert.equal(rec2.rootRef, 0);
});

test('首次见到的局部根(find/--selector/feedback 新块)按 DOM 最近已登记祖先接链', () => {
  const { body, main } = page();
  buildView(el(body), { viewport: true });
  // SPA 追加新区块:整页 view 时不存在,后被 find/feedback 直接以它为根建树。
  const p2 = new FakeElement('p', '新加载的段落');
  const section2 = new FakeElement('section').append(p2);
  main.append(section2);

  const local = buildView(el(section2), { viewport: true });
  const p2Ref = local.kids[0].ref!;
  const section2Ref = globals.__cdpRefIndex!.get(el(section2))!;
  assert.equal(parentOf(section2Ref), 1, '新根 section2 的 parentRef 应是 DOM 上最近已登记祖先 main');
  assert.equal(parentOf(p2Ref), section2Ref);

  section2.remove();
  const rec = recoverRef(p2Ref);
  assert.ok(rec && 'rootRef' in rec, '新块内元素失效后应能自愈到 main');
  assert.equal(rec.rootRef, 1);
});

test('registerRef 省略 parentRef:按 DOM 最近已登记祖先接链;整页根无祖先则 null', () => {
  const { body, main, section, p } = page();
  buildView(el(body), { viewport: true });
  const wrapper = new FakeElement('div');
  const leaf = new FakeElement('span', '叶子');
  wrapper.append(leaf);
  section.append(wrapper);
  // find/read 路径:只登记不建树;wrapper 未登记,leaf 越过它接到 section(ref=2)。
  assert.equal(parentOf(registerRef(el(leaf))), 2);
  // 已登记元素省略 parentRef 也按当前 DOM 刷新(此处不变),不会退化成 null。
  assert.equal(parentOf(registerRef(el(p))), 2);
  assert.equal(parentOf(registerRef(el(main))), 0);
  assert.equal(parentOf(registerRef(el(body))), null, '整页根 body 无已登记祖先');
});
