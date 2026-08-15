/**
 * fake-cdp.ts — 测试用假 CDP 端点(零依赖):node:http 提供 /json/version、/json/list,
 * 并手写最小 RFC 6455 WebSocket 服务端(握手 + 文本帧解/封包 + ping/close),
 * 让 transport 的全局 WebSocket 客户端能连上 target.webSocketDebuggerUrl 并收发 CDP 消息。
 * 由测试传入 respond(method, params) 决定每条命令的 result;所有收到的命令按序记录在 calls。
 * 只用于驱动 Node 侧真实 api/transport 代码路径,不模拟浏览器 DOM。
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

export interface CdpCall { id: number; method: string; params: any }
export type Responder = (method: string, params: any) => unknown;
export interface FakeTarget { id: string; type: string; url: string; title: string; webSocketDebuggerUrl: string }
export interface FakeCdp {
  port: number;
  target: FakeTarget;
  calls: CdpCall[];
  close(): Promise<void>;
}

/** Runtime.evaluate 的 result 形态:{ result: { type, value } },evalJs 读 r.result.value。 */
export function evalValue(value: unknown): unknown {
  return { result: { type: typeof value, value } };
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeText(str: string): Buffer {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

function encodeControl(opcode: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

/** 逐帧解析(处理分片/掩码/扩展长度);每完整消息回调 onText;控制帧就地应答。 */
function attachFrameReader(socket: Duplex, onText: (text: string) => void): void {
  let pending: Buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];
  const onData = (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (true) {
      if (pending.length < 2) return;
      const fin = (pending[0] & 0x80) !== 0;
      const opcode = pending[0] & 0x0f;
      const masked = (pending[1] & 0x80) !== 0;
      let len = pending[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (pending.length < 4) return; len = pending.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (pending.length < 10) return; len = Number(pending.readBigUInt64BE(2)); off = 10; }
      if (masked && pending.length < off + 4) return;
      const mask = masked ? pending.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (pending.length < off + len) return;
      const payload = Buffer.from(pending.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      pending = pending.subarray(off + len);
      if (opcode === 0x8) { try { socket.write(encodeControl(0x8, payload)); } catch {} socket.end(); return; }
      if (opcode === 0x9) { socket.write(encodeControl(0xa, payload)); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x0) {
        fragments.push(payload);
        if (fin) { const text = Buffer.concat(fragments).toString('utf8'); fragments = []; onText(text); }
      }
    }
  };
  socket.on('data', onData);
}

function json(res: ServerResponse, body: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/** 起一个假 CDP 端点。respond 返回值作为该命令的 result 回给客户端;抛错则回 CDP error。 */
export async function startFakeCdp(respond: Responder): Promise<FakeCdp> {
  const calls: CdpCall[] = [];
  const sockets = new Set<Duplex>();
  let target: FakeTarget;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/json/version') { json(res, { Browser: 'FakeCDP/1.0', webSocketDebuggerUrl: target.webSocketDebuggerUrl.replace('/page/', '/browser/') }); return; }
    if (req.url === '/json/list' || req.url === '/json') { json(res, [target]); return; }
    res.statusCode = 404; res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`, '', '',
    ].join('\r\n'));
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    attachFrameReader(socket, (text) => {
      let msg: any;
      try { msg = JSON.parse(text); } catch { return; }
      calls.push({ id: msg.id, method: msg.method, params: msg.params });
      let reply: string;
      try { reply = JSON.stringify({ id: msg.id, result: respond(msg.method, msg.params) ?? {} }); }
      catch (e: any) { reply = JSON.stringify({ id: msg.id, error: { message: e?.message || String(e) } }); }
      socket.write(encodeText(reply));
    });
    if (head?.length) socket.emit('data', head);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  target = { id: 'FAKE1', type: 'page', url: 'http://fake.test/page', title: 'fake', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/FAKE1` };
  return {
    port, target, calls,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) { try { s.destroy(); } catch {} }
      server.close(() => resolve());
    }),
  };
}
