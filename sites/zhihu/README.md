# 知乎 zhihu.com

## 已知结构

- 评论: 展开"评论"后,评论项以 `.CommentItem` 呈现;用户名在 `.CommentItem` 下 `<a>`;正文在 `.CommentItem-content`。
- 反爬: 未登录/频繁访问会出验证码,agent 卡住时请用户在当前可见窗口处理。

## 可复用原语

| 原语 | 用途 | 状态 |
|---|---|---|
| [get-comments.js](get-comments.js) | 抓当前问题页评论(正文+回复者用户名+点赞) | ⚠️ 待实测(样例,selector 需对真实页面核对) |

## 坑

- 评论区懒加载,需要滚动触发;**优先用 `view` 看视口里有哪些块再定位**,别只信 snapshot(评论正文/用户名常是非交互文本块,snapshot 会漏)。
- 若页面改版导致原语失效 → 更新 selector 或删除,并在此标记。
