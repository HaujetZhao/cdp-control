// browser-discover.test.ts — discoverCandidates 跨平台候选顺序/命名单测(纯函数,零 fs)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCandidates } from '../src/browser-discover.ts';

test('win32: Edge 优先于 Chrome，路径来自 env 表', () => {
  const c = discoverCandidates('win32');
  assert.ok(c.length > 0);
  const kinds = c.map(x => x.kind);
  assert.equal(kinds[0], 'edge', 'Edge 应排最前');
  assert.ok(kinds.some(k => k === 'chrome'));
  assert.ok(c[0].exe.includes('msedge.exe'));
  assert.ok(c.find(x => x.kind === 'chrome')!.exe.includes('chrome.exe'));
});

test('darwin: 精确 .app+bin 名，Safari 不在列表，Edge 优先', () => {
  const c = discoverCandidates('darwin');
  assert.equal(c[0].kind, 'edge');
  assert.ok(c[0].exe.includes('/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'), 'bin 名含空格');
  assert.ok(c.find(x => x.kind === 'brave')!.exe.includes('Brave Browser'));
  assert.ok(c.find(x => x.kind === 'arc')!.exe.includes('Arc.app'));
  assert.ok(!c.some(x => x.exe.includes('Safari')));
});

test('linux: command -v 名称齐全，microsoft-edge 判为 edge', () => {
  const c = discoverCandidates('linux');
  const names = c.map(x => x.exe);
  assert.ok(names.includes('google-chrome-stable'));
  assert.ok(names.includes('chromium'));
  assert.ok(names.includes('microsoft-edge-stable'));
  assert.equal(c.find(x => x.exe.includes('microsoft-edge'))!.kind, 'edge');
  assert.equal(c.find(x => x.exe.includes('google-chrome'))!.kind, 'chrome');
});
