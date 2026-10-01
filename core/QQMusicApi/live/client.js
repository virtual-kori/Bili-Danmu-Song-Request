/**
 * QQ 音乐 CGI 客户端（纯 Node，无第三方依赖）。
 *
 * 关键点：
 *  - 请求体结构 { comm, req_0 } 需要与官方 App/Web 一致，否则会返回空结果。
 *  - 部分接口（如加密取播放地址）需要 `sign=zzc...` 签名，算法见 sign.js。
 *  - 登录态通过 Cookie（uin + qm_keyst / qqmusic_key）携带；VIP 账号登录后
 *    才能取到高音质直链。
 */
const { zzcSign } = require('./sign');

const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const MUSICS_URL = 'https://u.y.qq.com/cgi-bin/musics.fcg';

const UA_ANDROID = 'QQMusic 14090008(android 12)';
const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 固定设备 GUID（服务端仅作设备标识用途） */
const GUID = '0'.repeat(32);

function hash33(str, seed = 5381) {
  let h = seed;
  for (let i = 0; i < str.length; i++) h = (h << 5) + h + str.charCodeAt(i);
  return h & 0x7fffffff;
}

/** 把 true/false 递归转换为 1/0（上游接口要求） */
function boolToInt(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  if (Array.isArray(value)) return value.map(boolToInt);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = boolToInt(value[key]);
    return out;
  }
  return value;
}

/** 解析 cookie 字符串为对象 */
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

/** 从 cookie 中提取登录凭证 */
function credentialFromCookie(cookie) {
  const c = typeof cookie === 'string' ? parseCookie(cookie) : cookie || {};
  const musickey = c.qm_keyst || c.qqmusic_key || c.musickey || '';
  const uinRaw = c.uin || c.qqmusic_uin || c.wxuin || '';
  const musicid = Number(String(uinRaw).replace(/\D/g, '')) || 0;
  let loginType = 0;
  if (musickey.startsWith('W_X')) loginType = 1;
  else if (musickey) loginType = 2;
  return { musicid, musickey, loginType, cookie: c };
}

function buildComm(platform, credential) {
  if (platform === 'android') {
    const comm = {
      ct: '11',
      cv: '14090008',
      v: '14090008',
      chid: '10003505',
      qq: '0',
      authst: '',
      tmeAppID: 'qqmusic',
      tmeLoginType: '0',
      QIMEI36: '',
      OpenUDID: GUID,
      udid: GUID,
      OpenUDID2: '',
      aid: '',
      os_ver: '12',
      phonetype: 'Android',
    };
    if (credential.musicid) {
      comm.qq = String(credential.musicid);
      comm.tmeLoginType = String(credential.loginType || 2);
    }
    if (credential.musickey) comm.authst = credential.musickey;
    return comm;
  }

  const gtk = credential.musickey ? String(hash33(credential.musickey, 5381)) : '5381';
  return {
    ct: '24',
    cv: '4747474',
    platform: 'yqq.json',
    chid: '0',
    uin: credential.musicid ? String(credential.musicid) : '0',
    g_tk: gtk,
    g_tk_new_20200303: gtk,
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    notice: '0',
    need_new_code: '1',
  };
}

function buildCookieHeader(credential) {
  const c = credential.cookie || {};
  const parts = [];
  for (const key of Object.keys(c)) parts.push(key + '=' + c[key]);
  if (credential.musicid && !('uin' in c)) parts.push('uin=' + credential.musicid);
  if (credential.musicid && !('qqmusic_uin' in c)) parts.push('qqmusic_uin=' + credential.musicid);
  if (credential.musickey && !('qm_keyst' in c)) parts.push('qm_keyst=' + credential.musickey);
  if (credential.musickey && !('qqmusic_key' in c)) parts.push('qqmusic_key=' + credential.musickey);
  return parts.join('; ');
}

/**
 * 执行一次 CGI 请求。
 *
 * @param {object} options
 * @param {string} options.module 模块名，如 music.search.SearchCgiService
 * @param {string} options.method 方法名，如 DoSearchForQQMusicMobile
 * @param {object} options.param 业务参数
 * @param {'android'|'web'} [options.platform] 平台，默认 android
 * @param {object|string} [options.credential] 登录凭证对象或 cookie 字符串
 * @param {boolean} [options.sign] 是否走 zzc 签名通道（musics.fcg）
 * @param {number} [options.timeoutMs] 超时毫秒
 * @returns {Promise<any>} req_0 的内容（含 code / data）
 */
async function cgiRequest(options) {
  const {
    module: moduleName,
    method,
    param = {},
    platform = 'android',
    sign = false,
    timeoutMs = 15000,
    comm: commOverride,
  } = options;

  let credential = options.credential;
  if (typeof credential === 'string' || credential == null) {
    credential = credentialFromCookie(credential || '');
  }

  // 允许调用方覆盖 comm 字段（登录接口需要 tmeLoginType=1 这类特殊值）
  const comm = Object.assign(buildComm(platform, credential), commOverride || {});
  const payload = {
    comm,
    req_0: { module: moduleName, method, param: boolToInt(param) },
  };
  const body = JSON.stringify(payload);

  const url = new URL(sign ? MUSICS_URL : MUSICU_URL);
  if (sign) {
    url.searchParams.set('_', String(Date.now()));
    url.searchParams.set('sign', zzcSign(body));
  }

  const headers = {
    'User-Agent': platform === 'android' ? UA_ANDROID : UA_WEB,
    'Content-Type': 'application/json',
    Referer: 'https://y.qq.com/',
    Origin: 'https://y.qq.com',
  };
  const cookieHeader = buildCookieHeader(credential);
  if (cookieHeader) headers.Cookie = cookieHeader;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), { method: 'POST', headers, body, signal: controller.signal });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('QQ 音乐返回非 JSON：' + text.slice(0, 200));
    }
    // 把原始响应挂上，方便上层在失败时给出可诊断的信息
    const out = json.req_0 || json;
    if (out && typeof out === 'object') {
      Object.defineProperty(out, '__raw', { value: json, enumerable: false, configurable: true });
      Object.defineProperty(out, '__status', { value: res.status, enumerable: false, configurable: true });
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** 带 URL 参数的 GET（用于 web 搜索等非 CGI 接口） */
async function httpGet(url, options = {}) {
  const headers = {
    'User-Agent': UA_WEB,
    Referer: 'https://y.qq.com/',
    ...(options.headers || {}),
  };
  if (options.cookie) {
    const cred = typeof options.cookie === 'string' ? credentialFromCookie(options.cookie) : options.cookie;
    const ch = buildCookieHeader(cred);
    if (ch) headers.Cookie = ch;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { _raw: text };
    }
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  cgiRequest,
  httpGet,
  parseCookie,
  credentialFromCookie,
  buildCookieHeader,
  hash33,
  boolToInt,
  zzcSign,
  GUID,
  UA_WEB,
};
