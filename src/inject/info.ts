/**
 * info.ts — info 透视注入入口:列目标元素(爬 ancestor 后)从 <html> 到自身的祖先链。
 * 每层紧凑显示 tag/id/class/语义 data-* /aria-label/role,让 agent 一眼挑出稳定锚点
 * 自己写 `fold add` 这种 uBlock 式短规则(如 `###biliMainHeader` 折 B站顶栏),
 * 而非只靠 genSel 猜一个。另附 genSel(el) 的建议 selector 作参考。
 *
 * 设计意图:genSel 已能生成 selector,但有时它选的不是 agent 想要的"语义锚点"
 * (比如挑了某个 data-v-xxx 而非更稳的 #id)。info 把整条祖先链信息摊开,
 * 决策权交还 agent —— 它看清 #biliMainHeader 在第 3 层,直接 `fold add www.bilibili.com #biliMainHeader 顶栏`。
 */
import { setResult } from './lib/result';
import { refElement, climbAncestors } from './lib/find-root';
import { genSel } from './lib/genSel';
import { notFoundResult, type OperableArg } from './lib/find';
import type { InfoArgs } from './lib/arg';

declare const __CDP_ARG__: InfoArgs;

/** 语义化 data-* 属性名(与 genSel 对齐:这些优先于泛化 data-*)。 */
const SEMANTIC_DATA = [
  'data-testid', 'data-test', 'data-cy', 'data-qa',
  'data-role', 'data-type', 'data-component', 'data-name',
  'data-za-extra-module', 'data-za-module', // 知乎/通用埋点模块名
];

/** class 列表截断阈值(太长的 utility class 列表对挑锚点无信息量)。 */
const MAX_CLASS_LEN = 80;

/** 提取一层的紧凑描述(纯 DOM 读,无副作用)。 */
function describe(el: Element): {
  tag: string; id?: string; classes?: string[]; dataAttrs?: Record<string, string>;
  aria?: string; role?: string;
} {
  const tag = el.tagName.toLowerCase();
  const out: any = { tag };
  if (el.id) out.id = el.id;
  const classList = (el as any).classList;
  if (classList && classList.length) {
    // 原样保留顺序;过长截断标 …
    const all = Array.from(classList as Iterable<string>);
    const joined = all.join(' ');
    out.classes = joined.length > MAX_CLASS_LEN ? joined.slice(0, MAX_CLASS_LEN) + '…' : all;
  }
  const attrs = (el as any).attributes;
  if (attrs) {
    const data: Record<string, string> = {};
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (SEMANTIC_DATA.includes(a.name) && a.value) data[a.name] = a.value;
    }
    if (Object.keys(data).length) out.dataAttrs = data;
  }
  const aria = el.getAttribute('aria-label');
  if (aria) out.aria = aria;
  const role = el.getAttribute('role');
  if (role) out.role = role;
  return out;
}

(() => {
  const base = refElement(__CDP_ARG__.ref);
  if (!base) return setResult(notFoundResult({ ref: __CDP_ARG__.ref } as OperableArg));
  const el = climbAncestors(base, __CDP_ARG__.ancestor || 0);
  if (!el) return setResult({ ok: false, err: `ref=${__CDP_ARG__.ref} 向上爬 ${__CDP_ARG__.ancestor || 0} 层后无元素` });

  // 从 el 沿 parentElement 收集到 documentElement(html),反转成根→叶顺序。
  const chain: Element[] = [];
  let cur: Element | null = el;
  let guard = 0;
  while (cur && cur.nodeType === 1 && guard++ < 9999) {
    chain.unshift(cur);
    if (cur === cur.ownerDocument?.documentElement) break;
    cur = cur.parentElement;
  }

  const depthStart = 0; // html = depth 0
  const result = {
    ok: true,
    chain: chain.map((e, i) => ({ depth: depthStart + i, ...describe(e) })),
    targetDepth: chain.length - 1,
    suggested: genSel(el),
  };
  return setResult(result);
})();
