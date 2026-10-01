/**
 * QQ 音乐本地 API 服务（纯 Node 实现，无第三方依赖）。
 *
 * 对外路由（与另外三个平台的本地 API 风格保持一致，便于核心统一调用）：
 *   GET /search/song?keywords=&page=&pagesize=   搜索歌曲
 *   GET /search?keywords=&limit=                 搜索歌曲（网易云风格别名）
 *   GET /song/url?id=MID|mid&quality=           取播放直链
 *   GET /lyric?id=MID                           取歌词
 *   GET /login/qr/key                           生成扫码登录二维码（QQ，base64）
 *   GET /login/qr/check?key=                    轮询 QQ 扫码状态
 *   GET /login/qr/wx                            生成微信扫码二维码（推荐）
 *   GET /login/qr/wx/check?key=                 轮询微信扫码状态，确认后自动换 Cookie
 *   GET /export/cookie                          导出当前 Cookie（供主程序落盘）
 *   GET /login/status                           当前登录状态
 *   GET /login/cookie?cookie=                   手动导入 cookie
 *   GET /logout                                 退出登录
 *   GET /health                                 健康检查
 *
 * 启动：node server.js（端口取环境变量 PORT，默认 33012）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cgiRequest, httpGet, credentialFromCookie, parseCookie } = require('./client');
const wxLogin = require('./wechat-login');

const PORT = Number(process.env.PORT || 33012);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const COOKIE_FILE = path.join(DATA_DIR, 'cookie.json');

const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 音质定义：从高到低尝试
const QUALITIES = [
  { key: 'master', label: '臻品母带', prefix: 'AI00', ext: '.flac' },
  { key: 'atmos', label: '臻品音质', prefix: 'Q000', ext: '.flac' },
  { key: 'flac', label: '无损FLAC', prefix: 'F000', ext: '.flac' },
  { key: 'ogg640', label: '无损OGG', prefix: 'O801', ext: '.ogg' },
  { key: 'ogg320', label: '高品质OGG', prefix: 'O800', ext: '.ogg' },
  { key: 'mp3_320', label: '高品质320', prefix: 'M800', ext: '.mp3' },
  { key: 'aac_192', label: '高品质AAC', prefix: 'C600', ext: '.m4a' },
  { key: 'mp3_128', label: '标准128', prefix: 'M500', ext: '.mp3' },
  { key: 'aac_96', label: '流畅96', prefix: 'C400', ext: '.m4a' },
];

// ---------------------------------------------------------------- 登录态管理

let credential = { musicid: 0, musickey: '', loginType: 0, cookie: {} };

function loadCredential() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      credential = credentialFromCookie(saved.cookie || '');
      return true;
    }
  } catch (e) {
    console.error('[warn] 读取 cookie 失败:', e.message);
  }
  return false;
}

function saveCredential(cookieString) {
  credential = credentialFromCookie(cookieString);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(COOKIE_FILE, JSON.stringify({ cookie: cookieString, at: Date.now() }, null, 2), 'utf8');
}

function clearCredential() {
  credential = { musicid: 0, musickey: '', loginType: 0, cookie: {} };
  try {
    if (fs.existsSync(COOKIE_FILE)) fs.unlinkSync(COOKIE_FILE);
  } catch { /* ignore */ }
}

/**
 * 最近一次微信扫码换取登录态的详细过程。
 * 换取失败时这里是「唯一能看出卡在哪一步」的地方。
 */
let wxLastDiag = null;

/**
 * 微信扫码会话缓存（只放内存，进程重启即失效）。
 * 5 分钟过期，超出上限时顺手清理。
 */
const wxSessions = {
  map: new Map(),
  TTL: 5 * 60 * 1000,
  put(session) {
    const key = crypto.randomBytes(12).toString('hex');
    this.map.set(key, { ...session, at: Date.now() });
    for (const [k, v] of this.map) {
      if (Date.now() - v.at > this.TTL) this.map.delete(k);
    }
    return key;
  },
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > this.TTL) {
      this.map.delete(key);
      return null;
    }
    return hit;
  },
  del(key) {
    this.map.delete(key);
  },
};

function cookieString() {
  const c = credential.cookie || {};
  return Object.keys(c)
    .map((k) => k + '=' + c[k])
    .join('; ');
}

// ---------------------------------------------------------------- 业务实现

/** 搜索歌曲（web 接口，字段最全：含 album / interval / media_mid） */
async function searchSong(keyword, page = 1, pagesize = 20) {
  const url =
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=' +
    page +
    '&n=' +
    pagesize +
    '&w=' +
    encodeURIComponent(keyword) +
    '&format=json&cr=1&new_json=1&platform=yqq.json&needNewCode=0&t=0';
  const res = await httpGet(url);
  const list = (res.data && res.data.song && res.data.song.list) || [];
  const songs = list.map((s) => ({
    id: s.mid,
    mid: s.mid,
    songId: s.id,
    name: s.name,
    title: s.title || s.name,
    subtitle: s.subtitle || '',
    singers: (s.singer || []).map((x) => x.name).filter(Boolean),
    singer: (s.singer || []).map((x) => x.name).filter(Boolean).join('、'),
    album: (s.album && (s.album.name || s.album.title)) || '',
    albumMid: s.album && s.album.mid,
    interval: s.interval || 0,
    duration: (s.interval || 0) * 1000,
    mediaMid: (s.file && s.file.media_mid) || s.mid,
    file: s.file || {},
    pay: s.pay || {},
    platform: 'qq',
    quality: '',
    url: '',
  }));
  return {
    code: 200,
    total: (res.data && res.data.song && res.data.song.totalnum) || songs.length,
    songs,
  };
}

/** 取播放直链：按音质从高到低尝试，返回第一个可用的 */
async function songUrl(mid, opts = {}) {
  const mediaMid = opts.mediaMid || mid;
  const onlyQuality = opts.quality ? QUALITIES.filter((q) => q.key === opts.quality) : QUALITIES;
  const tried = [];

  for (const q of onlyQuality) {
    const candidates = [q.prefix + mid + mediaMid + q.ext, q.prefix + mid + mid + q.ext];
    for (const filename of candidates) {
      let data;
      try {
        const res = await cgiRequest({
          module: 'music.vkey.GetVkey',
          method: 'UrlGetVkey',
          platform: 'android',
          credential,
          param: {
            uin: credential.musicid ? String(credential.musicid) : '0',
            filename: [filename],
            guid: '0'.repeat(32),
            songmid: [mid],
            songtype: [0],
            ctx: 0,
          },
        });
        data = res && res.data;
      } catch (e) {
        tried.push({ quality: q.key, filename, error: e.message });
        continue;
      }
      const info = data && data.midurlinfo && data.midurlinfo[0];
      const purl = info && info.purl;
      tried.push({
        quality: q.key,
        filename,
        result: info && info.result,
        errtype: info && info.errtype,
        hasPurl: Boolean(purl),
      });
      if (purl) {
        let sip = (data.sip && data.sip[0]) || 'https://isure.stream.qqmusic.qq.com/';
        if (!/^https?:/.test(sip)) sip = 'https://isure.stream.qqmusic.qq.com/';
        const url = sip.replace(/\/?$/, '/') + purl;
        return {
          code: 200,
          id: mid,
          quality: q.key,
          qualityLabel: q.label,
          url,
          size: info && info.fileSize ? Number(info.fileSize) : 0,
          filename,
          tried,
        };
      }
    }
  }
  return { code: 404, id: mid, url: '', message: '未取得可用播放地址（可能需要登录或该曲目无版权）', tried };
}

/** 取歌词 */
async function lyric(mid) {
  const res = await cgiRequest({
    module: 'music.musichallSong.PlayLyricInfo',
    method: 'GetPlayLyricInfo',
    param: { songMID: mid, songID: 0, format: 1 },
  });
  const d = res && res.data;
  const decode = (s) => (s ? Buffer.from(s, 'base64').toString('utf8') : '');
  return {
    code: 200,
    lyric: decode(d && d.lyric),
    trans: decode(d && d.trans),
    roma: decode(d && d.roma),
  };
}

// ---------------------------------------------------------------- 扫码登录

const loginSessions = new Map();

/**
 * 申请扫码登录二维码。
 *
 * 注意（实测 2026-10）：腾讯现在对这类请求做了限制，
 * `ptqrshow` 返回的二维码内容其实是 `http://txz.qq.com/p?k=...` —— 那是
 * **「下载 QQ 手机版」的落地页，不是登录码**；而 `ptqrlogin` 固定返回 403。
 * 试过调整 m/daid/pt_3rd_aid/appid 等参数都无效，属于平台侧限制。
 *
 * 这里仍然把二维码交给前端显示，但会带上 `qrIsDownloadCode` 提示，
 * 让界面能如实告诉用户「这个码扫了是下载 App，请改用粘贴 Cookie」。
 */
async function qrKey() {
  const ptqrtokenOf = (qrsig) => {
    let e = 0;
    for (let i = 0; i < qrsig.length; i++) {
      e += (e << 5) + qrsig.charCodeAt(i);
      e &= 0x7fffffff;
    }
    return e;
  };

  const res = await fetch('https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4&t=' + Math.random(), {
    headers: { 'User-Agent': UA_WEB, Referer: 'https://xui.ptlogin2.qq.com/' },
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  let qrsig = '';
  for (const line of setCookie) {
    const m = /qrsig=([^;]+)/.exec(line);
    if (m) qrsig = m[1];
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const key = crypto.randomBytes(8).toString('hex');
  loginSessions.set(key, { qrsig, ptqrtoken: ptqrtokenOf(qrsig), at: Date.now(), cookie: {} });

  // 立刻用 ptqrlogin 探一次：403/空体说明这条路已被封，提前告诉用户
  let reachable = true;
  try {
    const probe = await fetch(
      'https://ssl.ptlogin2.qq.com/ptqrlogin?u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump&ptqrtoken=' +
        ptqrtokenOf(qrsig) +
        '&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-' +
        Date.now() +
        '&js_ver=21020514&js_type=1&login_sig=&pt_uistyle=40&aid=716027609&daid=383&has_onekey=1',
      { headers: { 'User-Agent': UA_WEB, Referer: 'https://xui.ptlogin2.qq.com/', Cookie: 'qrsig=' + qrsig } }
    );
    const text = await probe.text();
    if (probe.status === 403 || !text.trim()) reachable = false;
  } catch {
    reachable = false;
  }

  return {
    code: 200,
    key,
    base64: 'data:image/png;base64,' + buf.toString('base64'),
    url: 'https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4',
    loginReachable: reachable,
    message: reachable
      ? '请用手机 QQ 扫码'
      : '腾讯限制了扫码登录：这个二维码扫出来是「下载 QQ 手机版」的链接，且状态查询接口返回 403。请改用「粘贴 Cookie」方式登录。',
  };
}

async function qrCheck(key) {
  const session = loginSessions.get(key);
  if (!session) return { code: 404, status: 0, message: '二维码已失效，请重新获取' };

  const url =
    'https://ssl.ptlogin2.qq.com/ptqrlogin?u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump&ptqrtoken=' +
    session.ptqrtoken +
    '&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-' +
    Date.now() +
    '&js_ver=21020514&js_type=1&login_sig=&pt_uistyle=40&aid=716027609&daid=383&has_onekey=1';
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA_WEB,
      Referer: 'https://xui.ptlogin2.qq.com/',
      Cookie: 'qrsig=' + session.qrsig,
    },
  });
  const text = await res.text();

  // QQ 有时返回空体或非标准体（风控/环境问题），这里显式给出可操作的提示
  if (!text || text.trim().length === 0) {
    return {
      code: 200,
      status: 0,
      message: 'QQ 登录接口未返回内容（常见于风控限制），请改用「粘贴 Cookie」方式登录',
    };
  }

  const m = /ptuiCB\((\d+),(\d+),'([^']*)','([^']*)','([^']*)'/.exec(text);
  if (!m) {
    return {
      code: 200,
      status: 0,
      message: '未识别返回，请改用「粘贴 Cookie」方式登录（原始返回：' + text.slice(0, 80) + '）',
    };
  }
  const codeNum = m[1];
  const redirect = m[3];

  if (codeNum === '66') return { code: 200, status: 2, message: '二维码未失效，请扫码' };
  if (codeNum === '67') return { code: 200, status: 4, message: '已扫码，请在手机上确认' };
  if (codeNum === '65') return { code: 200, status: 0, message: '二维码已失效，请重新获取' };
  if (codeNum !== '0') return { code: 200, status: 0, message: '登录失败：' + m[5] };

  // 登录成功，跟随跳转拿 cookie
  const follow = await fetch(redirect, {
    redirect: 'manual',
    headers: { 'User-Agent': UA_WEB, Cookie: 'qrsig=' + session.qrsig },
  });
  const cookies = {};
  const collect = (headers) => {
    const list = headers.getSetCookie ? headers.getSetCookie() : [];
    for (const line of list) {
      const kv = line.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) cookies[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
  };
  collect(follow.headers);
  const location = follow.headers.get('location');
  if (location) {
    try {
      collect(new Headers({ 'set-cookie': '' }));
      const next = await fetch(location, {
        redirect: 'manual',
        headers: { 'User-Agent': UA_WEB, Cookie: Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; ') },
      });
      collect(next.headers);
      const loc2 = next.headers.get('location');
      if (loc2) {
        const third = await fetch(loc2, {
          redirect: 'manual',
          headers: {
            'User-Agent': UA_WEB,
            Cookie: Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; '),
          },
        });
        collect(third.headers);
      }
    } catch (e) {
      console.error('[warn] 跟随跳转失败:', e.message);
    }
  }

  const cs = Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; ');
  if (cookies.qm_keyst || cookies.qqmusic_key || cookies.uin) {
    saveCredential(cs);
    loginSessions.delete(key);
    return { code: 200, status: 1, message: '登录成功', user: String(credential.musicid || '') };
  }
  return {
    code: 200,
    status: 0,
    message: '已授权但未取到登录凭证，请改用「粘贴 Cookie」方式登录',
    gotCookies: Object.keys(cookies),
  };
}

function loginStatus() {
  return {
    code: 200,
    loggedIn: Boolean(credential.musicid && credential.musickey),
    musicid: credential.musicid || 0,
    loginType: credential.loginType || 0,
    cookieKeys: Object.keys(credential.cookie || {}),
  };
}

// ---------------------------------------------------------------- HTTP 服务

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;

  try {
    if (p === '/health' || p === '/') {
      return sendJson(res, { code: 200, service: 'qq-music-api', loggedIn: Boolean(credential.musicid) });
    }
    if (p === '/search/song' || p === '/search') {
      const keywords = q.get('keywords') || q.get('key') || q.get('w') || '';
      if (!keywords) return sendJson(res, { code: 400, message: '缺少 keywords' }, 400);
      const page = Number(q.get('page') || q.get('p') || 1);
      const pagesize = Number(q.get('pagesize') || q.get('limit') || q.get('n') || 20);
      return sendJson(res, await searchSong(keywords, page, pagesize));
    }
    if (p === '/song/url' || p === '/song/urls') {
      const id = q.get('id') || q.get('mid') || '';
      if (!id) return sendJson(res, { code: 400, message: '缺少 id(mid)' }, 400);
      return sendJson(res, await songUrl(id, { mediaMid: q.get('mediaMid') || '', quality: q.get('quality') || '' }));
    }
    if (p === '/lyric') {
      const id = q.get('id') || q.get('mid') || '';
      if (!id) return sendJson(res, { code: 400, message: '缺少 id(mid)' }, 400);
      return sendJson(res, await lyric(id));
    }
    if (p === '/login/qr/key') return sendJson(res, await qrKey());
    if (p === '/login/qr/check') {
      const key = q.get('key') || '';
      if (!key) return sendJson(res, { code: 400, message: '缺少 key' }, 400);
      return sendJson(res, await qrCheck(key));
    }
    if (p === '/login/status') return sendJson(res, loginStatus());
    if (p === '/login/cookie') {
      const cookie = q.get('cookie') || '';
      if (!cookie) return sendJson(res, { code: 400, message: '缺少 cookie' }, 400);
      saveCredential(cookie);
      return sendJson(res, { code: 200, message: '已保存登录凭证', ...loginStatus() });
    }
    if (p === '/logout') {
      clearCredential();
      return sendJson(res, { code: 200, message: '已退出登录' });
    }
    if (p === '/export/cookie') {
      return sendJson(res, { code: 200, cookie: cookieString() || '' });
    }

    // 诊断：最近一次微信扫码的详细过程（换取登录态失败时用来定位问题）
    if (p === '/login/wx/diag') {
      return sendJson(res, { code: 200, data: wxLastDiag || {} });
    }

    // ---- 微信扫码（推荐）：配方移植自 QQMusicApi/qqmusic_api/modules/login.py ----
    if (p === '/login/qr/wx') {
      try {
        const s = await wxLogin.createWxQr();
        const key = wxSessions.put(s);
        return sendJson(res, {
          code: 200,
          message: '请用微信扫描二维码',
          data: { key, qrKind: 'wechat', base64: s.qrBase64, url: s.pageUrl, tip: '打开微信 → 扫一扫 → 在手机上点确认' },
        });
      } catch (e) {
        return sendJson(res, { code: 500, message: '获取微信二维码失败：' + e.message }, 500);
      }
    }
    if (p === '/login/qr/wx/check') {
      const key = q.get('key') || '';
      const sess = wxSessions.get(key);
      if (!sess) return sendJson(res, { code: 404, message: '会话已过期，请重新获取二维码', data: { loggedIn: false } }, 404);
      let st;
      try {
        st = await wxLogin.pollWxQr(sess.uuid);
      } catch (e) {
        return sendJson(res, { code: 200, data: { loggedIn: false, status: -1, message: '查询扫码状态失败：' + e.message } });
      }
      if (st.status === 405 && st.code) {
        let ex;
        try {
          ex = await wxLogin.exchangeWxCode(st.code);
        } catch (e) {
          wxSessions.del(key);
          wxLastDiag = { at: Date.now(), ok: false, step: 'exchange-throw', error: e.message, steps: [] };
          return sendJson(res, { code: 200, data: { loggedIn: false, status: -2, message: '换取登录态出错：' + e.message } });
        }
        wxLastDiag = {
          at: Date.now(),
          ok: Boolean(ex.ok),
          error: ex.error || '',
          steps: ex.steps || [],
          raw: ex.raw || '',
          codeLen: String(st.code || '').length,
        };
        if (ex.ok) {
          saveCredential(ex.cookie);
          wxSessions.del(key);
          return sendJson(res, {
            code: 200,
            data: { loggedIn: true, status: 405, message: '登录成功', musicid: ex.musicid, steps: ex.steps },
          });
        }
        wxSessions.del(key);
        console.error('[wx-login] 换取登录态失败：' + ex.error + ' | ' + (ex.steps || []).join(' → '));
        return sendJson(res, {
          code: 200,
          data: {
            loggedIn: false,
            status: -2,
            message: '微信已授权，但换取登录态失败：' + ex.error,
            steps: ex.steps,
            // 把服务端原始返回带出去，方便定位是「没绑定」还是「被风控」
            raw: ex.raw || '',
          },
        });
      }
      if (st.terminal) wxSessions.del(key);
      return sendJson(res, { code: 200, data: { loggedIn: false, status: st.status, message: st.message, terminal: Boolean(st.terminal) } });
    }

    return sendJson(res, { code: 404, message: '未知接口 ' + p }, 404);
  } catch (e) {
    console.error('[ERR]', p, e.stack || e.message);
    return sendJson(res, { code: 500, message: e.message }, 500);
  }
});

loadCredential();
server.listen(PORT, HOST, () => {
  console.log('QQ 音乐 API 已启动: http://' + HOST + ':' + PORT + (credential.musicid ? '（已登录 ' + credential.musicid + '）' : '（未登录）'));
});
