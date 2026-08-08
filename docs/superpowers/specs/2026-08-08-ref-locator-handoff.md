# Ref 句柄定位 — 阶段2 交接文档

> **交接对象**:下一个独立会话(新 context)。只读本文件 + 项目 `CLAUDE.md` 即可开工。
> **日期**:2026-08-08。**分支**:阶段2 请新开 branch(项目约定:重构/新功能在新 branch 做,分阶段提交,验证后 merge 到 main)。
> **状态**:设计方向已与用户对齐,未实现。

---

## 1. 背景:为什么做 ref(阶段1 的教训)

本 skill 的定位是**服务 agent 高效读网页**。感知靠 `tree`(唯一感知命令,递归穿透所有 shadow DOM),定位靠 `xpath`。

阶段1(fontoxpath 引擎,已完成)把 xpath 做对了:换 fontoxpath(XPath 3.1)+ 修掉四个坑(括号崩溃、shadow 宿主文本空、CSS/JS 污染、`//x[1]` 语义),并在 B 站大页面实测不再卡死。

**但阶段1 留下一个本质问题没解决**:agent 要精确定位 shadow 内元素,仍得**手写 XPath + 反推父链**。这正是阶段1 那四个坑的共同根源——"让 agent 为了定位 shadow 内元素去学 XPath"这个约束本身。fontoxpath 只是让"写 XPath"这件事做对了,**没有让 agent 不写 XPath**。

**ref 句柄的目标**:砍掉"agent 手写 XPath"这一层,让 agent 从 tree 输出直接拿到可操作句柄,零定位负担。

---

## 2. 核心洞察

`tree` **已经**递归穿透所有 shadow 并输出了完整结构。也就是说,"穿透 shadow"这件事浏览器做不了、但 tree 已经做到了。

那就不该让 agent 在穿透后的世界里用 XPath 二次定位。**改为:tree 遍历时给每个可操作节点登记一个引用(ref),输出标注,agent 直接操作 ref。**

这绕开了 selector/XPath 对 shadow 的全部限制——因为操作的是**真实元素引用**,不是字符串选择器。

---

## 3. 方案设计(核心机制)

### 3.1 三件套:登记 → 标注 → 操作

1. **登记**:`tree` 遍历整页(含 shadow)时,把每个"可操作节点"push 进页面全局数组 `window.__cdpRefs`,记下它的 index。
2. **标注**:tree 输出里,该节点对应文本项追加标注 `[ref=i]`。
3. **操作**:agent 看到 `[ref=i]` 直接说"操作 ref=i",skill 用 `window.__cdpRefs[i]` 拿**真实元素引用**执行 click/fill/读取——绕开选择器字符串对 shadow 的所有限制。

### 3.2 什么算"可操作节点"(粒度)

参考 `tree.ts` 现有的 `simplify()` 判断,候选:

- **有直接文本的 content 节点**(`isContent` 为 true,即 `text` 非空)——文本叶/文本块,如评论文本、标题。
- **可交互节点**(`inter` 为 true)——`button/a/input/textarea/select`,或 `onclick`/`tabindex`/`role=button`。

**粒度取舍(需新上下文定夺)**:整页每个有文本的节点都标 ref 会噪。建议:
- 默认只对"叶子/可操作"标(有直接文本 或 可交互),不标纯包装节点。
- 可考虑上限(如整页最多 N 个 ref)防 `__cdpRefs` 无限膨胀。
- 交互节点优先(agent 最常要"点")。

### 3.3 生命周期/持久性(重要)

- `__cdpRefs` 存在页面 `window` 上,**页面刷新即失效**。
- SKILL.md 已强调"自动化写成脚本一次执行"。所以 **同一脚本回合内 tree(拿 ref)→ 操作** 是稳的。
- 跨命令/刷新/动态加载后 ref 序号漂移,是**预期**行为,文档要写清楚,agent 应"每回合先 tree 再操作"。
- ref 是**会话内句柄**,不适合跨会话记忆(和"记录 selector"同理会漂)。

### 3.4 与 XPath 共存(不互相替代)

| 场景 | 用 |
|---|---|
| 交互式点选(感知 tree → 定位 → 操作单个) | **ref**(零 XPath) |
| 批量/精确查询(取所有作者、第 N 条、正则匹配) | **XPath**(阶段1 fontoxpath 已就绪) |

两者互补,ref 是主路径, XPath 兜底复杂查询。**不要删 XPath**,保留阶段1 成果。

---

## 4. 具体改动点(以现有代码为准)

### 4.1 `src/inject/tree.ts` — 登记 ref

- `simplify()` 构建 `TreeNode` 时,对满足"可操作"条件的节点(见 3.2):
  - `const ref = __cdpRefs.length; __cdpRefs.push(el); node.ref = ref;`
  - 在入口处先 `if (!window.__cdpRefs) window.__cdpRefs = [];`(幂等,防止重复注入时重登)。
- `TreeNode` 类型加 `ref?: number` 字段(定义在 `tree-format.ts`)。
- ⚠️ 只对**真实可定位/可操作**节点登记。注意 `simplify` 遍历的是 `Element | ShadowRoot`,`ShadowRoot` 不能登记(它没有操作意义),只登记 `Element`。

### 4.2 `src/inject/lib/tree-format.ts` — 输出标注

- `formatTree()` 在输出文本项时,若节点有 `ref`,追加 `[ref=i]`(如 `p "评论文本" [ref=12]`)。
- 注意标注要加在**有内容的那一行**(叶子),别标到折叠的包装节点行(否则 agent 拿到的是包装节点而非可操作叶)。

### 4.3 操作命令支持 ref(核心)

- `src/inject/click.ts` / `fill.ts` / `focus.ts` / `hover.ts` / 读取:参数支持 `ref:i`(或独立 `ref` 命令)。
- 实现:`__CDP_ARG__` 里带 `ref` 序号时,注入侧直接 `window.__cdpRefs[ref]` 取真实元素 → 操作。**这是绕开 shadow 限制的关键**:不生成 selector 字符串,直接拿元素引用。
- `src/inject/lib/arg.ts`:各入口的参数类型加 `ref?: number`。
- `src/api.ts`:`cdp.click(target, 'ref:12')` / `cdp.click(target, {ref:12})` 等,透传。
- `src/cdp.ts`(CLI):参数解析支持 `--ref 12` 或位置参数。

### 4.4 文档同步

- `SKILL.md`:树输出加 `[ref=i]` 说明 + agent 操作 ref 的用法 + 生命周期限制(刷新失效/回合内有效)。

---

## 5. 验收标准(怎么算完成)

1. 在 B 站(或含大量 shadow 的页面)实测:`tree` 输出某评论文本项带 `[ref=i]`。
2. `click`/`fill` 支持 `ref=i`,能对该真实元素生效——**含 shadow 内元素**(之前 click 的 CSS selector 穿不透 shadow)。
3. agent 走通"tree → 看到 [ref=i] → 操作 ref=i"全程**零 XPath**。
4. 阶段1 的 XPath 功能不回归(批量查询仍可用,52 单测过)。
5. 树输出不因 ref 过度膨胀(粒度控制合理)。

---

## 6. 项目约定提醒(务必遵守)

- **中文**:注释、commit、文档全中文。commit 不加 `Co-Authored-By` 署名。
- **分支**:新开 branch 做,分阶段提交,验证后 merge 到 main。不保留向后兼容,过时的直接删。
- **最简实现**:不预防性抽象。ref 的粒度/格式/上限用最简单能满足的方案。
- **构建**:`npm install`(fontoxpath 已在依赖)、`npm run build`、`npm test`(零依赖单测)。
- **浏览器实测**:按项目约定,注入侧 DOM 逻辑靠浏览器实测验收(CDP 端口 9222),不写单测;纯函数(如 formatTree 的 ref 标注、arg 解析)可单测。
- **UI 主观体验验收由用户本人**,agent 只做客观断言(机械核对)。

---

## 7. 阶段1 现状(已完成,作基础参考)

分支 `feat/fontoxpath-xpath`,以下已提交并验证:

- `7f0d91c` 换 fontoxpath(XPath 3.1)直接跑真实 DOM,domFacade 穿透 shadow。
- `a357aeb` 修 normalizeXpath 的 `(`/函数/字面量前缀 + count 标量用 ANY——括号表达式 6s→30ms(B 站卡死根因)。
- `5b226de` + `bbfca26` 坑2 shadow-aware 文本(命中 shadow 宿主 text 非空、跳过 CSS)。
- 52 单测通过;B 站大页面实测核心操作 60-110ms、ancestor 索引 2.3s,不再卡死。

阶段2 基于以上,新开 branch,不要动阶段1 的 fontoxpath 引擎(除非 ref 方案需要,见 3.4 共存)。

---

## 8. 已知坑/注意(从阶段1 学到的教训,ref 要规避)

- **ref 序号漂移**:动态加载/刷新后 `__cdpRefs` 重置或序号变化。文档写清"每回合先 tree 再操作",不做跨回合承诺。
- **数组膨胀**:整页节点多时 `__cdpRefs` 会大。控制粒度(只标叶子/可交互)+ 可选上限。
- **ShadowRoot 不可登记**:只对 `Element` 登记,`ShadowRoot`(nodeType 11)没有可操作性。
- **标注别标错行**:`[ref=i]` 只标在可操作叶子的内容行,别标到折叠包装节点(否则 ref 指向包装节点而非可操作叶)。
- **与 XPath 共存而非替代**:保留阶段1 能力,ref 解决"交互点选",XPath 兜底"批量/精确查询"。
