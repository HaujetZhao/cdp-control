/**
 * find-root.ts — 从 selector / xpath 求建树根元素(注入侧,无 Node 依赖)。
 * 被 tree 入口复用。xpath 为 shadow 穿透版:document.evaluate 不接受
 * shadowRoot(DocumentFragment)作上下文,故对 document + 每个 shadowRoot 的
 * 顶层子元素各求值一次,按文档序取第一个元素命中(去重)。
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

/**
 * 求建树根元素:selector 优先,其次 xpath,缺省 body。
 * selector/xpath 均未命中返回 null(由调用方决定是否报错)。
 */
export function findRoot(selector?: string, xpath?: string): Element | null {
  if (selector) return document.querySelector(selector);
  if (xpath) return xpathRoot(xpath);
  return document.body;
}
