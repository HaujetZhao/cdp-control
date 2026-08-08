/**
 * arg.ts — 注入脚本的参数类型契约。
 *
 * 每个注入入口用自由标识符 `__CDP_ARG__`(TS 里 `declare const`)读取参数;
 * Node 侧注入前拼一行 `var __CDP_ARG__ = <json>;`(见 src/inject-loader.ts)。
 * 各入口按需声明自己的参数形状。
 */

/** click/focus:按 selector 定位并操作。 */
export interface FindArgs { sel: string }

/** fill:按 selector 填值。 */
export interface FillArgs { sel: string; value: string }

/** tree:按 selector / xpath 求建树根元素(注入侧 findRoot 解析,含 shadow 穿透)。 */
export interface TreeArgs { selector?: string; xpath?: string }

/** xpath:按 xpath 查元素(注入侧 xpathEval 解析,含 shadow 穿透)。 */
export interface XpathArgs { path: string }

/** read:控制台日志过滤(level 数组;since 毫秒时间戳)。 */
export interface ReadArgs { level?: string[]; since?: number }
