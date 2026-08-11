# 2026-08-11 skill 交付形态与全局 CLI 设计

> 服务对象：DESIGN.md 两条 TODO——「改进目录结构，skill 相关放入项目子文件夹」与「免长路径前缀（改名 / npm / 系统可执行 CLI）」。
> 经三路对抗性子代理审查后收敛。本文档只锁抽象决策，实现细节落 SKILL.md / CLAUDE.md。

## 问题

当前 `~/.claude/skills/cdp-browser-control/` 既是完整软件工程（src/tests/node_modules/build），又是 Claude Code 扫描的 skill（SKILL.md 在根）。两个痛点：

1. **目录结构**：工程与 skill 混在一个目录，开发污染 skills 区，将来移仓、symlink 无清晰边界。
2. **长路径**：SKILL.md 教 agent 用 `node "<本 SKILL 所在目录>/dist/cdp.js"`，超长且依赖"skill 目录 == 工程根"的巧合。

## 决策

1. **命名**：包名与 bin 命令统一 `cdp-control`（无 scope，npm 实测可用）。skill symlink 名同名。
2. **运行时数据归用户目录**：数据 home 统一 `~/.cdp-control/`，下分 `user-data/`（浏览器数据）与 `rules/`（持久化规则）。`rulesDir()` 默认改 `join(homedir(), '.cdp-control', 'rules')`，浏览器用户数据从 `~/.cdp-browser` 统一到 `join(homedir(), '.cdp-control', 'user-data')`。用户数据与作者仓库彻底解耦——本地 dev、symlink、publish 全局装三场景都不写只读/共享的 node_modules 或 git 工作树。`CDP_RULES_DIR` / `CDP_USER_DATA` 仍可覆盖（测试已依赖，免疫）。
3. **skills/ 聚合目录 + 极薄 skill**：根下建 `skills/`，`skills/cdp-control/` 里放 SKILL.md；`skills/` 可再放其它相关 skill。symlink 目标是整个 `skills/cdp-control/` 文件夹。recipes（`src/rules/recipes/`，`__dirname` 定位的工程内容）与 sites/（cwd 定位的 run 用法）**留工程**——对抗审查证明它们技术上挪不进 skill/。

## 目标结构

```
<repo>  工程（将来移出 skills 区；含 .git）
├── skills/
│   └── cdp-control/SKILL.md   # 极薄 skill；symlink 目标（~/.claude/skills/cdp-control → 此文件夹）
├── src/rules/            # 默认规则 + recipes（入库，publish 随包）
├── sites/                # 站点原语（cwd 定位）
├── src/ dist/ tests/ package.json ...
（运行时数据移出仓库 → ~/.cdp-control/{user-data,rules}，gitignore 相应清理）
```

## 运行时数据定位

- `rulesDir()` → `~/.cdp-control/rules`。seed-once（`src/rules-store.ts ensureRules`）仍从 `src/rules/` 拷默认，目标改为数据 home，`mkdirSync` 自动建。
- 浏览器用户数据 `browser.ts` 从 `~/.cdp-browser` 统一到 `~/.cdp-control/user-data`（`CDP_USER_DATA` 仍可覆盖）。

## 全局 CLI

- package.json 加 `"bin": {"cdp-control": "./dist/cdp.js"}`。
- `build.mjs` 只给 cdp bundle 那次 build 加 `banner: {js:'#!/usr/bin/env node'}`（shebang 必须进构建，dist 每次重建覆盖；勿配到 standalone/inject 产物）。
- `npm link` 全局装。SKILL.md 全部 `node "<本 SKILL 所在目录>/dist/cdp.js"` 调用改 `cdp-control`。

## 将来 publish 预留（本阶段不发布）

- `files: ["dist", "src/rules"]`：publish 打包看 files 不看 .gitignore，ship dist + recipes + 默认规则，否则全局装站点摘要静默失效、seed 缺失。
- 本阶段保留 `"private": true` 防误发；npm link 不看 private，正常。将来翻 private 后 `npm publish`。

## 迁移

- 现有 `rules/fold.csv`、`rules/ignore-links.csv`（用户数据）一次性搬到 `~/.cdp-control/rules/`（seed-once 只在缺文件时拷，不会自动挪）。
- 浏览器 profile：`~/.cdp-browser` 已有数据则迁到 `~/.cdp-control/user-data/`（保留登录态）；无数据则新默认即可。
- `.gitignore` 清理 `/rules/`（仓库不再有运行时 rules）。

## 边界 / 已知

- **过渡态**：SKILL.md 移出根后，`~/.claude/skills/cdp-browser-control`（老名根）不再是有效 skill，静默从列表消失，直到用户做 symlink。这是用户计划的临时态。
- **老 skill 名**：`cdp-browser-control` 废弃，改用 `cdp-control`。
- **分阶段迭代**：数据归用户目录 → skills/ 聚合 + 薄壳 skill → 全局 CLI → publish 预留 → 文档，逐步提交，最后 merge 到 main。
