/**
 * B 站直播间弹幕客户端。
 *
 * 流程：room_init 取真实房间号 → getDanmuInfo（WBI 签名）取 token 与节点 →
 * WebSocket 连接 /sub → 发认证包(op=7) → 每 30s 心跳(op=2) → 解压并解析业务命令。
 *
 * 封包格式（16 字节大端头部）：
 *   [0..4)   包总长度
 *   [4..6)   头部长度（恒为 16）
 *   [6..8)   protover（0/1 明文，2 zlib，3 brotli）
 *   [8..12)  操作码 op（2 心跳 3 心跳回复 5 业务 7 认证 8 认证回复）
 *   [12..16) sequence
 */
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { WsClient } = require('./ws-client');
const { BiliAuth, encWbi, UA } = require('./auth');

const OP = { HEARTBEAT: 2, HEARTBEAT_REPLY: 3, MESSAGE: 5, AUTH: 7, AUTH_REPLY: 8 };

/**
 * 对点歌无用且会刷屏的 cmd，收到后直接静默跳过。
 * （B 站新版本会不断推这些事件，其中不少带几百字符的 base64）
 */
const NOISY_CMDS = new Set([
  'LOG_IN_NOTICE', // 「未登录无法查看他人昵称」提示
  'INTERACT_WORD',
  'INTERACT_WORD_V2',
  'LIKE_INFO_V3_UPDATE',
  'LIKE_INFO_V3_CLICK',
  'WATCHED_CHANGE',
  'DM_INTERACTION',
  'ONLINE_RANK_V2',
  'ONLINE_RANK_V3',
  'ONLINE_RANK_COUNT',
  'ENTRY_EFFECT',
  'ENTRY_EFFECT_V2',
  'STOP_LIVE_ROOM_LIST_V2',
  'POPULARITY_RED_POCKET_NEW',
  'POPULARITY_RED_POCKET_START',
  'POPULARITY_RED_POCKET_WINNER_LIST',
  'RANK_CHANGED',
  'RANK_CHANGED_V2',
  'REVENUE_RANK_CHANGED',
  'PLAY_TOGETHER',
  'VOICE_JOIN_ROOM_COUNT_INFO',
  'VOICE_JOIN_LIST',
  'GUARD_BUY_V2',
  'WIDGET_BANNER',
  'COMMON_NOTICE_DANMAKU',
  'HOT_RANK_CHANGED',
  'HOT_RANK_CHANGED_V2',
  'AREA_RANK_CHANGED',
  'LIVE_BUFFER_CHANGED',
  'ROOM_REAL_TIME_MESSAGE_UPDATE',
  'MESSAGEBOX_USER_MEDAL_CHANGE',
  'USER_TOAST_MSG_V2',
]);

function makePacket(op, protover, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload == null ? '' : String(payload), 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16 + body.length, 0);
  head.writeUInt16BE(16, 4);
  head.writeUInt16BE(protover, 6);
  head.writeUInt32BE(op, 8);
  head.writeUInt32BE(1, 12);
  return Buffer.concat([head, body]);
}

/** 按头部声明长度切分出完整封包 */
function splitPackets(buf) {
  const out = [];
  let off = 0;
  while (off + 16 <= buf.length) {
    const total = buf.readUInt32BE(off);
    if (total < 16 || off + total > buf.length) break;
    out.push(buf.subarray(off, off + total));
    off += total;
  }
  return out;
}

class LiveDanmakuClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.roomId 直播间号（短号或长号均可）
   * @param {BiliAuth} [options.auth]
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    super();
    this.shortRoomId = Number(options.roomId || 0);
    this.roomId = 0;
    this.auth = options.auth || new BiliAuth(options.logger);
    this.logger = options.logger || { info() {}, warn() {}, debug() {}, error() {} };
    this.ws = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.reconnectDelay = options.reconnectBaseMs || 2000;
    this.reconnectMax = options.reconnectMaxMs || 60000;
    this.running = false;
    this.handshakeDone = false;
    this.lastPopularity = 0;
    this.stats = { danmaku: 0, gift: 0, superchat: 0, guard: 0, other: 0 };
  }

  log(...args) {
    this.logger.info('[弹幕] ' + args.join(' '));
  }

  /** 解析真实房间号 */
  async resolveRoomId() {
    const r = await this.auth.request(
      'https://api.live.bilibili.com/room/v1/Room/room_init?id=' + this.shortRoomId,
      { referer: 'https://live.bilibili.com/' + this.shortRoomId }
    );
    const data = r.json && r.json.data;
    if (r.json && r.json.code === 0 && data) {
      this.roomId = data.room_id;
      this.liveStatus = data.live_status;
      this.uid = data.uid;
      return this.roomId;
    }
    throw new Error('获取直播间信息失败：' + ((r.json && r.json.message) || r.raw || '').slice(0, 120));
  }

  /**
   * 获取弹幕服务器信息。
   *
   * 分三层，从最稳的开始试：
   *   1) 老接口 room/v1/Danmu/getConf —— 不需要 WBI 签名、不需要 Cookie，
   *      实测 code=0 且节点与 token 都齐全，是最不容易被风控拦掉的一条路；
   *   2) 新接口 xlive/web-room/v1/index/getDanmuInfo（带 WBI 签名 + buvid3）——
   *      这是官方 Web 端在用的接口，但需要签名，风控收紧时可能返回 -352；
   *   3) 再试一次 getDanmuInfo，但强制刷新 WBI 密钥（密钥每日轮换，缓存过期会导致签名错）。
   */
  async getDanmuInfo() {
    const errors = [];

    // 1) 老接口：无需签名
    try {
      const r = await this.auth.request(
        'https://api.live.bilibili.com/room/v1/Danmu/getConf' +
          '?room_id=' + this.roomId + '&platform=pc&player=web',
        { referer: 'https://live.bilibili.com/' + this.roomId }
      );
      const json = r.json || {};
      const data = json.data || {};
      const hosts = data.host_server_list || data.server_list || [];
      if (json.code === 0 && hosts.length && data.token) {
        this.logger.debug('弹幕服务器来源：room/v1/Danmu/getConf（老接口）');
        return { token: data.token, host_list: hosts, from: 'getConf' };
      }
      errors.push('getConf code=' + json.code + ' 节点=' + hosts.length + ' token=' + (data.token ? '有' : '无'));
    } catch (e) {
      errors.push('getConf: ' + e.message);
    }

    // 2) 新接口（WBI 签名 + buvid3）
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.auth.ensureBuvid();
        const wbi = await this.auth.ensureWbi(attempt > 0); // 第二次强制刷新密钥
        if (wbi.imgKey && wbi.subKey) {
          const query = encWbi({ id: this.roomId, type: 0, web_location: '444.8' }, wbi.imgKey, wbi.subKey);
          const r = await this.auth.request(
            'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?' + query,
            {
              referer: 'https://live.bilibili.com/' + this.roomId,
              headers: { Origin: 'https://live.bilibili.com' },
            }
          );
          const json = r.json || {};
          const data = json.data || {};
          if (json.code === 0 && data.token && (data.host_list || []).length) {
            this.logger.debug('弹幕服务器来源：getDanmuInfo（WBI 签名）');
            return { token: data.token, host_list: data.host_list, from: 'getDanmuInfo' };
          }
          errors.push(
            'getDanmuInfo code=' + json.code +
              ' 节点=' + ((data.host_list || []).length) +
              ' token=' + (data.token ? '有' : '无') +
              (data.v_voucher ? '（返回 v_voucher，说明被风控）' : '')
          );
        } else {
          errors.push('getDanmuInfo: 未取到 WBI 密钥');
        }
      } catch (e) {
        errors.push('getDanmuInfo: ' + e.message);
      }
    }

    throw new Error('获取弹幕服务器失败：' + errors.join('；'));
  }

  /** 启动（含自动重连） */
  async start() {
    if (this.running) return;
    this.running = true;
    await this.connectLoop();
  }

  async connectLoop() {
    while (this.running) {
      try {
        await this.connectOnce();
        if (!this.running) return;
        this.log('连接已断开，' + Math.round(this.reconnectDelay / 1000) + ' 秒后重连');
      } catch (e) {
        this.emit('error', e);
        this.log('连接失败：' + e.message + '，' + Math.round(this.reconnectDelay / 1000) + ' 秒后重试');
      }
      if (!this.running) return;
      await new Promise((resolve) => {
        this.reconnectTimer = setTimeout(resolve, this.reconnectDelay);
      });
      this.reconnectDelay = Math.min(this.reconnectMax, Math.round(this.reconnectDelay * 1.8));
    }
  }

  async connectOnce() {
    if (!this.roomId) await this.resolveRoomId();
    // 解析出真实房间号后立刻广播一次，让 UI 马上能看到正确的房间号
    this.emit('status', { state: 'connecting', roomId: this.roomId, shortId: this.shortRoomId });

    const info = await this.getDanmuInfo();
    const hosts = (info.host_list || []).slice().sort(() => Math.random() - 0.5);
    if (!hosts.length) hosts.push({ host: 'broadcastlv.chat.bilibili.com', wss_port: 443 });

    let lastError = null;
    for (const node of hosts.slice(0, 3)) {
      try {
        const url = 'wss://' + node.host + ':' + (node.wss_port || 443) + '/sub';
        this.ws = new WsClient(url, { origin: 'https://live.bilibili.com' });
        await this.ws.connect();
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        this.ws = null;
      }
    }
    if (lastError) throw lastError;

    const ws = this.ws;
    ws.on('message', (buf) => this.handleFrame(buf));
    ws.on('close', () => {
      if (this.handshakeDone) this.log('服务端关闭了连接');
      this.cleanup();
    });
    ws.on('error', (e) => this.log('连接错误：' + e.message));

    // 认证包（建连后 5 秒内必须发送）
    //
    // uid 必须与**申请 token 时的身份**一致，否则服务端不返回鉴权结果、
    // 直接把连接关掉（表现为「连上了但一条弹幕都收不到，2 秒后重连」）。
    //
    // 实测（2026-10，热门房间 5271）：
    //   · 首选路径 room/v1/Danmu/getConf 是**匿名**接口，拿到的是匿名 token；
    //     此时发送 uid=0 → 立刻收到 AUTH_REPLY(op=8)，连接稳定，能收弹幕；
    //     发送登录 uid（即使请求时带着同一份登录 Cookie）→ 服务端立即 close，收不到任何帧。
    //   · 取弹幕不需要登录：昵称/uid 是弹幕消息里自带的，与自己用什么 uid 建连无关。
    //
    // 所以这里**固定发 0**。等哪天改成「带登录态申请 token 并校验 uid 一致」再放开。
    const authBody = {
      uid: 0,
      roomid: this.roomId,
      protover: 3,
      platform: 'web',
      type: 2,
      key: info.token,
    };
    // buvid 不在官方字段表里，服务端会忽略；带上只是让指纹更像正常 Web 客户端
    if (this.auth.buvid3) authBody.buvid = this.auth.buvid3;
    ws.sendFrame(makePacket(OP.AUTH, 1, JSON.stringify(authBody)), 0x2);

    // 心跳
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && !this.ws.closed) {
        this.ws.sendFrame(makePacket(OP.HEARTBEAT, 1, '[object Object]'), 0x2);
      }
    }, 30000);

    this.reconnectDelay = 2000;
    this.log('已连接直播间 ' + this.roomId + '（' + node_label(hosts) + '）');
    this.emit('status', { state: 'connected', roomId: this.roomId, shortId: this.shortRoomId });

    // 保持 connectOnce 直到连接断开
    await new Promise((resolve) => {
      const done = () => {
        ws.removeListener('close', done);
        resolve();
      };
      ws.once('close', done);
    });
  }

  cleanup() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  stop() {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.cleanup();
    this.emit('status', { state: 'stopped', roomId: this.roomId });
  }

  /** 处理 WebSocket 收到的二进制数据 */
  handleFrame(buf) {
    for (const pkt of splitPackets(buf)) {
      if (pkt.length < 16) continue;
      const headerLen = pkt.readUInt16BE(4);
      const proto = pkt.readUInt16BE(6);
      const op = pkt.readUInt32BE(8);
      const body = pkt.subarray(headerLen);
      this.handlePacket(op, proto, body);
    }
  }

  handlePacket(op, proto, body) {
    if (op === OP.AUTH_REPLY) {
      this.handshakeDone = true;
      let code = null;
      try {
        code = JSON.parse(body.toString('utf8')).code;
      } catch {
        /* ignore */
      }
      if (code === 0) this.log('弹幕认证成功');
      else this.log('弹幕认证返回 code=' + code);
      return;
    }
    if (op === OP.HEARTBEAT_REPLY) {
      if (body.length >= 4) this.lastPopularity = body.readUInt32BE(0);
      return;
    }
    if (op !== OP.MESSAGE) return;

    if (proto === 3) {
      let inner;
      try {
        inner = zlib.brotliDecompressSync(body);
      } catch (e) {
        this.logger.warn('brotli 解压失败：' + e.message);
        return;
      }
      for (const p of splitPackets(inner)) this.handleInnerPacket(p);
      return;
    }
    if (proto === 2) {
      let inner;
      try {
        inner = zlib.inflateSync(body);
      } catch (e) {
        this.logger.warn('zlib 解压失败：' + e.message);
        return;
      }
      const packets = splitPackets(inner);
      if (packets.length) packets.forEach((p) => this.handleInnerPacket(p));
      else this.handleJson(inner);
      return;
    }
    this.handleJson(body);
  }

  handleInnerPacket(pkt) {
    if (pkt.length < 16) return;
    const op = pkt.readUInt32BE(8);
    if (op !== OP.MESSAGE) return;
    this.handleJson(pkt.subarray(pkt.readUInt16BE(4)));
  }

  handleJson(buf) {
    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || !msg.cmd) return;
    const cmd = String(msg.cmd).split(':')[0];

    // 这些 cmd 对点歌没用，而且部分会带很长的 base64，直接静默跳过，
    // 免得刷屏、也免得占满「最近弹幕」列表。
    if (NOISY_CMDS.has(cmd)) return;

    if (cmd === 'DANMU_MSG') {
      const info = msg.info || [];
      const user = info[0] && info[0][15] && info[0][15].user;
      const medal = (user && user.medal) || null;
      const danmaku = {
        type: 'danmaku',
        text: info[1] || '',
        uid: (user && user.uid) || (info[2] && info[2][0]) || 0,
        uname: (user && user.base && user.base.name) || (info[2] && info[2][1]) || '',
        face: (user && user.base && user.base.face) || '',
        ts: (info[9] && info[9].ts ? info[9].ts * 1000 : Date.now()),
        guard: (medal && medal.guard_level) || (info[3] && info[3][10]) || 0,
        medal: medal ? { name: medal.name, level: medal.level, guard: medal.guard_level } : null,
        isReply: Boolean(info[0] && info[0][15] && info[0][15].extra && safeExtra(info[0][15].extra).content),
      };
      this.stats.danmaku += 1;
      this.emit('danmaku', danmaku);
      return;
    }

    if (cmd === 'SUPER_CHAT_MESSAGE') {
      const d = msg.data || {};
      this.stats.superchat += 1;
      this.emit('superchat', {
        type: 'superchat',
        text: d.message || '',
        uid: d.uid,
        uname: (d.user_info && d.user_info.uname) || '',
        price: d.price,
        ts: (d.ts || 0) * 1000 || Date.now(),
      });
      return;
    }

    if (cmd === 'SEND_GIFT') {
      const d = msg.data || {};
      this.stats.gift += 1;
      this.emit('gift', {
        type: 'gift',
        uid: d.uid,
        uname: d.uname,
        giftName: d.giftName,
        num: d.num,
        coin: d.total_coin,
        ts: (d.timestamp || 0) * 1000 || Date.now(),
      });
      return;
    }

    if (cmd === 'GUARD_BUY') {
      const d = msg.data || {};
      this.stats.guard += 1;
      this.emit('guard', { type: 'guard', uid: d.uid, uname: d.username, level: d.guard_level, num: d.num });
      return;
    }

    if (cmd === 'LIVE' || cmd === 'PREPARING' || cmd === 'ROOM_CHANGE') {
      this.emit('room', { cmd, data: msg.data || {} });
      return;
    }

    this.stats.other += 1;
    this.emit('other', { cmd, data: msg.data || msg.info || null });
  }

  /** 发送弹幕（回复观众） */
  async sendDanmaku(text) {
    if (!this.roomId) throw new Error('尚未连接直播间');
    return this.auth.sendDanmaku(this.roomId, text);
  }
}

function safeExtra(extra) {
  try {
    return JSON.parse(extra) || {};
  } catch {
    return {};
  }
}

function node_label(hosts) {
  return hosts.length ? hosts[0].host : 'default';
}

module.exports = { LiveDanmakuClient, makePacket, splitPackets, OP };
