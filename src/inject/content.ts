/**
 * content.ts — 提取主内容文本(入口)。去导航/页脚/表单/脚本等,截断至 6000 字符。
 */
import { setResult } from './lib/result';

(() => {
  const clone = document.body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script,style,noscript,svg,nav,footer,header,form,aside,iframe,button,a').forEach(e => e.remove());
  const lines = (clone.innerText || '').split('\n').map(s => s.trim()).filter(l => l.length > 1);
  return setResult({ title: document.title, url: location.href, text: lines.join('\n').slice(0, 6000) });
})();
