# 设计:agent 的"视力"增强(view 几何视图)+ 站点脚本库(sites/)

日期:2026-08-07

## 背景:为什么 agent 会"盲人摸象"

agent 现在看页面只有 4 个原语,都不像人眼:

- `snapshot`:扁平的可交互元素清单(≤300),**只取"可交互且有文字"**——评论正文这类纯文本块进不了清单,纯 `<span>`/文本节点的回复者用户名也不会出现。
- `content`:删掉 `nav/footer/form/button/a` 后拍平成文本,**丢层级、丢按钮链接、丢"评论嵌套在谁下面"**。
- `outline`:只有 h1-h6 + 导航链接。
- **没有 z-index/堆叠顺序/视口过滤**:agent 无法知道"现在有个 modal 盖在页面上"、"评论在弹窗里而非正文"。

根因:agent 拿到的是"**操作导向清单**",不是"**结构 + 堆叠 + 视口**的语义视图"。

## 目标(用户澄清后)

- **结合形态,但几何先行、语义随后,一步步来**:先做几何视图,后续再做无障碍树(AX)语义叠加。
- **视口优先**:只报"当前屏幕上看得见的"。
- **全块按堆叠从顶到底排序 + z 字段 + rect**。
- **叶子文本块**:含全部可见文本(子节点用户名/正文/时间都不漏)。
- **脚本库**:skill 内 `sites/<域名>/` 目录、单用途原语、每站 README 导航、验证→失效更新/删。

---

## 第一部分 · 几何视图 `view`

### 入口
- CLI 子命令 `view [--target <匹配>]`
- 脚本 API `cdp.view(target, opts?)`
- 复用现有 `evaluate` 管线 + `GEN_SEL`,新增一段注入 JS `VIEW_JS`。

### 注入采集算法(在页面内跑)

1. **候选块**:遍历 DOM,满足其一且**可见**的元素:
   - 可交互(复用现有 selector 集 `a/button/input/.../[role]/[onclick]/[tabindex]`),或
   - 有**直接文本**(自身 childNodes 含非空白文本节点;注释正文/用户名这类叶子),或
   - `IMG`(非空 alt/非 1px 占位)。
   - 剔除:`rect w/h===0`、`display:none`、`visibility:hidden`、`opacity:0`、完全滚出视口。
   - **"直接文本"而非"后代文本"** 是防父容器重复包后代的关键:feed 容器只有元素子节点、无直接文本 → 不入选;评论项 `<div>` 有直接正文文本 → 入选。

2. **视口过滤**:只保留与视口相交(±15% 余量)的块。完全屏外排除 → 满足"视口优先"。

3. **文本收敛**:块取 `innerText`(含后代全部文本,截断 ~120 字符)+ 备用 `value/aria-label/placeholder`。带 `role`/`name`(aria)作为廉价语义提示,为语义阶段铺路。

4. **堆叠排序**(全块从顶到底):
   - 有效 z = 沿"堆叠上下文链"累加——自 z-index + 每个**定位(pos 非 static)且 z-index 非 auto** 的祖先的 z-index(近似)。
   - 同 z 按 DOM 序 tie-break;降序输出 → **弹窗块自然在最前**。
   - ⚠️ **已知局限**:真实堆叠上下文(含 `mix-blend-mode/filter/contain/transform`)难完全精确,这是启发式近似,用于判断相对前后关系,不保证像素级严格。语义阶段(AX)可修正。

5. **遮挡标注**:某块被更高 z 且完全覆盖其中心点的块遮住 → `occluded: true`(agent 知道"这在弹窗后面,看不到/点不到")。默认开,可 `{occluded:false}` 关。

### 输出 shape(默认顶到底、截断 100 块,截断处标 `truncated`)
```json
[
  { "kind": "text|interactive|image", "text": "评论正文…", "tag": "div",
    "role": "comment", "name": "…",
    "rect": {"x":..,"y":..,"w":..,"h":..}, "z": 12, "occluded": false,
    "selector": "#root > .modal > .comment-item:nth-of-type(1)" }
]
```

### 与现有命令关系
- `snapshot` 保留(操作导向、干净 selector);`view` 新增(感知导向、结构 + 堆叠)。
- `content`/`outline` 保留;`view` 是补强,不是替代。

---

## 第二部分(后续阶段 · 只定接口不实现)语义叠加

`view` 的 `role`/`name` 字段先行,后续把 `Accessibility.getFullAXTree` 叠加到同一条注入管线:
- 每块对齐到 AX 节点,补 `role` 语义名、子块层级缩进。
- 修正 z 的近似误差。
接口不变(仍返回 block 数组),阶段切换对上层透明。

---

## 第三部分 · 站点脚本库 `sites/`

### 目录结构
```
sites/
├── README.md            # 总索引:有哪些站、各站 README 指向、原语放置规范
├── zhihu/
│   ├── README.md        # 此站导航:已知结构、可用原语清单、坑、验证状态
│   └── get-comments.js  # 单用途原语,头部注释含元信息
└── _template/
    └── README.md + primitive.js  # 新站点脚手架
```

### 原语放置规范(与现有"脚本写项目根"约定的区分)
- **任务性一次性脚本** → 项目根(现有约定,不变)。
- **可复用站点原语** → 升格进 `sites/<域名>/`(可被新任务直接 `run` 或改参复用)。SKILL.md 据此更新约定。

### 原语自包含(沿用现有约定)
每个原语自己 `cdp.resolve(url/title 子串)` 定位 target,不假设"当前选中页";用 `cdp` 全局 + 白名单 `require`。

### 原语头部注释模板
```js
/**
 * 站点: zhihu.com
 * 用途: 抓取当前问题下全部评论(正文+回复者用户名+点赞)
 * 用法: node cdp.js run sites/zhihu/get-comments.js -- …(或直接 run)
 * 返回: [{author, body, likes, replies: [...]}]
 * 依赖的 DOM 结构假设: 评论在 .CommentList 内,.CommentItem 为项,
 *                     用户名在 .CommentItem-author 下 a,正文在 .CommentItem-content
 * 最后验证: 2026-08-07
 * 状态: ✅ 已验证 / ⚠️ 已知失效待修(写明现象)
 */
```

### 生命周期
- 每次实测**验证通过** → 更新头部"最后验证/状态"。
- **发现失效**(站点改版/selector 变)→ 更新或删除原语,并在站点 README 标记。
- 站点 README 维护一份"可用 / 失效"清单,供 agent 用该站前导航。

---

## 不改的部分
- 现有 `snapshot/content/outline/click/fill/logs/ensure` 等行为不变。
- 单命令与 run 脚本的既有约定不变。
- 几何视图的 z 为启发式近似,不追求像素级堆叠严格性(语义阶段再修正)。
