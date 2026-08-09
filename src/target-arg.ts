/**
 * target-arg.ts — 操作目标参数归一化(纯函数,零运行时依赖,可单测)。
 *
 * 抽离自 api.ts:click/fill/focus/hover 的目标参数可能是 selector 字符串或 {ref,ancestor?} 对象,
 * normArg 把它们归一化为注入侧 {sel?}/{ref?} 形态。防呆逻辑也在此(字符串形态的 "{ref:N}" 抛友好错误)。
 *
 * 为什么独立模块:normArg 是纯函数,而 api.ts 顶部 import 一堆运行时模块(transport/monitor/folds),
 * 直接 import api.ts 做单测会拽出整条 Node 侧依赖链(且源码无扩展名 import 在 --experimental-strip-types
 * 下解析失败)。抽成独立模块让单测零依赖、聚焦防呆正则。
 */

/** 操作目标:selector 字符串,或 {ref:n, ancestor?} 用 view 登记的引用序号(穿透 shadow,可选爬父)。 */
export type TargetArg = string | { ref: number; ancestor?: number };

/** 字符串形态的 \"{ref:N}\" 防呆正则:CLI 误用对象字面量当 selector(querySelector 会抛原生 CSS 异常)。 */
const RE_REF_LITERAL = /^\{[\s\S]*ref[\s\S]*\}$/;

/**
 * 归一化操作目标为注入侧参数:字符串→{sel},对象→{ref}。
 * 防呆:字符串形如 \"{ref:80}\"(对象字面量当 selector 字符串误用,CLI 应传数字 80 而非 click \"{ref:80}\")
 * 直接抛友好错误,不让 querySelector 抛原生 CSS 异常暴露内部栈。
 */
export function normArg(a: TargetArg): { sel?: string; ref?: number } {
  if (typeof a === 'string' && RE_REF_LITERAL.test(a)) {
    throw new Error('CLI 直接传数字(如 80),脚本 API 才用 {ref:N};你传的是对象字面量字符串: ' + a);
  }
  return typeof a === 'string' ? { sel: a } : a;
}
