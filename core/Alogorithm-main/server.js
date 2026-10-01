/**
 * 弹幕点歌机主服务。
 *
 * 启动顺序：
 *   1. 读取根目录 config.json / platform-ports.json
 *   2. 拉起四平台本地 API（网易云同进程，其余子进程）
 *   3. 连接 B 站直播间弹幕（若已配置房间号）
 *   4. 启动 Web UI + WebSocket 推送（默认 127.0.0.1:33000）
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const cfgMod = require('./core/config');
const logMod = require('./core/logger');
const logger = logMod.make('main');
const { Engine, getCachedCandidate } = require('./core/engine');
const { PlatformSupervisor } = require('./core/platforms');
const { WsServer } = require('./core/ws-server');

const { NeteaseAdapter } = require('./platforms/netease');
const { QQAdapter } = require('./platforms/qq');
const { KugouAdapter } = require('./platforms/kugou');
const { KuwoAdapter } = require('./platforms/kuwo');

const { BiliAuth } = require('../Bullet-Screen-Capture/auth');
const { LiveDanmakuClient } = require('../Bullet-Screen-Capture/live');
const { parseSongRequest } = require('../Bullet-Screen-Capture/parse');

const WEB_DIR = path.join(__dirname, 'web');

let engine = null;
let supervisor = null;
let wsServer = null;
let danmakuClient = null;
let auth = null;
let shuttingDown = false;

function nowText() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

async function boot() {
  cfgMod.ensureConfigFiles();
  const config = cfgMod.config;
  const platforms = cfgMod.platforms;

  logMod.setLevel((config.log && config.log.level) || 'info');
  logMod.setKeepDays((config.log && config.log.keepDays) || 7);

  logger.info('=== 弹幕点歌机启动 ===');
  logger.info('配置：' + cfgMod.CONFIG_PATH);

  // ---------------- 平台 API ----------------
  supervisor = new PlatformSupervisor(platforms, config);
  await supervisor.startAll();
  await supervisor.healthCheck();
  logger.info(
    '平台服务状态：' +
      Object.keys(supervisor.status)
        .map((k) => k + '=' + supervisor.status[k].state)
        .join(' ')
  );

  // ---------------- 适配器 ----------------
  const getPlatform = (key) => cfgMod.platforms[key] || {};
  const adapters = {
    netease: new NeteaseAdapter(() => getPlatform('netease')),
    qq: new QQAdapter(() => getPlatform('qq')),
    kugou: new KugouAdapter(() => getPlatform('kugou')),
    kuwo: new KuwoAdapter(() => getPlatform('kuwo')),
  };

  // ---------------- 引擎 ----------------
  engine = new Engine({
    config,
    adapters,
    saveConfig: (patch) => cfgMod.saveConfig(patch),
  });

  // ---------------- HTTP + WebSocket ----------------
  const server = http.createServer((req, res) => handleHttp(req, res));
  wsServer = new WsServer(server, { path: '/ws' });
  wsServer.on('connection', (client) => {
    client.sendText(JSON.stringify({ type: 'state', data: withPlatforms() }));
  });
  engine.on('state', (snap) => {
    if (wsServer) wsServer.broadcast({ type: 'state', data: withPlatforms(snap) });
  });

  const port = Number((config.server && config.server.port) || 33000);
  const host = (config.server && config.server.host) || '127.0.0.1';

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const url = 'http://' + (host === '0.0.0.0' ? '127.0.0.1' : host) + ':' + port;
  logger.info('Web UI 已启动：' + url);

  if (config.server && config.server.openBrowser) openBrowser(url);

  // ---------------- B 站弹幕 ----------------
  auth = new BiliAuth(logger);
  attachDanmaku();

  logger.info('=== 启动完成，等待点歌 ===');
  engine.broadcast();
}

function withPlatforms(snap) {
  const base = snap || (engine ? engine.snapshot() : {});
  return {
    ...base,
    platformStatus: supervisor ? mergePlatformStatus(base.platformStatus) : base.platformStatus,
    servers: supervisor ? supervisor.snapshot() : {},
    danmaku: danmakuStatus(),
    time: Date.now(),
    timeText: nowText(),
  };
}

function mergePlatformStatus(current) {
  const out = { ...(current || {}) };
  const servers = supervisor.status || {};
  for (const key of Object.keys(servers)) {
    out[key] = { ...(out[key] || {}), server: servers[key].state };
  }
  return out;
}

function danmakuStatus() {
  const loggedIn = Boolean(auth && auth.loggedIn);
  if (!danmakuClient) {
    // 没连直播间时，也要把「配置里的房间号」带上，UI 才知道上次连的是哪个
    const cfgRoom = (cfgMod.config.danmaku && cfgMod.config.danmaku.roomId) || 0;
    return {
      state: cfgRoom ? 'disconnected' : 'idle',
      shortRoomId: cfgRoom,
      roomId: 0,
      popularity: 0,
      stats: null,
      loggedIn,
      user: auth ? { uid: auth.selfUid, uname: auth.selfName } : null,
    };
  }
  return {
    state: danmakuClient.running ? 'connected' : 'disconnected',
    shortRoomId: danmakuClient.shortRoomId,
    roomId: danmakuClient.roomId || danmakuClient.shortRoomId,
    popularity: danmakuClient.lastPopularity,
    stats: danmakuClient.stats,
    loggedIn,
    user: auth ? { uid: auth.selfUid, uname: auth.selfName } : null,
  };
}

/** 连接/重连直播间弹幕 */
async function attachDanmaku() {
  const cfg = cfgMod.config.danmaku || {};
  if (!cfg.enabled || !cfg.roomId) {
    logger.info('弹幕监听未启动（未开启或未设置房间号）');
    return;
  }
  if (danmakuClient) {
    danmakuClient.stop();
    danmakuClient = null;
  }
  danmakuClient = new LiveDanmakuClient({
    roomId: cfg.roomId,
    auth,
    logger,
    reconnectBaseMs: cfg.reconnectBaseMs,
    reconnectMaxMs: cfg.reconnectMaxMs,
  });
  danmakuClient.on('danmaku', (dm) => {
    engine.handleDanmaku(dm).catch((e) => logger.error('处理弹幕异常：' + e.stack));
  });
  danmakuClient.on('superchat', (sc) => {
    logger.info('醒目留言 ' + sc.uname + ' ¥' + sc.price + '：' + sc.text);
    engine.handleDanmaku({ text: sc.text, uid: sc.uid, uname: sc.uname }).catch(() => {});
  });
  danmakuClient.on('status', (s) => {
    if (wsServer) wsServer.broadcast({ type: 'danmaku-status', data: { ...s, ...danmakuStatus() } });
  });
  danmakuClient.on('error', (e) => logger.warn('弹幕连接：' + e.message));

  engine.setReplyHandler(async (text) => {
    if (!danmakuClient || !cfgMod.config.danmaku.replyEnabled) return;
    const cooldown = Number(cfgMod.config.danmaku.replyCooldownMs || 5000);
    const last = engine._lastReplyAt || 0;
    const wait = cooldown - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    engine._lastReplyAt = Date.now();
    await danmakuClient.sendDanmaku(text);
  });

  danmakuClient.start().catch((e) => logger.error('弹幕客户端启动失败：' + e.message));
}

// ------------------------------------------------------------------ HTTP 路由

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2e6) req.destroy();
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function serveStatic(res, relPath, type) {
  const file = path.join(WEB_DIR, relPath);
  if (!fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  // 静态页面
  if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html', 'text/html');
  if (p === '/app.js') return serveStatic(res, 'app.js', 'application/javascript');
  if (p === '/style.css') return serveStatic(res, 'style.css', 'text/css');
  if (p === '/obs') return serveStatic(res, 'obs.html', 'text/html');
  if (p === '/obs-lyrics' || p === '/obs/lyrics') return serveStatic(res, 'obs-lyrics.html', 'text/html');

  if (!engine) return sendJson(res, { ok: false, error: '引擎尚未就绪' }, 503);

  try {
    // 状态
    if (p === '/api/state') return sendJson(res, { ok: true, data: withPlatforms() });

    // 队列操作
    if (p === '/api/queue/pin' && req.method === 'POST') {
      const body = await readBody(req);
      const item = engine.queue.setPinned(body.id, body.pinned);
      return sendJson(res, { ok: Boolean(item), item });
    }
    if (p === '/api/queue/remove' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, { ok: engine.queue.remove(body.id) });
    }
    if (p === '/api/queue/clear' && req.method === 'POST') {
      return sendJson(res, { ok: true, removed: engine.queue.clear() });
    }
    if (p === '/api/queue/move' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJson(res, { ok: engine.queue.move(body.id, body.index) });
    }

    // 播放控制
    if (p === '/api/play/next' && req.method === 'POST') {
      engine.playNext().catch((e) => logger.error(e.stack));
      return sendJson(res, { ok: true, message: '已切歌' });
    }
    if (p === '/api/play/pause' && req.method === 'POST') {
      engine.player.togglePause();
      return sendJson(res, { ok: true, state: engine.player.state });
    }
    if (p === '/api/play/pause-set' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.paused) engine.player.pause();
      else engine.player.resume();
      return sendJson(res, { ok: true });
    }
    if (p === '/api/play/seek' && req.method === 'POST') {
      const body = await readBody(req);
      engine.player.seek(Number(body.seconds) || 0);
      return sendJson(res, { ok: true });
    }
    if (p === '/api/play/stop' && req.method === 'POST') {
      await engine.stopAll();
      return sendJson(res, { ok: true });
    }

    // 手动点歌（Web UI，直接点歌按钮走这里：自动匹配最优结果）
    if (p === '/api/order' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const singer = String(body.singer || '').trim();
      if (!name) return sendJson(res, { ok: false, error: '请填写歌名' }, 400);
      const result = await engine.requestSong({ name, singer, raw: name + ' ' + singer }, { uname: 'Web UI', uid: 'web' }, 'web');
      return sendJson(res, result);
    }

    // 候选搜索：四个平台各返回前 N 个结果，交给用户在 UI 上手动挑
    if (p === '/api/search-candidates') {
      const keyword = (url.searchParams.get('keyword') || '').trim();
      const singer = (url.searchParams.get('singer') || '').trim();
      const per = Math.min(10, Math.max(1, Number(url.searchParams.get('per') || 3)));
      if (!keyword) return sendJson(res, { ok: false, error: '请填写歌名' }, 400);
      const data = await searchCandidates(keyword, singer, per);
      return sendJson(res, { ok: true, data });
    }

    // 按用户选中的候选点歌（入队）
    if (p === '/api/order-candidate' && req.method === 'POST') {
      const body = await readBody(req);
      const cand = getCachedCandidate(body.platform, body.songId);
      if (!cand) {
        return sendJson(res, { ok: false, error: '候选已过期，请重新搜索' }, 400);
      }
      const result = await engine.enqueueCandidate(cand, { uname: 'Web UI', uid: 'web' }, 'web');
      return sendJson(res, result);
    }

    // 当前歌曲歌词（歌词由引擎在开始播放时异步取回并缓存）
    if (p === '/api/lyric') {
      return sendJson(res, { ok: true, data: engine.getLyric() });
    }

    // 搜索预览（不入队）
    if (p === '/api/search') {
      const keyword = url.searchParams.get('keyword') || '';
      if (!keyword) return sendJson(res, { ok: false, error: '缺少 keyword' }, 400);
      const parsed = { name: keyword, singer: '' };
      const found = await engine.findBestSong(parsed);
      return sendJson(res, { ok: true, data: found });
    }

    // 开关
    if (p === '/api/switches' && req.method === 'POST') {
      const body = await readBody(req);
      const patch = {};
      if (body.danmakuOrder !== undefined) patch.danmaku = { enabled: Boolean(body.danmakuOrder) };
      if (body.idleAutoPlay !== undefined) patch.idle = { enabled: Boolean(body.idleAutoPlay) };
      const snap = engine.updateConfig(patch);
      return sendJson(res, { ok: true, data: snap });
    }

    // 配置读写
    if (p === '/api/config') {
      if (req.method === 'GET') return sendJson(res, { ok: true, data: cfgMod.config });
      const body = await readBody(req);
      const snap = engine.updateConfig(body || {});
      return sendJson(res, { ok: true, data: cfgMod.config, state: snap });
    }
    if (p === '/api/platforms') {
      if (req.method === 'GET') return sendJson(res, { ok: true, data: cfgMod.platforms });
      const body = await readBody(req);
      const saved = cfgMod.savePlatforms(body || {});
      return sendJson(res, { ok: true, data: saved });
    }

    // 平台登录
    if (p.startsWith('/api/login/')) return handleLogin(p, url, req, res);

    // 统一账号登录中心：一次拿全五处账号状态
    if (p === '/api/accounts') return sendJson(res, { ok: true, data: await accountsSnapshot() });

    // 弹幕控制
    if (p === '/api/danmaku/connect' && req.method === 'POST') {
      const body = await readBody(req);
      const roomId = Number(body.roomId || (cfgMod.config.danmaku && cfgMod.config.danmaku.roomId) || 0);
      if (!roomId) return sendJson(res, { ok: false, error: '请填写直播间房间号' }, 400);
      engine.updateConfig({ danmaku: { roomId, enabled: true } });
      await attachDanmaku();
      return sendJson(res, { ok: true, data: danmakuStatus() });
    }
    if (p === '/api/danmaku/disconnect' && req.method === 'POST') {
      if (danmakuClient) danmakuClient.stop();
      danmakuClient = null;
      // 只把 enabled 关掉，保留 roomId，方便下次回来直接重连
      engine.updateConfig({ danmaku: { enabled: false } });
      return sendJson(res, { ok: true, data: danmakuStatus() });
    }
    if (p === '/api/danmaku/status') return sendJson(res, { ok: true, data: danmakuStatus() });
    if (p === '/api/danmaku/clear-log' && req.method === 'POST') {
      engine.recentDanmaku = [];
      engine.broadcast();
      return sendJson(res, { ok: true });
    }
    // 本地测试用：模拟一条弹幕走完整点歌链路（不影响直播弹幕，也不受弹幕开关限制）
    if (p === '/api/danmaku/simulate' && req.method === 'POST') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return sendJson(res, { ok: false, error: '缺少 text' }, 400);
      const requester = { uname: String(body.uname || '测试观众'), uid: Number(body.uid) || 1 };
      const parsed = parseSongRequest(text, {
        prefixes: (cfgMod.config.order && cfgMod.config.order.prefixes) || ['点歌'],
        allowStringPrefixMatch: cfgMod.config.order ? cfgMod.config.order.allowStringPrefixMatch : true,
      });
      // 记进「最近弹幕」，让人能看到这条模拟弹幕
      engine.logDanmaku({
        at: Date.now(),
        uname: requester.uname,
        uid: requester.uid,
        text,
        kind: parsed.ok ? 'order' : 'chat',
        note: parsed.ok ? parsed.name + (parsed.singer ? ' / ' + parsed.singer : '') : '',
      });
      if (!parsed.ok) return sendJson(res, { ok: true, result: { ok: false, reason: parsed.reason } });
      // 用 web 来源，跳过「允许弹幕点歌」开关，方便本地造数据
      const result = await engine.requestSong(parsed, requester, 'web');
      return sendJson(res, { ok: true, result });
    }

    // B 站扫码登录 / Cookie 导入
    if (p === '/api/bili/status') {
      const info = await auth.checkLogin();
      return sendJson(res, { ok: true, data: { ...info, loggedIn: auth.loggedIn } });
    }
    if (p === '/api/bili/qr' && req.method === 'POST') {
      const qr = await auth.qrGenerate();
      return sendJson(res, { ok: true, data: { ...qr, base64: await qrImage(qr.url) } });
    }
    if (p === '/api/bili/qr-check') {
      const key = url.searchParams.get('key') || '';
      const r = await auth.qrPoll(key);
      return sendJson(res, { ok: true, data: r });
    }
    if (p === '/api/bili/cookie' && req.method === 'POST') {
      const body = await readBody(req);
      const cookie = String(body.cookie || '');
      if (!cookie) return sendJson(res, { ok: false, error: '缺少 cookie' }, 400);
      auth.setCookieString(cookie);
      await auth.ensureBuvid();
      const info = await auth.checkLogin();
      return sendJson(res, { ok: true, data: info });
    }
    if (p === '/api/bili/logout' && req.method === 'POST') {
      auth.clear();
      return sendJson(res, { ok: true, message: '已退出 B 站登录' });
    }
    if (p === '/api/bili/nav') return sendJson(res, { ok: true, data: await auth.checkLogin() });
    if (p === '/api/danmaku/say' && req.method === 'POST') {
      const body = await readBody(req);
      if (!danmakuClient) return sendJson(res, { ok: false, error: '未连接直播间' }, 400);
      const r = await danmakuClient.sendDanmaku(String(body.text || ''));
      return sendJson(res, { ok: true, data: r });
    }

    // 诊断
    if (p === '/api/diagnostics') return sendJson(res, { ok: true, data: await diagnostics() });

    // 退出
    if (p === '/api/shutdown' && req.method === 'POST') {
      sendJson(res, { ok: true, message: '正在退出' });
      setTimeout(() => shutdown('http'), 300);
      return;
    }

    return sendJson(res, { ok: false, error: '未知接口 ' + p }, 404);
  } catch (e) {
    logger.error('HTTP 处理异常 ' + p + '：' + (e.stack || e.message));
    return sendJson(res, { ok: false, error: e.message }, 500);
  }
}

/**
 * 手动点歌的候选搜索：四个平台各返回前 per 个，附匹配等级。
 * 真实逻辑在 engine.searchCandidates 里，这里只做参数兜底。
 */
async function searchCandidates(name, singer, per) {
  try {
    return await engine.searchCandidates(name, singer || '', per || 3);
  } catch (e) {
    logger.error('候选搜索失败：' + (e.stack || e.message));
    return { keyword: name, per: per || 3, groups: [], error: e.message };
  }
}

/**
 * 从 /login/qr/check 的响应里提取登录 Cookie（实现见 core/qr-cookie.js）。
 * 网易云把凭证放在响应体里，且不同版本位置不一样，只读 Set-Cookie 头会漏掉。
 */
const { extractQrCookie, splitCookiePairs, mergeCookies } = require('./core/qr-cookie');

async function handleLogin(p, url, req, res) {
  // 路径形如 /api/login/<platform>/<action>
  const seg = p.split('/').filter(Boolean); // ['api','login','kugou','qr']
  const platform = seg[2] || '';
  const action = seg[3] || '';
  const adapter = engine.adapters[platform];
  if (!adapter) return sendJson(res, { ok: false, error: '未知平台 ' + platform }, 404);

  if (action === 'status') {
    const status = await adapter.ping();
    const port = (cfgMod.platforms[platform] && cfgMod.platforms[platform].port) || 0;
    return sendJson(res, {
      ok: true,
      data: { ...status, port, cookie: maskCookie((cfgMod.platforms[platform] || {}).cookie || '') },
    });
  }

  if (action === 'cookie' && req.method === 'POST') {
    const body = await readBody(req);
    const cookie = String(body.cookie || '');
    if (!cookie) return sendJson(res, { ok: false, error: '缺少 cookie' }, 400);
    cfgMod.savePlatforms({ [platform]: { cookie } });
    // 通知对应本地服务
    const port = (cfgMod.platforms[platform] && cfgMod.platforms[platform].port) || 0;
    try {
      await fetch('http://127.0.0.1:' + port + '/login/cookie?cookie=' + encodeURIComponent(cookie), { method: 'GET' });
    } catch {
      /* 服务可能未提供该接口，忽略 */
    }
    // 保存后立刻校验，别让用户以为存了就是登上了
    let check = null;
    if (adapter && typeof adapter.validateCookie === 'function') {
      try {
        check = await adapter.validateCookie(cookie);
      } catch (e) {
        check = { ok: false, error: e.message };
      }
    }
    const message = check
      ? check.ok
        ? 'Cookie 已保存，格式与本地服务识别都通过；实际能否取无损以「账号状态」里的音质为准'
        : 'Cookie 已保存，但校验未通过：' + (check.error || '未知原因')
      : '已保存 ' + platform + ' 登录 Cookie';
    return sendJson(res, {
      ok: true,
      data: {
        saved: true,
        validated: check ? Boolean(check.ok) : null,
        loggedIn: check ? Boolean(check.loggedIn) : null,
        user: (check && check.user) || '',
        message,
      },
      message,
    });
  }

  if (action === 'qr' && req.method === 'POST') {
    const port = (cfgMod.platforms[platform] && cfgMod.platforms[platform].port) || 0;
    const origin = 'http://127.0.0.1:' + port;
    try {
      // 酷我：走「微信扫码」（微信开放平台 qrconnect），由本地酷我服务处理
      if (platform === 'kuwo') {
        const r = await fetch(origin + '/login/qr');
        const j = await r.json();
        const d = (j && j.data) || {};
        if (!d.key) throw new Error((j && j.message) || '未取到二维码');
        return sendJson(res, {
          ok: true,
          data: { key: d.key, base64: d.base64 || '', url: d.url || '', qrKind: 'wechat', tip: d.tip || '' },
        });
      }

      // QQ 音乐：?kind=wx 走微信扫码（推荐），否则走 QQ 扫码（已被腾讯限制）
      if (platform === 'qq' && url.searchParams.get('kind') === 'wx') {
        const r = await fetch(origin + '/login/qr/wx');
        const j = await r.json();
        const d = (j && j.data) || {};
        if (!d.key) throw new Error((j && j.message) || '未取到微信二维码');
        return sendJson(res, {
          ok: true,
          data: { key: d.key, base64: d.base64 || '', url: d.url || '', qrKind: 'wechat', tip: d.tip || '' },
        });
      }

      // 网易云是两步：先 /login/qr/key 拿 unikey，再 /login/qr/create 出图
      if (platform === 'netease') {
        const kr = await fetch(origin + '/login/qr/key?timestamp=' + Date.now());
        const kj = await kr.json();
        const unikey = kj && kj.data && kj.data.unikey;
        if (!unikey) throw new Error('未取到 unikey：' + JSON.stringify(kj).slice(0, 120));
        const cr = await fetch(
          origin + '/login/qr/create?key=' + encodeURIComponent(unikey) + '&qrimg=true&timestamp=' + Date.now()
        );
        const cj = await cr.json();
        const cd = (cj && cj.data) || {};
        const url = cd.qrurl || '';
        let base64 = cd.qrimg || '';
        if (!base64 && url) {
          const made = await qrImage(url);
          if (made) base64 = made;
        }
        return sendJson(res, { ok: true, data: { key: unikey, base64, url, raw: cj } });
      }

      const r = await fetch(origin + '/login/qr/key?qrimg=true');
      const raw = await r.json();
      // 各平台返回结构不一致，这里统一成 { key, base64, url }
      const inner = raw.body && raw.body.data ? raw.body.data : raw.data || raw;
      let key = inner.qrcode || inner.qrcode_key || inner.key || '';
      let base64 = inner.qrcode_img || inner.base64 || '';
      let qrUrl = inner.url || '';

      // 部分平台（如酷狗）只给 key，这里补一个可扫的内容
      if (!qrUrl && key && platform === 'kugou') {
        qrUrl = 'https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=' + key;
      }
      // 前端要能直接 <img src>，没有图片就现场生成一张
      if (!base64 && qrUrl) {
        const dataUrl = await qrImage(qrUrl);
        if (dataUrl) base64 = dataUrl;
      }
      // QQ 会告诉我们它那边的扫码链路是否已被腾讯限制（见 QQMusicApi/live/server.js）
      const reachable = inner.loginReachable;
      const tip = inner.message || '';
      return sendJson(res, {
        ok: true,
        data: {
          key,
          base64,
          url: qrUrl,
          raw,
          loginReachable: reachable === undefined ? null : Boolean(reachable),
          tip: reachable === false ? tip : '',
        },
      });
    } catch (e) {
      return sendJson(res, { ok: false, error: '该平台扫码登录失败：' + e.message }, 400);
    }
  }

  if (action === 'qr-check') {
    const port = (cfgMod.platforms[platform] && cfgMod.platforms[platform].port) || 0;
    const key = url.searchParams.get('key') || '';

    // QQ 微信扫码：本地服务负责轮询 + 用 code 换 Cookie
    if (platform === 'qq' && url.searchParams.get('kind') === 'wx') {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/login/qr/wx/check?key=' + encodeURIComponent(key));
        const j = await r.json().catch(() => null);
        const d = (j && j.data) || {};
        const message = d.message || (j && j.message) || '';
        if (d.loggedIn) {
          try {
            const sr = await fetch('http://127.0.0.1:' + port + '/export/cookie');
            const sj = await sr.json();
            if (sj && sj.cookie) {
              cfgMod.savePlatforms({ qq: { cookie: sj.cookie, loggedInUser: d.musicid ? '已登录' : '' } });
            }
          } catch {
            /* 忽略 */
          }
        }
        return sendJson(res, {
          ok: true,
          data: {
            loggedIn: Boolean(d.loggedIn),
            status: d.status != null ? d.status : r.status,
            message,
            terminal: Boolean(d.terminal),
            // 换取登录态失败时把服务端返回带出来，界面才能显示「到底卡在哪一步」
            steps: d.steps || null,
            raw: d.raw || '',
          },
        });
      } catch (e) {
        return sendJson(res, { ok: true, data: { loggedIn: false, status: -1, message: '查询失败：' + e.message } });
      }
    }

    // 酷我微信扫码：本地服务负责轮询 + 用 code 换 Cookie，成功后直接把 Cookie 返回给我们
    if (platform === 'kuwo') {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/login/qr-check?key=' + encodeURIComponent(key));
        const j = await r.json().catch(() => null);
        const d = (j && j.data) || {};
        // 本地服务对「会话不存在/已过期」会返回 404，message 在顶层，别丢掉
        const message = d.message || (j && j.message) || '';
        if (d.loggedIn) {
          cfgMod.savePlatforms({ kuwo: { loggedInUser: d.nickname || '已登录' } });
          // 把本地服务保存的 Cookie 同步到统一配置
          try {
            const sr = await fetch('http://127.0.0.1:' + port + '/export/cookie');
            const sj = await sr.json();
            if (sj && sj.cookie) cfgMod.savePlatforms({ kuwo: { cookie: sj.cookie } });
          } catch {
            /* 老版本本地服务没有该接口，忽略 */
          }
        }
        return sendJson(res, {
          ok: true,
          data: {
            loggedIn: Boolean(d.loggedIn),
            status: d.status != null ? d.status : r.status,
            message,
            nickname: d.nickname || '',
            terminal: Boolean(d.terminal),
          },
        });
      } catch (e) {
        return sendJson(res, { ok: true, data: { loggedIn: false, status: -1, message: '查询失败：' + e.message } });
      }
    }

    try {
      const r = await fetch(
        'http://127.0.0.1:' + port + '/login/qr/check?key=' + encodeURIComponent(key) + '&timestamp=' + Date.now(),
        { redirect: 'manual' }
      );
      // 登录成功时会下发登录凭证，各平台位置不同，两种都要收：
      //   · Set-Cookie 头（酷狗）
      //   · 响应体里的 cookie 字段（网易云，位置还不固定）
      const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      const collected = [];
      for (const line of setCookies) {
        const kv = line.split(';')[0];
        const idx = kv.indexOf('=');
        if (idx > 0 && !/^(path|expires|domain|max-age|samesite|secure|httponly)$/i.test(kv.slice(0, idx).trim())) {
          collected.push(kv.trim());
        }
      }

      const j = await r.json();
      const inner = j.body && j.body.data ? j.body.data : j.data || j;

      // 网易云把登录 Cookie 放在响应体里（顶层 cookie / body.cookie / data.cookie），
      // 不取的话永远登不上 —— 只会拿到 NMTID 这种无关凭证。
      if (platform === 'netease') {
        const bodyCookie = extractQrCookie(j);
        if (bodyCookie) collected.push(...splitCookiePairs(bodyCookie));
      }

      if (collected.length) {
        const prev = (cfgMod.platforms[platform] && cfgMod.platforms[platform].cookie) || '';
        // 同名 Cookie 以新值为准
        cfgMod.savePlatforms({ [platform]: { cookie: mergeCookies([prev, ...collected]) } });
      }

      // 网易云返回的是顶层 code（801 等待 / 802 已扫码 / 803 成功 / 800 过期）
      const code = platform === 'netease' ? j.code : undefined;
      const status = inner.status != null ? inner.status : code != null ? code : j.status;
      let loggedIn = false;
      if (platform === 'kugou') loggedIn = String(status) === '4';
      else if (platform === 'qq') loggedIn = String(status) === '1';
      else if (platform === 'netease') loggedIn = code === 803 || String(status) === '803';
      else loggedIn = Boolean(inner.token);

      // 二次确认：扫码这一步说成功，但真正说话的是「当前账号」接口。
      // 参照参考项目：以 profile 为准，匿名账号（1000_XXX）不算登录。
      if (loggedIn && platform === 'netease' && adapter && typeof adapter.currentAccount === 'function') {
        try {
          const acc = await adapter.currentAccount();
          if (acc.loggedIn) {
            cfgMod.savePlatforms({ netease: { loggedInUser: acc.nickname || '已登录' } });
          } else if (!/(^|;\s*)MUSIC_U=/.test((cfgMod.platforms.netease && cfgMod.platforms.netease.cookie) || '')) {
            // 没有 MUSIC_U 就是没真正登录，别谎报成功
            loggedIn = false;
          }
        } catch {
          /* 查不到就按原判断 */
        }
      }

      if (loggedIn) {
        const cookie = (cfgMod.platforms[platform] && cfgMod.platforms[platform].cookie) || '';
        cfgMod.savePlatforms({ [platform]: { loggedInUser: '已登录' } });
        // 把 Cookie 同步给对应本地服务，便于其内部使用
        try {
          if (cookie) {
            await fetch('http://127.0.0.1:' + port + '/login/cookie?cookie=' + encodeURIComponent(cookie));
          }
        } catch {
          /* ignore */
        }
      }
      return sendJson(res, {
        ok: true,
        data: {
          status,
          code,
          message: statusMessage(platform, status, inner, j),
          loggedIn,
          collected: collected.length,
        },
      });
    } catch (e) {
      return sendJson(res, { ok: false, error: e.message }, 400);
    }
  }

  if (action === 'logout' && req.method === 'POST') {
    cfgMod.savePlatforms({ [platform]: { cookie: '', loggedInUser: '' } });
    const port = (cfgMod.platforms[platform] && cfgMod.platforms[platform].port) || 0;
    try {
      await fetch('http://127.0.0.1:' + port + '/logout', { method: 'GET' });
    } catch {
      /* ignore */
    }
    return sendJson(res, { ok: true, message: '已退出登录' });
  }

  return sendJson(res, { ok: false, error: '未知操作 ' + action }, 404);
}

/**
 * 统一账号状态：B 站 + 四个音乐平台。
 * 供 Web UI 的「账号登录」面板一次性拉取。
 */
async function accountsSnapshot() {
  const platforms = [
    { key: 'netease', label: '网易云音乐', qr: true },
    // QQ 音乐：QQ 扫码已被腾讯限制（二维码其实是「下载 App」链接），
    // 但**微信扫码可用**（配方移植自自带的 QQMusicApi Python 库），所以默认提供微信扫码。
    { key: 'qq', label: 'QQ音乐', qr: true, qrKind: 'wechat' },
    { key: 'kugou', label: '酷狗音乐', qr: true },
    // 酷我：支持「微信扫码」+「粘贴 Cookie」两种方式（微信扫码由本地酷我服务处理）
    { key: 'kuwo', label: '酷我音乐', qr: true, qrKind: 'wechat' },
  ];

  const rows = await Promise.all(
    platforms.map(async (meta) => {
      const cfg = cfgMod.platforms[meta.key] || {};
      const adapter = engine.adapters[meta.key];
      let online = false;
      let playable = false;
      let loggedIn = false;
      let user = '';
      let quality = '';
      let note = '';
      try {
        const ping = adapter ? await adapter.ping() : { ok: false };
        playable = Boolean(ping && ping.ok);
        online = playable || Boolean(ping && ping.error && !/未运行|ECONNREFUSED|fetch failed/i.test(ping.error));
        loggedIn = Boolean(ping && ping.loggedIn);
        user = (ping && ping.user) || '';
        quality = (ping && ping.quality) || '';
        note = (ping && ping.error) || '';
      } catch (e) {
        note = e.message;
      }

      // 服务在线但 ping 因为「未登录拿不到直链」而失败时，也要显示成在线
      if (!online) {
        try {
          const base = 'http://127.0.0.1:' + (cfg.port || 0);
          const r = await fetch(base + '/', { signal: AbortSignal.timeout(3000) });
          online = r.status < 500;
        } catch {
          online = false;
        }
      }

      if (!online) {
        note = '本地 API 服务未运行';
      } else if (meta.loginDisabled) {
        note = playable
          ? '无需登录，已可正常点歌' + (quality ? '（当前「' + quality + '」）' : '')
          : '无需登录，但当前取不到直链';
      } else if (playable && loggedIn) {
        note = '已登录，可正常取' + (quality ? '「' + quality + '」' : '高音质') + '直链';
      } else if (playable) {
        note = '可用（未登录，VIP 歌曲只能试听）' + (quality ? '，当前可取「' + quality + '」' : '');
      } else if (loggedIn) {
        note = note || '已登录，但当前取不到直链（换首歌或检查网络）';
      } else if (note) {
        // 保留适配器给出的更具体原因
      } else {
        note = '未登录（VIP 歌曲只能试听）';
      }

      return {
        key: meta.key,
        label: meta.label,
        port: cfg.port || 0,
        online,
        playable,
        loggedIn,
        loginDisabled: Boolean(meta.loginDisabled),
        qrKind: meta.qrKind || 'platform',
        user,
        quality,
        note,
        qr: meta.qr && !meta.loginDisabled,
        cookieMask: maskCookie(cfg.cookie || ''),
        hasCookie: Boolean((cfg.cookie || '').trim()),
      };
    })
  );

  // B 站
  let bili = { loggedIn: Boolean(auth && auth.loggedIn), uid: auth ? auth.selfUid : 0, uname: auth ? auth.selfName : '' };
  if (auth && auth.loggedIn) {
    try {
      const checked = await auth.checkLogin();
      bili = { loggedIn: Boolean(checked.loggedIn), uid: checked.uid || 0, uname: checked.uname || '' };
    } catch {
      /* 用本地缓存的状态 */
    }
  }

  return {
    bilibili: {
      key: 'bilibili',
      label: '哔哩哔哩（弹幕来源）',
      loggedIn: bili.loggedIn,
      user: bili.uname || '',
      uid: bili.uid || 0,
      note: bili.loggedIn ? '已登录（可显示点歌人昵称、可回复弹幕）' : '未登录（B 站会把昵称打码成 *，且无法回复弹幕）',
      qr: true,
      dmState: danmakuStatus().state,
      roomId: (cfgMod.config.danmaku && cfgMod.config.danmaku.roomId) || 0,
    },
    platforms: rows,
  };
}

function maskCookie(cookie) {
  if (!cookie) return '';
  if (cookie.length <= 24) return cookie;
  return cookie.slice(0, 12) + '...' + cookie.slice(-8);
}

/** 各平台扫码状态文案 */
function statusMessage(platform, status, inner, raw) {
  if (platform === 'kugou') {
    const map = { 0: '二维码已过期，请刷新', 1: '等待扫码', 2: '已扫码，请在手机上确认', 4: '登录成功' };
    return map[String(status)] || raw.message || raw.msg || '状态 ' + status;
  }
  if (platform === 'qq') {
    const map = { 0: '未扫码或已失效', 2: '等待扫码', 4: '已扫码，请在手机上确认', 1: '登录成功' };
    return inner.message || map[String(status)] || '状态 ' + status;
  }
  if (platform === 'netease') {
    const map = { 800: '二维码已过期，请刷新', 801: '等待扫码', 802: '已扫码，请在手机上确认', 803: '登录成功' };
    return map[String(status)] || (raw && raw.message) || '状态 ' + status;
  }
  return (raw && (raw.message || raw.msg)) || '状态 ' + status;
}

/**
 * 生成二维码图片（data URL）。
 * 复用 core/KuGouMusicApi 或 core/Netease-Api 里已安装的 qrcode 依赖；
 * 找不到时返回空串，前端会退化为显示链接。
 */
let _qrMod;
function loadQrModule() {
  if (_qrMod !== undefined) return _qrMod;
  const candidates = [
    path.join(cfgMod.CORE_DIR, 'KuGouMusicApi', 'node_modules', 'qrcode'),
    path.join(cfgMod.CORE_DIR, 'Netease-Api', 'node_modules', 'qrcode'),
    path.join(cfgMod.CORE_DIR, 'QQMusicApi', 'node_modules', 'qrcode'),
  ];
  _qrMod = null;
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        _qrMod = require(c);
        break;
      }
    } catch (e) {
      logger.debug('加载 qrcode 失败 ' + c + '：' + e.message);
    }
  }
  if (!_qrMod) logger.warn('未找到 qrcode 依赖，二维码图片将不可用（改用终端或链接方式）');
  return _qrMod;
}

async function qrImage(text) {
  const QR = loadQrModule();
  if (!QR) return '';
  try {
    return await QR.toDataURL(text, { margin: 1, width: 260, errorCorrectionLevel: 'M' });
  } catch (e) {
    logger.debug('二维码生成失败：' + e.message);
    return '';
  }
}

async function diagnostics() {
  const out = { mpv: {}, platforms: {}, danmaku: danmakuStatus(), ws: wsServer ? wsServer.size : 0 };
  const mpvPath = engine.player.mpvPath;
  out.mpv.path = mpvPath;
  out.mpv.exists = mpvPath === 'mpv.exe' ? 'PATH' : fs.existsSync(mpvPath);
  out.mpv.version = await new Promise((resolve) => {
    execFile(mpvPath, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve('不可用：' + err.message);
      resolve(String(stdout).split('\n')[0]);
    });
  });

  for (const key of Object.keys(engine.adapters)) {
    try {
      const status = await engine.adapters[key].ping();
      out.platforms[key] = { ...status, port: (cfgMod.platforms[key] || {}).port };
    } catch (e) {
      out.platforms[key] = { ok: false, error: e.message };
    }
  }
  out.servers = supervisor ? supervisor.snapshot() : {};
  return out;
}

function openBrowser(url) {
  try {
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  } catch {
    /* ignore */
  }
}

async function shutdown(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('正在退出（' + why + '）...');
  try {
    if (danmakuClient) danmakuClient.stop();
    if (engine) await engine.shutdown();
    if (wsServer) wsServer.closeAll();
    if (supervisor) supervisor.stopAll();
  } catch (e) {
    logger.warn('退出清理异常：' + e.message);
  }
  logger.info('已退出');
  setTimeout(() => process.exit(0), 300);
}

/**
 * 「控制台/管道已断开」这类错误要直接吞掉。
 * 否则：往 stdout 写失败 → 抛 EPIPE → 这里把它写进日志 → 又写 stdout → 又失败……
 * 会无限递归并把日志文件写到几个 GB（本项目真实踩过这个坑）。
 */
function isBrokenPipe(e) {
  if (!e) return false;
  const code = e.code || '';
  if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END') return true;
  return /broken pipe|EPIPE|write after end/i.test(String(e.message || ''));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => {
  if (isBrokenPipe(e)) return; // 对端没了，忽略，别再往控制台写
  logger.error('未捕获异常：' + (e.stack || e.message));
});
process.on('unhandledRejection', (e) => {
  if (isBrokenPipe(e)) return;
  logger.error('未处理的 Promise 拒绝：' + (e && e.stack ? e.stack : e));
});

boot().catch((e) => {
  logger.error('启动失败：' + (e.stack || e.message));
  console.error('\n启动失败：' + e.message);
  process.exit(1);
});
