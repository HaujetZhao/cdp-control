/**
 * find-root.ts — 从 selector / xpath 求建树根元素(注入侧,无 Node 依赖)。
 * 被 tree 入口复用。xpath 为 shadow 穿透版:
 *  - 含 `//` 的路径按 Provar 式连续路径解析,每个 `//` 穿越 shadowRoot 边界,
 *    支持 `[n]` 文档序相对索引与 `[contains(...)]` 谓词(谓词复用 document.evaluate)。
 *  - 不含 `//` 的普通路径:document.evaluate 不接受 shadowRoot(DocumentFragment)作上下文,
 *    故对 document + 每个 shadowRoot 的顶层子元素各求值一次,按文档序取第一个命中。
 */

/** 收集 shadow 穿透所需的求值上下文:document + 各 shadowRoot 的顶层子元素,按 DFS 预序(宿主文档序在前)。
 *  document.evaluate 不接受 DocumentFragment(shadowRoot)作 context node,故须取其顶层子元素(Element);
 *  DFS 递归穿透任意层嵌套 shadow。预序保证深层元素也能按文档序取到首个命中。 */
export function shadowContexts(): (Document | Element)[] {
  const ctxs: (Document | Element)[] = [document];
  const seen = new Set<Node>([document]);
  const stack: Node[] = [document];
  while (stack.length) {
    const n = stack.pop()!;
    // shadowRoot(DocumentFragment)的顶层子元素是求值 context(穿透一层 shadow;嵌套 shadow 各自递归)
    if (n instanceof DocumentFragment)
      for (const c of Array.from(n.children)) ctxs.push(c);
    // DFS 预序收集待遍历子(light children + 嵌套 shadowRoot),反转入栈保证文档序
    const kids: Node[] = [];
    if (n instanceof Element && n.shadowRoot) kids.push(n.shadowRoot);
    if (n instanceof Element || n instanceof Document || n instanceof DocumentFragment)
      for (const c of Array.from(n.children)) kids.push(c);
    for (let i = kids.length - 1; i >= 0; i--) { const c = kids[i]; if (!seen.has(c)) { seen.add(c); stack.push(c); } }
  }
  return ctxs;
}

/** 用 shadow 穿透 xpath 求第一个元素命中;无命中返回 null。 */
export function xpathRoot(xp: string): Element | null {
  // Provar 式 `//` 连续路径(跨 shadow):`//a//b[2]//c`,每段 `//` 都允许穿越 shadowRoot 边界。
  // 无 `//` 的普通路径沿用逐 context 求值(快速路径)。
  if (xp.includes('//')) return crossShadowXPath(xp);
  const seen = new Set<Element>();
  for (const root of shadowContexts()) {
    let r: XPathResult;
    try { r = document.evaluate(xp, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); }
    catch { return null; }
    const node = r.singleNodeValue as Element | null;
    if (node && node.nodeType === 1 && !seen.has(node)) { seen.add(node); return node; }
  }
  return null;
}

/** 分步求值:一个位置步,`/`(child)=light 子节点,`//`(desc)=跨 shadow 子孙节点。 */
interface Step { axis: 'child' | 'desc'; tag: string; preds: string[] }

/** 把 xpath 按词法拆成位置步序列(括号内的 `/` 不拆,避免谓词字面量被误切)。 */
function tokenizeSteps(xp: string): Step[] {
  const steps: Step[] = [];
  let axis: 'child' | 'desc' | null = null;
  for (let i = 0; i < xp.length;) {
    const ch = xp[i];
    if (ch === '/') {
      axis = xp[i + 1] === '/' ? 'desc' : 'child';
      i += axis === 'desc' ? 2 : 1;
      continue;
    }
    // 读到下一个顶层 '/' 为止,取 test + 谓词
    let j = i, depth = 0;
    while (j < xp.length && !(xp[j] === '/' && depth === 0)) {
      if (xp[j] === '[') depth++;
      else if (xp[j] === ']') depth--;
      j++;
    }
    const testStr = xp.slice(i, j);
    const { tag, preds } = parseTest(testStr);
    if (tag) steps.push({ axis: axis ?? 'desc', tag, preds });
    axis = null;
    i = j;
  }
  return steps;
}

/** 把 test 拆成 tag 名 + 谓词/索引列表(`ui-input[1]` → tag `ui-input`,preds `['1']`)。 */
function parseTest(test: string): { tag: string; preds: string[] } {
  const ib = test.indexOf('[');
  const tag = (ib < 0 ? test : test.slice(0, ib)).toLowerCase();
  const preds: string[] = [];
  if (ib >= 0) { const re = /\[([^\]]*)\]/g; let m; while ((m = re.exec(test))) preds.push(m[1]); }
  return { tag, preds };
}

/** desc 轴收集:root 的"跨 shadow 扁平子孙-or-self"里 tag 匹配的元素,文档序(light 在前、shadow 依宿主序),去重。 */
function collectCrossShadow(root: ParentNode, tag: string, out: Element[], seen: Set<Element>): void {
  const kids: ParentNode[] = [];
  if (root instanceof Element) {
    if (root.tagName.toLowerCase() === tag && !seen.has(root)) { seen.add(root); out.push(root); }
    for (const c of Array.from(root.children)) kids.push(c); // light 子在前
    if (root.shadowRoot) kids.push(root.shadowRoot);         // shadow 子在后
  } else {
    for (const c of Array.from(root.children)) kids.push(c); // Document / DocumentFragment(shadowRoot)
  }
  for (const k of kids) collectCrossShadow(k, tag, out, seen);
}

/** 应用谓词/索引:`[n]` 按文档序取第 n 个(1 基);其余谓词以元素为 context 用 document.evaluate 求布尔值。 */
function applyPreds(list: Element[], preds: string[]): Element[] {
  let out = list;
  for (const p of preds) {
    if (/^\d+$/.test(p)) {
      const idx = parseInt(p, 10);
      out = idx >= 1 && idx <= out.length ? [out[idx - 1]] : [];
      if (!out.length) break;
    } else {
      out = out.filter(el => {
        try { return document.evaluate(p, el, null, XPathResult.BOOLEAN_TYPE, null).booleanValue; }
        catch { return false; }
      });
    }
  }
  return out;
}

/** 对一个位置步求全部命中:child=light 子节点,desc=跨 shadow 子孙;跨候选去重后应用谓词。 */
function stepMatches(nodes: ParentNode[], step: Step): Element[] {
  const all: Element[] = [];
  const seen = new Set<Element>();
  for (const n of nodes) {
    if (step.axis === 'child') {
      for (const c of Array.from(n.children))
        if (c.tagName.toLowerCase() === step.tag && !seen.has(c)) { seen.add(c); all.push(c); }
    } else {
      collectCrossShadow(n, step.tag, all, seen);
    }
  }
  return applyPreds(all, step.preds);
}

/** 跨 shadow 连续路径求值(Provar 式):逐位置步求值,`/`=light 子、`//`=跨 shadow 子孙,支持任意混合与 `[n]`/谓词。 */
function crossShadowXPath(xp: string): Element | null {
  const steps = tokenizeSteps(xp);
  if (!steps.length) return null;
  let nodes: ParentNode[] = [document];
  for (const s of steps) {
    nodes = stepMatches(nodes, s);
    if (!nodes.length) return null;
  }
  return (nodes[0] as Element) ?? null;
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
