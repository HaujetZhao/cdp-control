/**
 * outline.ts — 提取页面大纲(入口):标题层级(h1-h6)+ 关键链接。
 */
import { setResult } from './lib/result';
import { genSel } from './lib/genSel';

(() => {
  const headings: any[] = [];
  Array.from(document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).forEach(el => {
    const t = (el.innerText || '').trim().slice(0, 80);
    if (t) headings.push({ level: +el.tagName[1], text: t, selector: genSel(el) });
  });
  const links: any[] = [];
  const seen = new Set();
  Array.from(document.querySelectorAll<HTMLAnchorElement>('nav a, header a, main a')).forEach(a => {
    const t = (a.innerText || '').trim().slice(0, 40);
    const k = (t || a.href).slice(0, 60);
    if (seen.has(k)) return; seen.add(k);
    if (!t && !a.href) return;
    links.push({ text: t || '(链接)', href: a.href || '' });
  });
  return setResult({ title: document.title, url: location.href, headings: headings.slice(0, 60), links: links.slice(0, 80) });
})();
