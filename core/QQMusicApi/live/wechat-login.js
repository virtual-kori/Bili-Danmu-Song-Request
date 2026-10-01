/**
 * QQ 音乐「微信扫码」登录。
 *
 * 配方来自本项目自带的 Python 库 `QQMusicApi/qqmusic_api/modules/login.py`
 * （`_get_wx_qr` / `_check_wx_qr` / `_authorize_wx_qr`），这里 1:1 移植成 Node：
 *
 *   1) 取二维码页面
 *      https://open.weixin.qq.com/connect/qrconnect
 *        ?appid=wx48db31d50e334801
 *        &redirect_uri=https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/
 *        &response_type=code&scope=snsapi_login&state=STATE
 *        &href=https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect
 *      页面里 `uuid":"..."` 就是会话标识。
 *   2) 二维码图 https://open.weixin.qq.com/connect/qrcode/<uuid>（JPEG）
 *   3) 长轮询 https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=<uuid>&_=<ms>
 *      返回 `window.wx_errcode=408;window.wx_code='';`
 *      （408 未扫 / 404 已扫待确认 / 405 已确认 / 402 已取消 / 403 已过期）
 *   4) 换成 QQ 音乐凭证：music.login.LoginServer / Login
 *      param = { code: wx_code, strAppid: 'wx48db31d50e334801' }, sign: true
 *      返回的 data 里有 musicid / musickey / strMusicID 等，据此拼出登录 Cookie。
 */
const { cgiRequest, UA_WEB } = require('./client');

const WX_APPID = 'wx48db31d50e334801';
const WX_REDIRECT = 'https://y.qq.com/portal/wx_redirect.html?login_type=2&surl=https://y.qq.com/';
const WX_HREF = 'https://y.qq.com/mediastyle/music_v17/src/css/popup_wechat.css#wechat_redirect';
const WX_QRCONNECT = 'https://open.weixin.qq.com/connect/qrconnect';
const WX_QRCODE_IMG = 'https://open.weixin.qq.com/connect/qrcode/';
const WX_LONGPOLL = 'https://lp.open.weixin.qq.com/connect/l/qrconnect';

const TIMEOUT_MS = 15000;

async function timedFetch(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 申请一个微信扫码会话。
 * @returns {Promise<{uuid:string, qrBase64:string, pageUrl:string}>}
 */
async function createWxQr() {
  const page =
    WX_QRCONNECT +
    '?appid=' + WX_APPID +
    '&redirect_uri=' + encodeURIComponent(WX_REDIRECT) +
    '&response_type=code&scope=snsapi_login&state=STATE' +
    '&href=' + encodeURIComponent(WX_HREF);
  const res = await timedFetch(page, { headers: { 'User-Agent': UA_WEB } });
  const html = await res.text();

  // 页面里形如 uuid":"xxxx"，也兼容 {"uuid":"..."}
  const m = /uuid["']?\s*[:=]\s*["']([A-Za-z0-9_-]{8,})["']/.exec(html) || /uuid=([A-Za-z0-9_-]{8,})/.exec(html);
  if (!m) throw new Error('微信未返回 uuid（页面结构可能已变）');
  const uuid = m[1];

  let qrBase64 = '';
  try {
    const img = await timedFetch(WX_QRCODE_IMG + uuid, {
      headers: { 'User-Agent': UA_WEB, Referer: WX_QRCONNECT },
    });
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.length > 100) {
      const type = (img.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
      qrBase64 = 'data:' + type + ';base64,' + buf.toString('base64');
    }
  } catch {
    /* 图拿不到就让前端退化成打开链接 */
  }

  return { uuid, qrBase64, pageUrl: page };
}

/**
 * 长轮询一次扫码状态。
 * @returns {Promise<{status:number, code:string, message:string, terminal:boolean}>}
 */
async function pollWxQr(uuid) {
  if (!uuid) return { status: -1, code: '', message: '会话已失效，请重新获取二维码', terminal: true };

  const res = await timedFetch(WX_LONGPOLL + '?uuid=' + encodeURIComponent(uuid) + '&_=' + Date.now(), {
    headers: { 'User-Agent': UA_WEB, Referer: 'https://open.weixin.qq.com/' },
    timeoutMs: 35000, // 未扫码时服务端会挂起
  });
  const body = await res.text();
  const m = /window\.wx_errcode=(\d+);window\.wx_code='([^']*)'/.exec(body);
  if (!m) return { status: -1, code: '', message: '无法解析微信返回：' + body.slice(0, 60), terminal: true };

  const errcode = Number(m[1]);
  const code = m[2] || '';
  const table = {
    408: { message: '等待扫码', terminal: false },
    404: { message: '已扫码，请在手机上确认', terminal: false },
    405: { message: '已确认', terminal: true },
    402: { message: '已在手机上取消登录', terminal: true },
    403: { message: '二维码已过期，请重新获取', terminal: true },
  };
  const info = table[errcode] || { message: '未知状态 errcode=' + errcode, terminal: true };
  if (errcode === 405 && !code) {
    return { status: errcode, code: '', message: '微信已确认但未返回授权码，请重试', terminal: true, failed: true };
  }
  return { status: errcode, code, message: info.message, terminal: info.terminal, failed: errcode !== 405 && info.terminal };
}

/** 把 QQ 音乐登录返回的凭证转成可用的 Cookie 字符串 */
function credentialToCookie(data) {
  if (!data || typeof data !== 'object') return '';
  const musicid = data.musicid || data.strMusicID || data.str_musicid || '';
  const musickey = data.musickey || data.musicKey || '';
  const parts = [];
  if (musickey) {
    parts.push('qm_keyst=' + musickey);
    parts.push('qqmusic_key=' + musickey);
  }
  if (musicid) {
    parts.push('uin=' + musicid);
    parts.push('qqmusic_uin=' + musicid);
  }
  // 微信登录特有的字段，服务器会用它们判断账号来源
  if (data.openid) parts.push('wxopenid=' + data.openid);
  if (data.unionid) parts.push('wxunionid=' + data.unionid);
  if (data.refresh_key) parts.push('refresh_key=' + data.refresh_key);
  if (data.refresh_token) parts.push('refresh_token=' + data.refresh_token);
  return parts.join('; ');
}

/**
 * 用微信授权 code 换 QQ 音乐登录凭证。
 * @returns {Promise<{ok:boolean, cookie:string, musicid:string, error:string, steps:string[], raw:string}>}
 */
async function exchangeWxCode(code) {
  const steps = [];
  if (!code) return { ok: false, cookie: '', musicid: '', error: '缺少微信授权码', steps, raw: '' };

  let resp;
  try {
    // 与 Python 版一致：登录接口走签名通道，并显式声明 tmeLoginType=1（微信）
    resp = await cgiRequest({
      module: 'music.login.LoginServer',
      method: 'Login',
      param: { code, strAppid: WX_APPID },
      comm: { tmeLoginType: 1, tmeAppID: 'qqmusic' },
      platform: 'android',
      sign: true,
      timeoutMs: 20000,
    });
  } catch (e) {
    steps.push('请求 LoginServer 失败');
    return { ok: false, cookie: '', musicid: '', error: '请求登录接口失败：' + e.message, steps, raw: '' };
  }

  const rc = resp && resp.code;
  const rawObj = resp && resp.__raw ? resp.__raw : resp;
  let raw = '';
  try {
    raw = JSON.stringify(rawObj).slice(0, 600);
  } catch {
    raw = String(rawObj).slice(0, 600);
  }
  steps.push('LoginServer/Login → code=' + rc + (resp && resp.__status ? '（HTTP ' + resp.__status + '）' : ''));

  if (rc !== 0) {
    const msg = (resp && (resp.message || resp.msg)) || '';
    const table = {
      20261: '登录参数错误',
      20271: '验证码错误',
      20272: '账号绑定异常',
      20274: '账号绑定缺失（这个微信号可能没绑定过 QQ 音乐）',
      20277: '账号受限',
      20278: '账号受限',
      20279: '设备数超限',
      20450: '账号已被封禁',
      104604: '触发频率限制，稍后再试',
      1000: '登录态已失效',
      104401: '登录态已失效',
      104400: '登录态已失效',
    };
    const hint = table[rc] || '未知错误';
    return { ok: false, cookie: '', musicid: '', error: hint + (msg ? '：' + msg : '') + '（code=' + rc + '）', steps, raw };
  }

  const data = (resp && resp.data) || {};
  const cookie = credentialToCookie(data);
  const musicid = String(data.musicid || data.strMusicID || data.str_musicid || '');
  steps.push('返回字段：' + Object.keys(data).slice(0, 12).join(',') + (Object.keys(data).length > 12 ? '…' : ''));
  if (!/qm_keyst=/.test(cookie)) {
    return {
      ok: false,
      cookie,
      musicid,
      error: '登录接口返回成功，但没有 musickey（无法构成登录 Cookie）',
      steps,
      raw,
    };
  }
  steps.push('已拼出登录 Cookie（musicid=' + musicid + '）');
  return { ok: true, cookie, musicid, error: '', steps, raw };
}

module.exports = { createWxQr, pollWxQr, exchangeWxCode, credentialToCookie, WX_APPID };
