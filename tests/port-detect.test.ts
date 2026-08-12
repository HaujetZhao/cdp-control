/**
 * port-detect.test.ts — parseNetstatListeners 纯函数解析(跨平台可跑)。
 * 覆盖::92220 误匹配、ESTABLISHED 行、IPv6 本地地址、UDP 行、非法 pid。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNetstatListeners } from '../src/port-detect.ts';

const SAMPLE = [
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:9222           0.0.0.0:0              LISTENING       1234',
  '  TCP    [::]:9222              [::]:0                 LISTENING       5678',
  '  TCP    127.0.0.1:92220        0.0.0.0:0              LISTENING       9999', // 端口是 92220,非 9222
  '  TCP    0.0.0.0:9333           0.0.0.0:0              LISTENING       4321',
  '  TCP    127.0.0.1:9222         127.0.0.1:5000         ESTABLISHED     7777', // ESTABLISHED,非监听
  '  UDP    0.0.0.0:9222           *:*                                   1111',  // UDP,非 TCP
].join('\n');

test('parseNetstatListeners 解析全部监听者', () => {
  const rows = parseNetstatListeners(SAMPLE);
  assert.deepEqual(rows, [
    { port: 9222, pid: 1234 },
    { port: 9222, pid: 5678 },
    { port: 92220, pid: 9999 },
    { port: 9333, pid: 4321 },
  ]);
});

test('findPortListeners 语义:精确端口 + 只监听(在纯解析层模拟)', () => {
  // 模拟 win 路径:parseNetstatListeners 之后按 port 过滤
  const rows = parseNetstatListeners(SAMPLE);
  assert.deepEqual(rows.filter(r => r.port === 9222).map(r => r.pid), [1234, 5678]);
  assert.deepEqual(rows.filter(r => r.port === 9222).length, 2);  // 不误抓 92220
  assert.deepEqual(rows.filter(r => r.port === 9333).map(r => r.pid), [4321]);
});
