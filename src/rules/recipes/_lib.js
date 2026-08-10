// _lib.js — recipe 共享工具(Node 侧,纯函数,可单测)。各 recipe 顶部 `require('./_lib.js')`。
//
// 与 eval 字符串里的 DOM 读(refOf/querySelector)分离:本文件只管「数据到手后的文本 / ref 呈现」,
// 让这段不再在每个 recipe 的模板字符串里手抄,也交给 Node 单测(治"浏览器抽取 + Node 呈现混在一个
// 模板字符串里不可测"的摩擦)。抽取(eval,浏览器侧)只回 raw 文本 + ref,呈现(此处,Node 侧)负责归一化。

/** 归一化文本:剥零宽字符、扁平化空白、去首尾。知乎等站文本常带零宽空格(‌‍)。 */
function clean(s) {
  return (s || '').replace(/[​‌‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

/** ref 上标:[ref=N];未命中(ref==null 或 <0)返回空串。refOf 未命中返回 null(区分「未建树」),见设计 L2。 */
function refstr(ref) {
  return ref != null && ref >= 0 ? ` [ref=${ref}]` : '';
}

/** 操作入口提示:「(用 <expr> <ref> 展开)」。让"点了才有内容"的操作提示归框架侧,recipe 不硬编码死文案。 */
function opHint(expr, ref) {
  return ref != null && ref >= 0 ? `(用 ${expr} ${ref} 展开)` : '';
}

module.exports = { clean, refstr, opHint };
