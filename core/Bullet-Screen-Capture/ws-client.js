/**
 * B 站 WebSocket 客户端（极简 RFC6455 实现，仅覆盖弹幕广播场景）。
 *
 * 与 bilibili-API-collect 文档对应的能力：
 *  - 客户端帧必须加掩码（MASK=1）
 *  - 支持文本/二进制/关闭/ping 帧
 *  - 收到 ping 自动回 pong
 *  - 正确处理跨帧拼接与单帧多包
 */
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WsClient extends EventEmitter {
  constructor(url, options = {}) {
    super();
    const u = new URL(url);
    this.secure = u.protocol === 'wss:';
    this.host = u.hostname;
    this.port = Number(u.port || (this.secure ? 443 : 80));
    this.path = (u.pathname || '/') + (u.search || '');
    this.origin = options.origin || (this.secure ? 'https://' + this.host : 'http://' + this.host);
    this.extraHeaders = options.headers || {};
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.closed = false;
    this.handshakeDone = false;
    this.connectTimeoutMs = options.connectTimeoutMs || 10000;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      this.wsKey = key;
      const hostHeader = this.port === (this.secure ? 443 : 80) ? this.host : this.host + ':' + this.port;
      const headers = [
        'GET ' + this.path + ' HTTP/1.1',
        'Host: ' + hostHeader,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: ' + key,
        'Sec-WebSocket-Version: 13',
        'Origin: ' + this.origin,
        'User-Agent: ' +
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ];
      for (const k of Object.keys(this.extraHeaders)) headers.push(k + ': ' + this.extraHeaders[k]);
      const request = headers.join('\r\n') + '\r\n\r\n';

      const onConnect = () => {
        this.socket.write(request);
      };
      const onData = (chunk) => {
        if (!this.handshakeDone) {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          const idx = this.buffer.indexOf('\r\n\r\n');
          if (idx < 0) return;
          const head = this.buffer.slice(0, idx).toString('latin1');
          const rest = this.buffer.slice(idx + 4);
          this.buffer = Buffer.alloc(0);
          const statusLine = head.split('\r\n')[0] || '';
          const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head);
          const expected = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
          if (!/101/.test(statusLine)) {
            cleanup();
            reject(new Error('WebSocket 握手失败：' + statusLine));
            return;
          }
          if (accept && accept[1] !== expected) {
            cleanup();
            reject(new Error('WebSocket 握手校验失败'));
            return;
          }
          this.handshakeDone = true;
          cleanup(true);
          this.emit('open');
          resolve(this);
          if (rest.length) this.onBytes(rest);
          return;
        }
        this.onBytes(chunk);
      };
      const onError = (err) => {
        cleanup();
        if (this.handshakeDone) this.emit('error', err);
        else reject(err);
      };
      const onClose = () => {
        cleanup();
        this.closed = true;
        this.emit('close');
      };

      const cleanup = (keepListeners) => {
        clearTimeout(timer);
        if (!keepListeners) {
          if (this.socket) {
            this.socket.removeListener('data', onData);
            this.socket.removeListener('error', onError);
            this.socket.removeListener('close', onClose);
          }
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        try {
          if (this.socket) this.socket.destroy();
        } catch {
          /* ignore */
        }
        reject(new Error('WebSocket 连接超时'));
      }, this.connectTimeoutMs);

      this.socket = this.secure
        ? tls.connect({ host: this.host, port: this.port, servername: this.host, rejectUnauthorized: false }, onConnect)
        : net.connect({ host: this.host, port: this.port }, onConnect);
      this.socket.on('data', onData);
      this.socket.on('error', onError);
      this.socket.on('close', onClose);
      this.socket.setNoDelay(true);
    });
  }

  onBytes(chunk) {
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
        const big = this.buffer.readBigUInt64BE(2);
        len = Number(big);
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

      if (opcode === OPCODE.PING) {
        this.sendFrame(payload, OPCODE.PONG);
        continue;
      }
      if (opcode === OPCODE.PONG) continue;
      if (opcode === OPCODE.CLOSE) {
        this.closed = true;
        this.emit('close', payload.length >= 2 ? payload.readUInt16BE(0) : 1005);
        try {
          this.socket.end();
        } catch {
          /* ignore */
        }
        return;
      }
      if (opcode === OPCODE.CONTINUATION) {
        this.fragments.push(payload);
      } else {
        this.fragments = [payload];
        this.fragmentOpcode = opcode;
      }
      if (fin) {
        const data = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.fragmentOpcode === OPCODE.BINARY) this.emit('message', data);
        else if (this.fragmentOpcode === OPCODE.TEXT) this.emit('text', data.toString('utf8'));
      }
    }
  }

  /** 发送一个 WebSocket 帧（客户端必须加掩码） */
  sendFrame(payload, opcode = OPCODE.BINARY) {
    if (!this.socket || this.socket.destroyed) return false;
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'utf8');
    const len = data.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(6);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(14);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const maskKey = crypto.randomBytes(4);
    maskKey.copy(header, header.length - 4);
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = data[i] ^ maskKey[i % 4];
    try {
      this.socket.write(Buffer.concat([header, masked]));
      return true;
    } catch {
      return false;
    }
  }

  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    try {
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code, 0);
      this.sendFrame(body, OPCODE.CLOSE);
    } catch {
      /* ignore */
    }
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
    }, 500).unref?.();
  }
}

module.exports = { WsClient, OPCODE };
