/**
 * arg.ts — 注入脚本的参数类型契约。
 *
 * 每个注入入口用自由标识符 `__CDP_ARG__`(TS 里 `declare const`)读取参数;
 * Node 侧注入前拼一行 `var __CDP_ARG__ = <json>;`(见 src/inject-loader.ts)。
 * 各入口按需声明自己的参数形状。
 */

/** click/focus/hover:按 selector 或 ref(真实元素引用,穿透 shadow)定位并操作;ancestor 可选按 ref 定位后爬父。 */
export interface FindArgs { sel?: string; ref?: number; ancestor?: number }

/** fill:按 selector 或 ref 填值;ancestor 可选按 ref 定位后爬父。 */
export interface FillArgs { sel?: string; ref?: number; ancestor?: number; value: string }

/** tree:按 selector / ref 求建树根元素(注入侧 findRoot + refElement/climbAncestors 解析,含 shadow 穿透)。
 * 锚点互斥:ref 优先,其次 selector;缺省 body。ancestor 为统一爬父修饰符(对任一锚点生效)。
 * folds:当前 hostname 命中的持久折叠规则(Node 侧 folds.ts 过滤后传入),buildTree 遇匹配 selector 折叠成一行。 */
export interface FoldItem { selector: string; note: string }
export interface TreeArgs { selector?: string; visibleOnly?: boolean; ref?: number; ancestor?: number; scrollToLoad?: boolean; folds?: FoldItem[] }

/** locate:按 tree 的 ref 序号反查稳定 CSS selector,可选 --ancestor 向上爬 N 层。 */
export interface LocateArgs { ref: number; ancestor?: number }

/** read:控制台日志过滤(level 数组;since 毫秒时间戳)。 */
export interface ReadArgs { level?: string[]; since?: number }

/** fold:会话级临时折叠(ref/ancestor/note 临时折叠;list 列出临时;clear 清空临时)。持久规则(--save)由 Node 侧处理,不经此入口。 */
export interface FoldArgs { ref?: number; ancestor?: number; note?: string; list?: boolean; clear?: boolean }
