/**
 * arg.ts — 注入脚本的参数类型契约。
 *
 * 每个注入入口用自由标识符 `__CDP_ARG__`(TS 里 `declare const`)读取参数;
 * Node 侧注入前拼一行 `var __CDP_ARG__ = <json>;`(见 src/inject-loader.ts)。
 * 各入口按需声明自己的参数形状。
 */

/** click/focus/hover:按 selector 或 ref(真实元素引用,穿透 shadow)定位并操作。 */
export interface FindArgs { sel?: string; ref?: number }

/** fill:按 selector 或 ref 填值。 */
export interface FillArgs { sel?: string; ref?: number; value: string }

/** tree:按 selector / xpath / ref 求建树根元素(注入侧 findRoot + refElement/climbAncestors 解析,含 shadow 穿透)。
 * 三种锚点互斥:ref 优先,其次 selector,最后 xpath;缺省 body。ancestor 为统一爬父修饰符(对任一锚点生效)。 */
export interface TreeArgs { selector?: string; xpath?: string; visibleOnly?: boolean; ref?: number; ancestor?: number }

/** xpath:按 xpath 查元素(注入侧 xpathEval 解析,含 shadow 穿透)。 */
export interface XpathArgs { path: string }

/** locate:按 tree 的 ref 序号反查稳定定位器(selector + xpath),可选 --ancestor 向上爬 N 层。 */
export interface LocateArgs { ref: number; ancestor?: number }

/** read:控制台日志过滤(level 数组;since 毫秒时间戳)。 */
export interface ReadArgs { level?: string[]; since?: number }
