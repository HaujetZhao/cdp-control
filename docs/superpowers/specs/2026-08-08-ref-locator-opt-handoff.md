# Ref 句柄定位 — 体验/优化 交接文档(接续踩坑)

> **交接对象**:下一个独立会话(新 context)。只读本文件 + 项目 `CLAUDE.md` 即可开工。
> **日期**:2026-08-08。**分支**:feat/ref-locator 已 merge 到 main(merge commit `177a71d`,--no-ff)。新体验/优化请在**新 branch** 做,分阶段提交,验证后 `git merge --no-ff` 到 main。
> **状态**:ref 主功能已上线并实测通过;以下是待继续踩坑/优化的方向。

---

## 1. 现状(已完成,作为起点)

ref 句柄定位三件套已落地、合并到 main:

- **tree 登记 + 标注**:遍历时给可操作节点(interactive 或有直接文本的 `Element`)push 进 `window.__cdpRefs`,输出 `[ref=i]`。纯包装节点、`ShadowRoot` 不登;每次 tree 重建数组。
- **操作**:click/fill/focus/hover 支持 `{ref:n}`(api)/ `--ref n`(CLI),注入侧 `src/inject/lib/find.ts` 拿 `window.__cdpRefs[i]` **真实元素引用**操作,穿透 shadow、零 XPath。
- **57 单测全绿**;浏览器实测(B站 shadow 评论 + 知乎)通过。

关键文件:`src/inject/tree.ts`(登记)、`src/inject/lib/tree-format.ts`(标注/折叠,`markText` 算 hasText+hasInter)、`src/inject/lib/find.ts`(目标解析)、`tests/tree-format.test.ts`(折叠用例)。

## 2. 已踩坑并修复(别重复踩)

1. **交互/带 ref 节点被内联折叠吞掉标注** → 内联条件排除 `k.inter && k.ref!=null`。
2. **空 input 无文本不输出行、fill 目标不可见** → leafish 分支对 `n.inter` 也输出裸标签行(`input [ref=2]`)。
3. **【最重】含交互子代的纯包装节点被内联折叠** → 知乎评论动作行(回复+点赞按钮)被 `leafText` 只取第一个文本,交互叶 ref 整颗丢失。修复:`TreeNode.hasInter`,markText 顺带算,内联条件加 `!k.hasInter`。真实知乎页验证:评论赞按钮从"全无 ref"→ 18 个出 `[ref=i]`,点击 87→88 生效。

## 3. 待继续踩坑/优化方向(新上下文定夺)

- **B站整页 tree 偏大(1969 行)**:头部导航+相关视频全带 ref,感知成本高。方向:ref 粒度再收敛(只标评论/正文区?)、上限防 `__cdpRefs` 膨胀(spec 提过但没做)、或 tree 分层。
- **纯图标无文本按钮**:虽已输出裸标签行 `button [ref=i]`,但 agent 无法从输出分辨"这是哪个按钮"(无文字标识)。可考虑取 `title`/`aria-label` 补可读性。
- **ref 序号漂移/跨回合失效**:已当预期写进 SKILL.md(每回合先 tree 再操作)。若发现实际更糟(同回合内也漂)再排查。
- **XPath 兜底**仍要手写路径;ref 已主攻交互点选,批量/精确查询留 XPath。是否有必要给 xpath 结果也标 ref 打通"批量→逐个操作"?
- 其它:动态加载后新节点没标 ref、虚拟化回收、`--selector-file` 圈区域时 ref 序号是否与整页一致(若不一致是坑)。

## 4. 验证方法

- **构建/测试**:`npm run build`(tsc + esbuild)、`npm test`(零依赖单测)。
- **浏览器实测(必走 CDP,不用 Playwright)**:端口 9222。当前开着 2 个 tab:B站视频 `BV1mwMc6uEdX`(纯 shadow 评论)、知乎问题页(targetId `BC141EBEECBEFA2AC3F5D076DFC755AC`)。用 `node dist/cdp.js tree --target <id>` 感知 + `click/fill --ref` 操作;**读回用 `eval` 佐证**(计数 +1、aria 变 is-active),别凭感觉。
- 感知页推荐写成 `run` 脚本一次执行(脚本放系统临时目录或项目根,别污染 skill 目录)。

## 5. 项目约定(务必遵守)

- **中文**:注释、commit、文档全中文。commit 不加 `Co-Authored-By` 署名。
- **新 branch 做**,分阶段提交,验证后 `git merge --no-ff` 到 main(保留分叉线)。
- **不保留向后兼容**:过时的直接删,别加兼容层。
- **最简实现**:不预防性抽象。优化以"服务 agent 高效读网页/操作"为唯一目标,激进、以最优为先。
- **UI 主观体验验收由用户本人**(过渡顺不顺、观感),子代理/agent 只做客观断言(机械核对 DOM class/computed style/计数/报错)。
- **浏览器实测走 CDP**(端口 9222),不写注入侧 DOM 单测(靠实测);纯函数(formatTree 折叠、arg 解析)可单测。
