/**
 * find-root.ts — 从 selector / xpath 求建树根元素(注入侧,无 Node 依赖)。
 * 被 tree 入口复用。xpath 用「合成拼接树 + 原生 evaluate」激进重做。
 *
 * —— 为什么重做 ——
 * 原生 document.evaluate 有两个无法绕开的限制:①shadowRoot(DocumentFragment)
 * 不能作 context 节点;②`//` 轴不跨 shadow 边界。旧实现因此手写分词 + 逐层遍历 +
 * 手算 `[n]`/`siblingPos`,脆弱且缺轴支持(还出过 XPATH_BOOL 常量错)。
 * 新实现把页面「合成」成一棵**没有 shadow 的拼接树**:shadowRoot 顶层子元素直接
 * 拼进宿主,整棵镜像进一个独立 detached Document,然后用户路径**整条**交给原生
 * document.evaluate 在这棵树上跑——轴/谓词/`[n]`/函数全部由浏览器标准 XPath 引擎
 * 实现,命中的合成节点再经 WeakMap 映射回真实元素。于是 parent::/ancestor:: 等
 * 一切标准轴免费可用,谓词/索引语义原生正确,手写引擎整层删除。
 *
 * —— 可测性 ——
 * 纯字符串逻辑(normalize / splitAxis)可单测;合成树物化 + 原生求值 + 映射依赖
 * 真实 DOM 全局 `document`,按项目约定靠浏览器实测验收。
 */

// XPathResult.ORDERED_NODE_SNAPSHOT_TYPE
const XPATH_SNAPSHOT = 7;

/** 分步诊断信息。input=上一步命中的数量;matched=本步命中数;sample=断在该步时上一步命中的标签摘要。 */
export interface XpStepInfo { text: string; axis: 'child' | 'desc'; input: number; matched: number; sample?: string }

/** xpath 求值结果:全部命中(真实元素)+ 分步诊断。 */
export interface XpathEvalResult {
  ok: boolean;
  count: number;
  nodes: Element[];
  trace: XpStepInfo[];
}

/** 合成拼接树:独立 detached Document 里,shadowRoot 顶层子拼进宿主,无 shadow 隔离。 */
interface ComposedBuild {
  sd: Document;
  mapEl: WeakMap<Element, Element>;    // 合成元素 → 真实元素
  mapText: WeakMap<Text, Text>;        // 合成文本节点 → 真实文本节点
}

/** 把真实 document 镜像成合成 Document:light 子 + shadowRoot 顶层子拼进宿主,逐层递归。 */
function buildComposed(): ComposedBuild {
  const sd = document.implementation.createHTMLDocument('');
  const mapEl = new WeakMap<Element, Element>();
  const mapText = new WeakMap<Text, Text>();
  const root = sd.documentElement!;
  mapEl.set(root, document.documentElement!); // 复用的 html 容器也登记映射(否则 /html 命中会被丢弃)
  while (root.firstChild) root.removeChild(root.firstChild); // 清掉默认 head/body
  const mirror = (real: Node, synParent: Element): void => {
    const kids: Node[] = [];
    for (const c of Array.from(real.childNodes)) kids.push(c);
    if (real.nodeType === 1 && (real as Element).shadowRoot)
      for (const c of Array.from((real as Element).shadowRoot!.childNodes)) kids.push(c);
    for (const c of kids) {
      if (c.nodeType === 1) {
        const el = sd.createElement((c as Element).tagName.toLowerCase());
        for (const a of Array.from((c as Element).attributes)) el.setAttribute(a.name, a.value);
        mapEl.set(el, c as Element);
        synParent.appendChild(el);
        mirror(c, el);
      } else if (c.nodeType === 3) {
        const t = sd.createTextNode(c.nodeValue ?? '');
        mapText.set(t, c as Text);
        synParent.appendChild(t);
      }
      // 其余节点类型(注释等)忽略
    }
  };
  mirror(document.documentElement!, root);
  return { sd, mapEl, mapText };
}

/** 路径规范化:无前置斜杠的当作 descendant 搜索(与旧引擎相对路径默认 desc 一致)。 */
export function normalizeXpath(xp: string): string {
  return xp.startsWith('/') ? xp : '//' + xp;
}

/** 把路径按顶层 `/`/`//` 切成 (axis, step) 序列;跳过 [] 与引号内的 `/`,支持嵌套括号。纯字符串,可单测。 */
export function splitAxis(xp: string): { axis: 'child' | 'desc'; step: string }[] {
  const out: { axis: 'child' | 'desc'; step: string }[] = [];
  let i = 0;
  const n = xp.length;
  while (i < n) {
    if (xp[i] === '/') {
      const axis: 'child' | 'desc' = xp[i + 1] === '/' ? 'desc' : 'child';
      i += axis === 'desc' ? 2 : 1;
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
      out.push({ axis, step: xp.slice(i, j) });
      i = j;
    } else {
      out.push({ axis: 'desc', step: xp.slice(i) });
      break;
    }
  }
  return out;
}

/** 在合成树上原生求值整条路径,命中节点映射回真实元素(文本节点归到其父元素)。 */
function evalComposed(normalized: string, b: ComposedBuild): Element[] {
  const res = b.sd.evaluate(normalized, b.sd, null, XPATH_SNAPSHOT, null) as XPathResult;
  const out: Element[] = [];
  for (let i = 0; i < res.snapshotLength; i++) {
    const syn = res.snapshotItem(i) as Node;
    let real: Element | null = null;
    if (syn.nodeType === 1) real = b.mapEl.get(syn as Element) ?? null;
    else if (syn.nodeType === 3) real = (b.mapText.get(syn as Text)?.parentNode as Element) ?? null;
    if (real && !out.includes(real)) out.push(real);
  }
  return out;
}

/** 分步诊断:逐前缀原生求值,报告每步输入/命中,断链处给出上一步命中标签。 */
function buildTrace(normalized: string, b: ComposedBuild): XpStepInfo[] {
  const segs = splitAxis(normalized);
  const trace: XpStepInfo[] = [];
  let input = 1; // 首步输入=文档根
  let prevTag: string | undefined;
  for (let i = 0; i < segs.length; i++) {
    const prefix = segs.slice(0, i + 1).map(s => (s.axis === 'desc' ? '//' : '/') + s.step).join('');
    const nodes = evalComposed(prefix, b);
    const matched = nodes.length;
    trace.push({ text: segs[i].step, axis: segs[i].axis, input, matched, sample: matched ? undefined : prevTag });
    if (matched === 0) break;
    input = matched;
    prevTag = nodes[0]?.tagName.toLowerCase();
  }
  return trace;
}

/** 用合成拼接树求全部命中 + 分步诊断。 */
export function xpathEval(xp: string): XpathEvalResult {
  const normalized = normalizeXpath(xp);
  const b = buildComposed();
  const nodes = evalComposed(normalized, b);
  const trace = buildTrace(normalized, b);
  return { ok: nodes.length > 0, count: nodes.length, nodes, trace };
}

/** 用合成拼接树求第一个元素命中;无命中返回 null。 */
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
