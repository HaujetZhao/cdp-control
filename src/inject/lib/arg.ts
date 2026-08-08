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

/** tree:rootExpr 是解析建树根元素的 JS 表达式串(如 `document.querySelector(...)` / xpath 求值 IIFE)。 */
export interface TreeArgs { rootExpr: string }

/** read:控制台日志过滤(level 数组;since 毫秒时间戳)。 */
export interface ReadArgs { level?: string[]; since?: number }
