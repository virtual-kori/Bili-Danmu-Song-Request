/**
 * B 站鉴权与 WBI 签名工具。
 *
 * 关键点（依据 bilibili-API-collect 2025-2026 变更）：
 *  - getDanmuInfo 自 2025-05-26 起强制 WBI 签名（w_rid + wts），并要求 Cookie 带 buvid3；
 *  - 未登录连接虽然能收到弹幕，但 uid 会被置 0、昵称被打码，因此必须扫码登录；
 *  - buvid3 不由扫码登录下发，需要单独调用 finger/spi 获取。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
];

const DATA_DIR = __dirname;
const AUTH_FILE = path.join(DATA_DIR, 'bili-auth.json');

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

/** 把 cookie 字符串解析成对象 */
function parseCookie(cookie) {
  const out = {};
  if (!cookie) return out;
  for (const part of String(cookie).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

/** cookie 对象转字符串 */
function cookieToString(obj) {
  return Object.keys(obj || {})
    .map((k) => k + '=' + obj[k])
    .join('; ');
}

/** 生成 mixin_key */
function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] || '')
    .join('')
    .slice(0, 32);
}

/** 对参数做 WBI 签名，返回 k=v&...&w_rid=xxx 形式的查询串 */
function encWbi(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey, subKey);
  const all = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(all)
    .sort()
    .map((k) => {
      const v = String(all[k]).replace(/[!'()*]/g, '');
      return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    })
    .join('&');
  return query + '&w_rid=' + md5(query + mixinKey);
}

class BiliAuth {
  constructor(logger) {
    this.logger = logger || { info() {}, warn() {}, debug() {}, error() {} };
    this.cookieObj = {};
    this.wbi = { imgKey: '', subKey: '', at: 0 };
    this.selfUid = 0;
    this.selfName = '';
    this.qrSessions = new Map();
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(AUTH_FILE)) return;
      const data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      this.cookieObj = data.cookie || {};
      this.selfUid = data.uid || 0;
      this.selfName = data.uname || '';
      this.logger.info('已载入 B 站登录态' + (this.selfUid ? '（uid=' + this.selfUid + '）' : ''));
    } catch (e) {
      this.logger.warn('读取 B 站登录态失败：' + e.message);
    }
  }

  save() {
    try {
      fs.writeFileSync(
        AUTH_FILE,
        JSON.stringify({ cookie: this.cookieObj, uid: this.selfUid, uname: this.selfName, at: Date.now() }, null, 2),
        'utf8'
      );
    } catch (e) {
      this.logger.warn('写入 B 站登录态失败：' + e.message);
    }
  }

  get cookieString() {
    return cookieToString(this.cookieObj);
  }

  get loggedIn() {
    return Boolean(this.cookieObj.SESSDATA);
  }

  get csrf() {
    return this.cookieObj.bili_jct || '';
  }

  get buvid3() {
    return this.cookieObj.buvid3 || '';
  }

  setCookieString(str) {
    const parsed = parseCookie(str);
    this.cookieObj = { ...this.cookieObj, ...parsed };
    const uid = parsed.DedeUserID || this.cookieObj.DedeUserID;
    if (uid) this.selfUid = Number(uid) || 0;
    this.save();
  }

  clear() {
    this.cookieObj = {};
    this.selfUid = 0;
    this.selfName = '';
    try {
      if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
    } catch {
      /* ignore */
    }
  }

  async request(url, options = {}) {
    const headers = {
      'User-Agent': UA,
      Referer: options.referer || 'https://www.bilibili.com/',
      ...(options.headers || {}),
    };
    const cookie = options.cookie === undefined ? this.cookieString : options.cookie;
    if (cookie) headers.Cookie = cookie;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
    try {
      const res = await fetch(url, { ...options, headers, signal: controller.signal });
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (setCookies.length && options.collectCookies !== false) {
        for (const line of setCookies) {
          const kv = line.split(';')[0];
          const idx = kv.indexOf('=');
          if (idx > 0) {
            const k = kv.slice(0, idx).trim();
            const v = kv.slice(idx + 1).trim();
            if (k === 'SESSDATA' || k === 'bili_jct' || k === 'DedeUserID' || k === 'buvid3' || k === 'buvid4' || k === 'sid') {
              this.cookieObj[k] = v;
            }
          }
        }
      }
      const text = await res.text();
      try {
        return { json: JSON.parse(text), raw: text, status: res.status, res };
      } catch {
        return { json: null, raw: text, status: res.status, res };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** 确保拿到 buvid3（扫码登录不会下发） */
  async ensureBuvid() {
    if (this.cookieObj.buvid3) return this.cookieObj.buvid3;
    try {
      const r = await this.request('https://api.bilibili.com/x/frontend/finger/spi', {
        referer: 'https://www.bilibili.com/',
        cookie: '',
      });
      const data = r.json && r.json.data;
      if (data && data.b_3) {
        this.cookieObj.buvid3 = data.b_3;
        if (data.b_4) this.cookieObj.buvid4 = data.b_4;
        this.save();
        this.logger.info('已获取 buvid3');
        return data.b_3;
      }
    } catch (e) {
      this.logger.warn('获取 buvid3 失败：' + e.message);
    }
    return '';
  }

  /** 获取 WBI 签名用的 img_key / sub_key（缓存 1 小时） */
  async ensureWbi(force = false) {
    if (!force && this.wbi.imgKey && Date.now() - this.wbi.at < 3600 * 1000) return this.wbi;
    try {
      const r = await this.request('https://api.bilibili.com/x/web-interface/nav', {
        referer: 'https://www.bilibili.com/',
      });
      const data = r.json && r.json.data;
      const img = data && data.wbi_img && data.wbi_img.img_url;
      const sub = data && data.wbi_img && data.wbi_img.sub_url;
      if (img && sub) {
        const name = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'));
        this.wbi = { imgKey: name(img), subKey: name(sub), at: Date.now() };
        if (data.mid) this.selfUid = data.mid;
        if (data.uname) this.selfName = data.uname;
        this.logger.debug('已更新 WBI 密钥');
        return this.wbi;
      }
    } catch (e) {
      this.logger.warn('获取 WBI 密钥失败：' + e.message);
    }
    return this.wbi;
  }

  /** 手动校验登录态（拿昵称等信息） */
  async checkLogin() {
    try {
      const r = await this.request('https://api.bilibili.com/x/web-interface/nav', {
        referer: 'https://www.bilibili.com/',
      });
      const data = (r.json && r.json.data) || {};
      const logged = Boolean(data.isLogin);
      if (logged) {
        this.selfUid = data.mid || this.selfUid;
        this.selfName = data.uname || this.selfName;
        this.save();
      }
      return { loggedIn: logged, uid: this.selfUid, uname: this.selfName };
    } catch (e) {
      return { loggedIn: this.loggedIn, uid: this.selfUid, uname: this.selfName, error: e.message };
    }
  }

  // ---------------------------------------------------------- 扫码登录

  async qrGenerate() {
    const r = await this.request('https://passport.bilibili.com/x/passport-login/web/qrcode/generate', {
      referer: 'https://www.bilibili.com/',
    });
    const data = r.json && r.json.data;
    if (!data || !data.url) throw new Error('获取二维码失败：' + (r.raw || '').slice(0, 120));
    const key = data.qrcode_key;
    this.qrSessions.set(key, { at: Date.now() });
    return { key, url: data.url };
  }

  async qrPoll(key) {
    if (!key) return { status: 'error', message: '缺少 key' };
    const r = await this.request(
      'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key),
      { referer: 'https://www.bilibili.com/' }
    );
    const json = r.json || {};
    const data = json.data || {};
    const code = data.code;
    if (code === 0) {
      // 优先从 url 的 query 里直接取 cookie（跨域登录地址会带全部 cookie）
      if (data.url) {
        try {
          const u = new URL(data.url);
          const sp = u.searchParams;
          for (const k of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']) {
            const v = sp.get(k);
            if (v) this.cookieObj[k] = v;
          }
        } catch {
          /* ignore */
        }
      }
      if (data.refresh_token) this.cookieObj.bili_refresh_token = data.refresh_token;
      await this.ensureBuvid();
      this.save();
      const info = await this.checkLogin();
      this.qrSessions.delete(key);
      return { status: 'success', ...info };
    }
    if (code === 86038) return { status: 'expired', message: '二维码已失效' };
    if (code === 86090) return { status: 'scanned', message: '已扫码，请在手机上确认' };
    if (code === 86101) return { status: 'waiting', message: '等待扫码' };
    return { status: 'unknown', code, message: json.message || data.message || '' };
  }

  /** 发送直播间弹幕（回复观众） */
  async sendDanmaku(roomId, msg) {
    if (!this.loggedIn || !this.csrf) {
      throw new Error('未登录或缺少 bili_jct，无法发送弹幕');
    }
    const body = new URLSearchParams({
      csrf: this.csrf,
      roomid: String(roomId),
      msg: String(msg).slice(0, 30),
      rnd: String(Math.round(Date.now() / 1000)),
      fontsize: '25',
      color: '16777215',
      mode: '1',
      bubble: '0',
      reply_mid: '0',
      jumpfrom: '0',
      reply_attr: '0',
      room_type: '0',
      statistics: '{"appId":100,"platform":5}',
    }).toString();

    const r = await this.request('https://api.live.bilibili.com/msg/send', {
      method: 'POST',
      referer: 'https://live.bilibili.com/' + roomId,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = r.json || {};
    if (json.code !== 0) {
      const map = {
        '-101': '账号未登录',
        '-111': 'csrf 校验失败',
        '-400': '请求参数错误',
        1003212: '弹幕内容过长',
        10031: '发送过于频繁，请稍后再试',
      };
      throw new Error(map[json.code] || json.message || '发送失败 code=' + json.code);
    }
    return json.data || {};
  }
}

module.exports = { BiliAuth, encWbi, getMixinKey, md5, parseCookie, cookieToString, UA, AUTH_FILE };
