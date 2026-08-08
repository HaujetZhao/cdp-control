/**
 * find-root.ts — 从 selector / xpath 求建树根元素(注入侧,无 Node 依赖)。
 * 被 tree 入口复用。xpath 为 shadow 穿透版,激进重做,不保留旧实现。
 *
 * —— 穿透模型:「拼接树」——
 * 把 shadowRoot 的顶层子元素当作宿主元素的子元素拼接进遍历(见 splicedChildren),
 * 于是 `/`(child)与 `//`(descendant-or-self)都天然跨越任意层嵌套 shadow 边界。
 * 谓词/索引一律以候选元素为 context 交给原生 document.evaluate 求布尔(能力完整:
 * contains()/@attr/text()…);仅索引 `[n]` 按"本步全部候选的扁平文档序"取第 n 个(1 基),
 * 这是跨 shadow 扁平语义下唯一自洽的索引定义。
 *
 * —— 两条路径 ——
 *  - 含 `//`:分步引擎 + 分步诊断(trace 定位"哪步断、当时候选是谁")。
 *  - 不含 `//`:document.evaluate 不接受 DocumentFragment(shadowRoot)作 context,
 *    故对 document + 各 shadowRoot 的顶层子元素各求值一次,按文档序取首个命中(快速路径)。
 *
 * —— 可测性 / 健壮性 ——
 * 用 nodeType 标准常量(1=Element,9=Document,11=DocumentFragment)替代 instanceof(跨 realm 更稳),
 * 用数字常量替代 XPathResult(9=FIRST_ORDERED_NODE_TYPE,1=BOOLEAN_TYPE)。
 * 依赖真实 DOM 全局 `document`,单测里用假 DOM 替换 globalThis.document 驱动。
 */

const XPATH_FIRST = 9;   // XPathResult.FIRST_ORDERED_NODE_TYPE
const XPATH_BOOL = 1;    // XPathResult.BOOLEAN_TYPE

/** 一个位置步。axis:child=`/`(直接拼接子),desc=`//`(拼接子孙-or-self)。 */
export interface XpStep {
  text: string;                 // 原始 test 字面,如 `div[2]`
  axis: 'child' | 'desc';
  tag: string;                  // 标签名小写,或 '*' 通配
  preds: string[];              // 谓词数组(索引为数字串,其余为布尔表达式)
}

/** 分步诊断信息。input=上一步产出的节点数;matched=本步命中数;sample=断在该步时输入节点的标签摘要。 */
export interface XpStepInfo { text: string; axis: 'child' | 'desc'; input: number; matched: number; sample?: string }

/** xpath 求值结果:全部命中 + 分步诊断。 */
export interface XpathEvalResult {
  ok: boolean;
  count: number;
  nodes: Element[];
  trace: XpStepInfo[];
}

/** 收集 shadow 穿透所需的求值上下文:document + 各 shadowRoot 的顶层子元素,按 DFS 预序(宿主文档序在前)。
 *  document.evaluate 不接受 DocumentFragment(shadowRoot)作 context node,故须取其顶层子元素(Element);
 *  DFS 递归穿透任意层嵌套 shadow。预序保证深层元素也能按文档序取到首个命中。 */
export function shadowContexts(): Element[] {
  const ctxs: Element[] = [document as unknown as Element];
  const seen = new Set<Node>([document]);
  const stack: Node[] = [document];
  while (stack.length) {
    const n = stack.pop()!;
    // shadowRoot(DocumentFragment, nodeType 11)的顶层子元素是求值 context(穿透一层 shadow;嵌套 shadow 各自递归)
    if (n.nodeType === 11) for (const c of Array.from((n as ParentNode).children)) ctxs.push(c as Element);
    // DFS 预序收集待遍历子(light children + 嵌套 shadowRoot),反转入栈保证文档序
    const kids: Node[] = [];
    if (n.nodeType === 1 && (n as Element).shadowRoot) kids.push((n as Element).shadowRoot!);
    if (n.nodeType === 1 || n.nodeType === 9 || n.nodeType === 11)
      for (const c of Array.from((n as ParentNode).children)) kids.push(c as Node);
    for (let i = kids.length - 1; i >= 0; i--) { const c = kids[i]; if (!seen.has(c)) { seen.add(c); stack.push(c); } }
  }
  return ctxs;
}

/** 拼接子元素:light 子在前,host 的 shadowRoot 顶层子拼接在后(穿透一层 shadow)。 */
function splicedChildren(node: ParentNode): Element[] {
  const kids: Element[] = [];
  for (const c of Array.from(node.children)) kids.push(c as Element);
  const sr = (node as Element).shadowRoot;
  if (node.nodeType === 1 && sr)
    for (const c of Array.from(sr.children)) kids.push(c as Element);
  return kids;
}

/** desc 轴收集:root 的拼接子孙里 tag 匹配的元素(不含 root 自身),扁平文档序,去重。 */
function collectSplicedDesc(root: ParentNode, tag: string, out: Element[], seen: Set<Element>): void {
  for (const c of splicedChildren(root)) {
    if (tag === '*' || (c.tagName || '').toLowerCase() === tag) { if (!seen.has(c)) { seen.add(c); out.push(c); } }
    collectSplicedDesc(c, tag, out, seen);
  }
}

/** 对候选求布尔谓词(以候选为 context 交给原生 evaluate)。失败视为不匹配。 */
function evalPred(el: Element, expr: string): boolean {
  try { return document.evaluate(expr, el, null, XPATH_BOOL, null).booleanValue; }
  catch { return false; }
}

/** 应用谓词/索引:`[n]`(纯数字)按候选扁平文档序取第 n 个(1 基);其余为布尔谓词逐个筛。 */
function applyPreds(list: Element[], preds: string[]): Element[] {
  let out = list;
  for (const p of preds) {
    if (/^\d+$/.test(p)) {
      const idx = parseInt(p, 10);
      if (idx < 1 || idx > out.length) return [];
      out = [out[idx - 1]];
    } else {
      out = out.filter(el => evalPred(el, p));
    }
  }
  return out;
}

/** 对一个位置步求全部命中:child=拼接子,desc=拼接子孙;跨输入去重后应用谓词。 */
function stepMatches(nodes: ParentNode[], step: XpStep): Element[] {
  const all: Element[] = [];
  const seen = new Set<Element>();
  for (const n of nodes) {
    if (step.axis === 'child') {
      for (const c of splicedChildren(n))
        if ((step.tag === '*' || (c.tagName || '').toLowerCase() === step.tag) && !seen.has(c)) { seen.add(c); all.push(c); }
    } else {
      collectSplicedDesc(n, step.tag, all, seen);
    }
  }
  return applyPreds(all, step.preds);
}

/** 把 xpath 按词法拆成位置步序列。`/`=child,`//`=desc;跳过 `[]` 与引号内的 `/`,支持嵌套括号与引号。 */
export function tokenizeSteps(xp: string): XpStep[] {
  const steps: XpStep[] = [];
  let axis: 'child' | 'desc' | null = null;
  let i = 0;
  const n = xp.length;
  while (i < n) {
    if (xp[i] === '/') {
      axis = xp[i + 1] === '/' ? 'desc' : 'child';
      i += axis === 'desc' ? 2 : 1;
      continue;
    }
    // 读一个完整 test:到顶层 '/' 或结尾;跳过 [] 与引号内内容
    let j = i, depth = 0, quote: string | null = null;
    while (j < n) {
      const c = xp[j];
      if (quote) { if (c === quote) quote = null; j++; continue; }
      if (c === '"' || c === "'") { quote = c; j++; continue; }
      if (c === '[') depth++;
      else if (c === ']') depth--;
      else if (c === '/' && depth === 0) break;
      j++;
    }
    const testStr = xp.slice(i, j);
    const { tag, preds } = parseTest(testStr);
    if (tag) steps.push({ text: testStr, axis: axis ?? 'desc', tag, preds });
    axis = null;
    i = j;
  }
  return steps;
}

/** 把 test 拆成 tag(小写或 '*' 通配)+ 有序谓词列表,括号/引号感知,支持嵌套。 */
export function parseTest(test: string): { tag: string; preds: string[] } {
  const ib = test.indexOf('[');
  const name = ib < 0 ? test : test.slice(0, ib);
  const tag = name === '*' ? '*' : name.toLowerCase();
  const preds: string[] = [];
  if (ib >= 0) {
    let depth = 0, start = ib + 1, quote: string | null = null;
    for (let k = ib; k <= test.length; k++) {
      const c = test[k];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '[') { if (depth === 0) start = k + 1; depth++; }
      else if (c === ']') { depth--; if (depth === 0) preds.push(test.slice(start, k)); }
    }
  }
  return { tag, preds };
}

/** 不含 `//` 的快速路径:对 document + 各 shadowRoot 顶层子元素各求值一次,按文档序取首个命中。 */
function fastPathEval(xp: string): XpathEvalResult {
  const ctxs = shadowContexts();
  const seen = new Set<Element>();
  const matched: Element[] = [];
  for (const root of ctxs) {
    let r: XPathResult;
    try { r = document.evaluate(xp, root, null, XPATH_FIRST, null); }
    catch { continue; }
    const node = r.singleNodeValue as Element | null;
    if (node && node.nodeType === 1 && !seen.has(node)) { seen.add(node); matched.push(node); }
  }
  const trace: XpStepInfo[] = [{ text: xp, axis: 'child', input: ctxs.length, matched: matched.length }];
  return { ok: matched.length > 0, count: matched.length, nodes: matched, trace };
}

/** 跨 shadow 连续路径求值:逐位置步求值,`/`=拼接子、`//`=拼接子孙,支持任意混合与 `[n]`/谓词,产出分步诊断。 */
function crossShadowEval(xp: string): XpathEvalResult {
  const steps = tokenizeSteps(xp);
  if (!steps.length) return { ok: false, count: 0, nodes: [], trace: [] };
  let nodes: ParentNode[] = [document];
  const trace: XpStepInfo[] = [];
  for (const s of steps) {
    const input = nodes.length;
    const matched = stepMatches(nodes, s);
    let sample: string | undefined;
    if (!matched.length && nodes.length) {
      const first = nodes[0] as Element;
      sample = first.tagName ? first.tagName.toLowerCase() : '';
    }
    trace.push({ text: s.text, axis: s.axis, input, matched: matched.length, sample });
    nodes = matched;
    if (!matched.length) break;
  }
  return { ok: nodes.length > 0, count: nodes.length, nodes: nodes as Element[], trace };
}

/** 用 shadow 穿透 xpath 求全部命中 + 分步诊断。含 `//` 走分步引擎,否则快速路径。 */
export function xpathEval(xp: string): XpathEvalResult {
  return xp.includes('//') ? crossShadowEval(xp) : fastPathEval(xp);
}

/** 用 shadow 穿透 xpath 求第一个元素命中;无命中返回 null。 */
export function xpathRoot(xp: string): Element | null {
  return xpathEval(xp).nodes[0] ?? null;
}

/**
 * 求建树根元素:selector 优先,其次 xpath,缺省 body。
 * selector/xpath 均未命中返回 null(由调用方决定是否报错)。
 */
export function findRoot(selector?: string, xpath?: string): Element | null {
  if (selector) return document.querySelector(selector);
  if (xpath) return xpathRoot(xpath);
  return document.body;
}
