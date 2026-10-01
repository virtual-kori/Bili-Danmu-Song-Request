/**
 * 极简 WebSocket 服务端（RFC6455，仅支持文本帧 + ping/pong/close）。
 * 用于把点歌机状态实时推送给 Web UI / OBS 浏览器源。
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WsServer extends EventEmitter {
  constructor(httpServer, options = {}) {
    super();
    this.clients = new Set();
    this.path = options.path || '/ws';
    httpServer.on('upgrade', (req, socket, head) => {
      let pathname = '/';
      try {
        pathname = new URL(req.url, 'http://localhost').pathname;
      } catch {
        /* ignore */
      }
      if (pathname !== this.path) {
        socket.destroy();
        return;
      }
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Accept: ' +
          accept +
          '\r\n\r\n'
      );
      const client = new WsConnection(socket);
      this.clients.add(client);
      client.on('close', () => this.clients.delete(client));
      this.emit('connection', client, req);
      if (head && head.length) client.feed(head);
    });
  }

  broadcast(obj) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    for (const c of this.clients) c.sendText(text);
  }

  get size() {
    return this.clients.size;
  }

  closeAll() {
    for (const c of this.clients) c.close();
    this.clients.clear();
  }
}

class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.emit('close');
      }
    });
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.slice(offset, offset + len);
      this.buffer = this.buffer.slice(offset + len);
      if (maskKey) {
        const out = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i % 4];
        payload = out;
      }

      if (opcode === 0x9) {
        this.sendFrame(payload, 0xa);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x0) {
        this.fragments.push(payload);
      } else {
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
      }
      if (fin) {
        const data = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.fragmentOpcode === 0x1) this.emit('message', data.toString('utf8'));
        else if (this.fragmentOpcode === 0x2) this.emit('binary', data);
      }
    }
  }

  sendFrame(payload, opcode = 0x1) {
    if (this.closed || !this.socket || this.socket.destroyed) return false;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, data]));
      return true;
    } catch {
      return false;
    }
  }

  sendText(text) {
    return this.sendFrame(text, 0x1);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.sendFrame(Buffer.alloc(0), 0x8);
    } catch {
      /* ignore */
    }
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => this.destroy(), 300).unref?.();
    this.emit('close');
  }

  destroy() {
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    if (!this.closed) {
      this.closed = true;
      this.emit('close');
    }
  }
}

module.exports = { WsServer, WsConnection };
