/**
 * monitor.ts — 注入到每个页面的监控脚本(入口)。
 * 由 daemon 用 Page.addScriptToEvaluateOnNewDocument 注入,或 logs 前置注入;
 * 安装后 hook console/onerror/unhandledrejection → window.__cdpLogs。无需返回值(footer 读到 undefined 返回)。
 */
import { installMonitor } from './lib/monitor-inject';

(() => {
  installMonitor();
})();
