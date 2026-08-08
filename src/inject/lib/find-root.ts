/**
 * find-root.ts — 从 selector / xpath 求建树根元素(注入侧,无 Node 依赖)。
 * 被 tree 入口复用。xpath 用 fontoxpath(XPath 3.1 引擎)直接跑真实 DOM。
 *
 * —— 为什么换 fontoxpath ——
 * 旧引擎把整页镜像成"无 shadow 的合成树",再交浏览器原生 document.evaluate(XPath 1.0)
 * 求值,靠 WeakMap 映射回真实元素。缺点:每查一次就要克隆整页(detached Document),
 * 克隆有损(丢动态值)、开销大、且原生引擎只支持 XPath 1.0。
 * 新引擎把页面**原样**交给 fontoxpath 求值,只提供一个 shadow 穿透的 IDomFacade:
 * getChildNodes 把 shadowRoot 顶层子拼进宿主(与旧合成树同语义:light 在前、shadow 在后),
 * getParentNode 把 shadowRoot(节点)穿透回宿主——于是 shadow DOM 对 XPath 完全透明,
 * `//` 轴、parent::/ancestor::、谓词、`[n]` 全部由 XPath 3.1 引擎原生实现,且直接返回真实节点,
 * 无需克隆、无需映射。合成树物化那整层删除。
 *
 * —— 可测性 ——
 * 纯字符串逻辑(normalize / splitAxis)可单测;shadow 穿透 facade + fontoxpath 求值依赖
 * 真实 DOM 全局 `document`,按项目约定靠浏览器实测验收。
 */
import * as fontoxpath from 'fontoxpath';
import type { Bucket, IDomFacade, Node as FontoNode } from 'fontoxpath';

const { domFacade: rawFacade, evaluateXPath, evaluateXPathToNodes, ReturnType } = fontoxpath;

/** 分步诊断信息。input=上一步命中的数量;matched=本步命中数;sample=断在该步时上一步命中的标签摘要。 */
export interface XpStepInfo { text: string; axis: 'child' | 'desc'; input: number; matched: number; sample?: string }

/** xpath 求值结果:全部命中(真实元素)+ 可选标量值 + 分步诊断。 */
export interface XpathEvalResult {
  ok: boolean;
  count: number;
  nodes: Element[];
  /** 标量表达式的值(count()/算术/字符串字面量等);节点查询时为 null。 */
  value: number | string | boolean | null;
  trace: XpStepInfo[];
}

/* —— shadow 穿透 IDomFacade:把 shadowRoot 当作透明,child 拼进宿主,parent 穿透回宿主 —— */

/** 节点的展平子列表:light DOM 子 + shadowRoot 顶层子(light 在前),其余委托原样。
 * 参数用 fontoxpath 的极简 Node 类型(仅 nodeType),运行时即真实 DOM 节点,内部 cast 回 DOM Node。 */
function flatKids(n: FontoNode): Node[] {
  const el = n as Node;
  const kids: Node[] = [];
  for (const c of Array.from(el.childNodes)) kids.push(c);
  if (n.nodeType === 1) {
    const sr = (el as Element).shadowRoot;
    if (sr) for (const c of Array.from(sr.childNodes)) kids.push(c);
  }
  return kids;
}

/** 真实父节点:shadowRoot(节点,nodeType 11)内的子节点穿透回宿主,属性归其 ownerElement。 */
function realParent(n: FontoNode): Node | null {
  const el = n as Node;
  return n.nodeType === 2 ? (el as Attr).ownerElement : el.parentNode;
}

/** bucket 匹配,语义与 fontoxpath 默认 facade 的 `type-X` / `name-X` / `type-1-or-type-2` 一致。 */
function hit(bucket: Bucket | null | undefined, n: FontoNode): boolean {
  if (!bucket) return true;
  const t = n.nodeType === 4 ? 3 : n.nodeType;
  const arr: string[] = [];
  if (t === 1 || t === 2) arr.push('type-1-or-type-2', `type-${t}`, `name-${(n as Element).localName}`);
  else arr.push(`type-${t}`);
  return arr.includes(bucket);
}

/** 带 shadow 穿透的 domFacade:仅覆盖节点间遍历(getChildNodes/parent/sibling),
 * 属性与数据获取委托给 fontoxpath 默认 facade。 */
const shadowFacade: IDomFacade = {
  getAllAttributes: (n, b) => rawFacade.getAllAttributes(n, b),
  getAttribute: (n, name) => rawFacade.getAttribute(n, name),
  getChildNodes: (n, b) => flatKids(n).filter(k => hit(b, k)),
  getData: (n) => rawFacade.getData(n),
  getFirstChild: (n, b) => { for (const k of flatKids(n)) if (hit(b, k)) return k; return null; },
  getLastChild: (n, b) => { const k = flatKids(n); for (let i = k.length - 1; i >= 0; i--) if (hit(b, k[i])) return k[i]; return null; },
  getNextSibling: (n, b) => {
    const p = realParent(n); if (!p) return null;
    const k = flatKids(p); for (let j = k.indexOf(n as Node) + 1; j < k.length; j++) if (hit(b, k[j])) return k[j];
    return null;
  },
  getPreviousSibling: (n, b) => {
    const p = realParent(n); if (!p) return null;
    const k = flatKids(p); for (let j = k.indexOf(n as Node) - 1; j >= 0; j--) if (hit(b, k[j])) return k[j];
    return null;
  },
  getParentNode: (n, b) => {
    let p = realParent(n);
    if (p && p.nodeType === 11) { const host = (p as ShadowRoot).host; if (host) p = host; }
    return p && hit(b, p) ? p : null;
  },
};

/* —— 求值 —— */

/** 在真实 DOM 上求值整条路径,用 ANY_TYPE 统一处理节点集与标量:
 * 结果若是数组 = 节点集,归一化为元素(文本节点归到其父元素);否则为标量(count()/算术/字面量)。
 * 任何异常(语法错等)按无命中处理,不让工具崩掉。 */
function evalFonto(normalized: string): { nodes: Element[]; value: number | string | boolean | null } {
  // 先按节点查询:evaluateXPathToNodes 稳定返回节点数组。
  try {
    const nodes = evaluateXPathToNodes(normalized, document, shadowFacade) as Node[];
    const out: Element[] = [];
    for (const n of nodes) {
      const real = n.nodeType === 1 ? (n as Element) : n.nodeType === 3 ? (n as Text).parentElement : null;
      if (real && !out.includes(real)) out.push(real);
    }
    return { nodes: out, value: null };
  } catch {
    // 表达式非节点集(count()/算术/字面量/布尔,如 `//text()="X"`)→ ANY 取标量值。
    try {
      const res = evaluateXPath(normalized, document, shadowFacade, null, ReturnType.ANY, null) as unknown;
      return { nodes: [], value: (typeof res === 'number' || typeof res === 'string' || typeof res === 'boolean') ? res as number | string | boolean : null };
    } catch {
      return { nodes: [], value: null };
    }
  }
}

/** 是否为可逐轴分步的"节点路径":以 `/` 开头的绝对路径,或以标签/通配符开头的相对路径。
 * 括号分组 `(//x)[1]`、函数调用 `count(//x)`、字面量、数字、`$` 变量等都是**完整表达式**而非节点路径,
 * 不该补 `//` 前缀、也不做 splitAxis 分步诊断。 */
function isNodePath(xp: string): boolean {
  if (xp.startsWith('/')) return true;
  if (xp.startsWith('(')) return false;
  if (/^[0-9"'$]/.test(xp)) return false;          // 数字 / 字符串字面量 / 变量
  if (/^[A-Za-z_][\w.-]*\(/.test(xp)) return false; // 函数调用如 count(
  return true;                                      // 标签 / 通配符 / 属性开头的相对路径
}

/** 路径规范化:绝对路径原样;节点路径(相对)补 `//` 当作 descendant 搜索(与旧引擎默认 desc 一致);
 * 完整表达式(括号/函数/字面量)原样。
 * 旧实现只判 `startsWith('/')`,给 `(//x)[1]`/`count(//x)` 补成 `//(//x)[1]`——非法表达式让引擎 O(N²) 慢两个数量级且 count() 加错前缀。 */
export function normalizeXpath(xp: string): string {
  if (xp.startsWith('/') || !isNodePath(xp)) return xp;
  return '//' + xp;
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

/** 分步诊断:逐前缀求值,报告每步输入/命中,断链处给出上一步命中标签。 */
function buildTrace(normalized: string): XpStepInfo[] {
  const segs = splitAxis(normalized);
  const trace: XpStepInfo[] = [];
  let input = 1; // 首步输入=文档根
  let prevTag: string | undefined;
  for (let i = 0; i < segs.length; i++) {
    const prefix = segs.slice(0, i + 1).map(s => (s.axis === 'desc' ? '//' : '/') + s.step).join('');
    const { nodes } = evalFonto(prefix);
    const matched = nodes.length;
    trace.push({ text: segs[i].step, axis: segs[i].axis, input, matched, sample: matched ? undefined : prevTag });
    if (matched === 0) break;
    input = matched;
    prevTag = nodes[0]?.tagName.toLowerCase();
  }
  return trace;
}

/** 用 fontoxpath 求全部命中 + 分步诊断。`(` 开头的完整表达式(括号/函数)非轴序列,单步诊断。 */
export function xpathEval(xp: string): XpathEvalResult {
  const normalized = normalizeXpath(xp);
  const { nodes, value } = evalFonto(normalized);
  const trace = isNodePath(normalized)
    ? buildTrace(normalized)
    : [{ text: normalized, axis: 'desc' as const, input: 1, matched: nodes.length }];
  return { ok: nodes.length > 0 || value !== null, count: nodes.length, nodes, value, trace };
}

/** 用 fontoxpath 求第一个元素命中;无命中返回 null。 */
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

/**
 * 按 tree 输出的 ref 序号取真实元素(ref 存于 window.__cdpRefs,会话句柄)。
 * 页面刷新后 __cdpRefs 随 document 重建而清空,此时返回 null(ref 失效)。
 * tree / locate 共用同一解析:先取 ref 元素,再 climbAncestors 爬到目标容器。
 */
export function refElement(ref: number): Element | null {
  const arr = (globalThis as any).__cdpRefs;
  const el = arr && arr[ref];
  return el && el.nodeType === 1 ? (el as Element) : null;
}

/**
 * 从元素向上爬 ancestor 层父级(默认 0 = 不爬,返回自身)。
 * 用来把"内容叶子的 ref"抬升到"语义区域容器"——纯包装容器本身无 ref,只能从叶子往上爬。
 * 遇无父元素(html 或 shadow 边界)即停。
 */
export function climbAncestors(el: Element | null, ancestor = 0): Element | null {
  let e = el;
  for (let i = 0; i < ancestor; i++) if (e && e.parentElement) e = e.parentElement;
  return e;
}
