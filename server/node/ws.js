/*
 * A small WebSocket server (RFC 6455) for the Node adapter, so self-hosting needs no npm packages.
 * Supports what the game needs: text messages (also fragmented), ping/pong, close, size limits.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPEN = 1, CLOSING = 2, CLOSED = 3;

export class WebSocketConnection extends EventEmitter {
  constructor(socket, { maxPayload = 8192 } = {}) {
    super();
    this.socket = socket; this.maxPayload = maxPayload;
    this.readyState = OPEN;
    this.buf = Buffer.alloc(0); this.frags = []; this.fragLen = 0;
    socket.setNoDelay(true);
    socket.on('data', d => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const f = this.parse();
      if (!f) return;
      if (f === 'error') return;
      this.onFrame(f);
      if (this.readyState === CLOSED) return;
    }
  }
  parse() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return null; const hi = b.readUInt32BE(2); len = hi ? Infinity : b.readUInt32BE(6); off = 10; }
    if (!masked) return this.fail(1002, 'client frames must be masked');
    if (len > this.maxPayload) return this.fail(1009, 'message too big');
    if (b.length < off + 4 + len) return null;
    const mask = b.subarray(off, off + 4), data = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    this.buf = b.subarray(off + 4 + len);
    return { fin, op, data };
  }
  onFrame({ fin, op, data }) {
    switch (op) {
      case 0x0: case 0x1: case 0x2: {
        if (op !== 0x0) { this.frags = []; this.fragLen = 0; this.binary = op === 0x2; }
        this.frags.push(data); this.fragLen += data.length;
        if (this.fragLen > this.maxPayload) return this.fail(1009, 'message too big');
        if (!fin) return;
        const msg = Buffer.concat(this.frags); this.frags = []; this.fragLen = 0;
        return this.emit('message', this.binary ? msg : msg.toString('utf8'), this.binary);
      }
      case 0x8: { // close
        const code = data.length >= 2 ? data.readUInt16BE(0) : 1005;
        if (this.readyState === OPEN) this.frame(0x8, data.length >= 2 ? data.subarray(0, 2) : Buffer.alloc(0));
        this.readyState = CLOSING;
        this.socket.end();
        return this.finish(code);
      }
      case 0x9: return this.frame(0xa, data);           // ping -> pong
      case 0xa: return this.emit('pong');
      default: return this.fail(1002, 'bad opcode');
    }
  }
  fail(code, reason) { this.close(code, reason); this.buf = Buffer.alloc(0); return 'error'; }
  frame(op, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | op, len])
      : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); return h; })();
    this.socket.write(Buffer.concat([head, payload]));
  }
  send(text) { if (this.readyState === OPEN) this.frame(0x1, Buffer.from(String(text), 'utf8')); }
  ping() { if (this.readyState === OPEN) this.frame(0x9, Buffer.alloc(0)); }
  close(code = 1000, reason = '') {
    if (this.readyState !== OPEN) return;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8'), p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    this.frame(0x8, p);
    this.readyState = CLOSING;
    setTimeout(() => this.terminate(), 2000).unref();
  }
  terminate() { this.socket.destroy(); this.finish(); }
  finish(code = 1006) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit('close', code);
  }
}

// complete the HTTP upgrade; returns the connection, or null after answering 400
export function acceptUpgrade(req, socket, opts) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WebSocketConnection(socket, opts);
}
