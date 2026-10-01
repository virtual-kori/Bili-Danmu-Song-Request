/**
 * 平台登录工具（命令行版）。
 *
 * 用法：
 *   node core/Alogorithm-main/tools/login.js netease      # 网易云：扫码登录
 *   node core/Alogorithm-main/tools/login.js kugou        # 酷狗：扫码登录
 *   node core/Alogorithm-main/tools/login.js qq           # QQ 音乐：扫码（可能被风控，可退回粘贴 Cookie）
 *   node core/Alogorithm-main/tools/login.js kuwo         # 酷我：粘贴 Cookie（网页端无扫码接口）
 *   node core/Alogorithm-main/tools/login.js <平台> --cookie   # 强制走粘贴 Cookie
 *   node core/Alogorithm-main/tools/login.js <平台> --status   # 只看登录状态
 *
 * 说明：
 *   扫码流程 = 向对应平台的本地 API 服务申请二维码 → 终端画出来 + 弹出 PNG →
 *   轮询扫码状态 → 成功后把 Cookie 写入 core/platform-ports.json 并验证账号信息。
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const cfgMod = require('../core/config');
const qrUtil = require('./qr-util');

const CONFIG = {
  netease: { label: '网易云音乐', port: 33011, qr: true },
  kugou: { label: '酷狗音乐', port: 33013, qr: true },
  qq: { label: 'QQ音乐', port: 33012, qr: true },
  // 酷我：官方网页端没有二维码接口，但支持「微信扫码」——
  // 走微信开放平台的 qrconnect（appid wx41c1275bb3e28427），
  // 扫码后由酷我自己的 WeixinCallback → login_by_weixin_web 下发登录 Cookie。
  kuwo: { label: '酷我音乐', port: 33014, qr: true, qrKind: 'wechat' },
};

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function line(char = '=', n = 62) {
  return char.repeat(n);
}

function say(msg = '') {
  process.stdout.write(msg + '\n');
}

function ok(msg) {
  say(C.green + '  ✔ ' + msg + C.reset);
}
function warn(msg) {
  say(C.yellow + '  ! ' + msg + C.reset);
}
function fail(msg) {
  say(C.red + '  ✘ ' + msg + C.reset);
}
function info(msg) {
  say(C.cyan + '  · ' + msg + C.reset);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function base(platform) {
  const p = cfgMod.platforms[platform] || {};
  return 'http://127.0.0.1:' + (p.port || CONFIG[platform].port);
}

async function api(platform, pathname, params = {}, opts = {}) {
  const url = new URL(base(platform) + pathname);
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 12000);
  try {
    const res = await fetch(url.toString(), { method: opts.method || 'GET', signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { _raw: text };
    }
    return { status: res.status, json, setCookies: res.headers.getSetCookie ? res.headers.getSetCookie() : [] };
  } finally {
    clearTimeout(timer);
  }
}

/** 检查平台本地服务是否在线 */
async function checkService(platform) {
  const tries = ['/health', '/login/status', '/'];
  for (const t of tries) {
    try {
      const r = await api(platform, t, { timestamp: Date.now() }, { timeoutMs: 4000 });
      if (r.status && r.status < 500) return true;
    } catch {
      /* 换下一个探测路径 */
    }
  }
  return false;
}

function saveCookie(platform, cookie) {
  cfgMod.savePlatforms({ [platform]: { cookie } });
}

/** 把 Set-Cookie 数组转成 cookie 串（只取 name=value，并合并同名） */
function mergeSetCookies(list, prev) {
  const map = {};
  for (const part of String(prev || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) map[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  for (const line of list) {
    const kv = line.split(';')[0];
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    const k = kv.slice(0, i).trim();
    if (/^(path|expires|domain|max-age|samesite|secure|httponly)$/i.test(k)) continue;
    map[k] = kv.slice(i + 1).trim();
  }
  return Object.keys(map)
    .map((k) => k + '=' + map[k])
    .join('; ');
}

// ------------------------------------------------------------------ 各平台实现

/** 网易云：/login/qr/key → /login/qr/create → /login/qr/check */
async function loginNetease(timeoutSec) {
  const platform = 'netease';
  info('正在申请二维码…');
  const keyRes = await api(platform, '/login/qr/key', { timestamp: Date.now() });
  const unikey = keyRes.json && keyRes.json.data && keyRes.json.data.unikey;
  if (!unikey) throw new Error('未能取到二维码 key：' + JSON.stringify(keyRes.json).slice(0, 150));

  const createRes = await api(platform, '/login/qr/create', { key: unikey, qrimg: 'true', timestamp: Date.now() });
  const d = (createRes.json && createRes.json.data) || {};
  if (!d.qrurl) throw new Error('二维码生成失败：' + JSON.stringify(createRes.json).slice(0, 150));

  await showQr(platform, d.qrurl, d.qrimg, '手机网易云音乐 App → 左上角菜单 → 扫一扫');

  const deadline = Date.now() + timeoutSec * 1000;
  let lastCode = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    let r;
    try {
      r = await api(platform, '/login/qr/check', { key: unikey, timestamp: Date.now() });
    } catch (e) {
      warn('查询状态出错，重试中：' + e.message);
      continue;
    }
    const j = r.json || {};
    const code = j.code;
    if (code !== lastCode) {
      if (code === 801) info('等待扫码…');
      else if (code === 802) info('已扫码，请在手机上点「确认登录」');
      else if (code === 800) {
        fail('二维码已过期，请重新运行本程序');
        return null;
      } else if (code === 803) {
        /* 成功，下面处理 */
      } else info('状态 ' + code + ' ' + (j.message || ''));
    }
    if (code === 803) {
      const cookie = extractCookie(j, r.setCookies);
      if (!cookie) {
        fail('登录成功但没拿到 Cookie：' + JSON.stringify(j).slice(0, 200));
        return null;
      }
      saveCookie(platform, cookie);
      return cookie;
    }
    lastCode = code;
  }
  fail('等待扫码超时（' + timeoutSec + ' 秒）');
  return null;
}

/** 酷狗：/login/qr/key → /login/qr/check（status 4 = 成功，Cookie 在 Set-Cookie 里） */
async function loginKugou(timeoutSec) {
  const platform = 'kugou';
  info('正在申请二维码…');
  const keyRes = await api(platform, '/login/qr/key?qrimg=true', { timestamp: Date.now() });
  const inner = (keyRes.json && keyRes.json.body && keyRes.json.body.data) || (keyRes.json && keyRes.json.data) || {};
  const key = inner.qrcode || inner.key;
  const img = inner.qrcode_img || '';
  if (!key) throw new Error('未能取到二维码 key：' + JSON.stringify(keyRes.json).slice(0, 150));

  await showQr(platform, 'https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=' + key, img, '手机酷狗音乐 App → 我的 → 扫一扫');
  const deadline = Date.now() + timeoutSec * 1000;
  let prevCookie = (cfgMod.platforms.kugou && cfgMod.platforms.kugou.cookie) || '';
  let lastStatus = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    let r;
    try {
      r = await api(platform, '/login/qr/check', { key, timestamp: Date.now() });
    } catch (e) {
      warn('查询状态出错，重试中：' + e.message);
      continue;
    }
    const j = r.json || {};
    const body = (j.body && j.body.data) || j.data || j;
    const status = String(body.status != null ? body.status : j.status);
    if (r.setCookies && r.setCookies.length) {
      prevCookie = mergeSetCookies(r.setCookies, prevCookie);
      saveCookie(platform, prevCookie);
    }
    if (status !== lastStatus) {
      const map = { '0': '二维码已过期，请重新运行本程序', '1': '等待扫码…', '2': '已扫码，请在手机上点「确认」' };
      if (body.status === 4 || status === '4') info('登录成功');
      else if (map[status]) (status === '0' ? fail : info)(map[status]);
      else info('状态 ' + status + ' ' + (j.message || j.msg || ''));
    }
    if (status === '4' && /(^|;\s*)token=/.test(prevCookie)) {
      return prevCookie;
    }
    if (status === '0') return null;
    lastStatus = status;
  }
  fail('等待扫码超时（' + timeoutSec + ' 秒）');
  return null;
}

/** QQ 音乐：本地服务 /login/qr/key → /login/qr/check（status 1 = 成功） */
/**
 * 酷我：微信扫码登录。
 *
 * 酷我官方网页端没有自己的二维码接口，但支持微信开放平台的网站应用扫码授权。
 * 本地酷我服务（wechat-login.js）负责：申请二维码 → 长轮询状态 → 用 code 换登录 Cookie。
 */
async function loginKuwoWx(timeoutSec) {
  const platform = 'kuwo';
  info('正在申请微信二维码…');
  const qrRes = await api(platform, '/login/qr', {}, { timeoutMs: 25000 });
  const d = (qrRes.json && qrRes.json.data) || {};
  const key = d.key;
  if (!key) throw new Error('未能取到微信二维码：' + JSON.stringify(qrRes.json || {}).slice(0, 150));
  if (!d.base64) warn('本地服务未返回二维码图片，将只用终端二维码');

  await showQr(platform, d.url || '', d.base64 || '', '手机微信 → 扫一扫 → 在手机上点「确认登录」');

  const deadline = Date.now() + timeoutSec * 1000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    await sleep(2500);
    let r;
    try {
      r = await api(platform, '/login/qr-check', { key });
    } catch (e) {
      warn('查询状态出错，重试中：' + e.message);
      continue;
    }
    const j = (r.json && r.json.data) || {};
    const status = j.status;
    // 408 是长轮询的正常「未扫码」，不必反复刷屏
    if (status !== lastStatus && status !== 408 && j.message) info(j.message);
    if (j.loggedIn) {
      const cookieRes = await api(platform, '/login/status', {}, { timeoutMs: 12000 });
      const ck = (cookieRes.json && cookieRes.json.cookie) || '';
      if (ck) {
        saveCookie(platform, ck);
        return ck;
      }
      return '__logged_in__';
    }
    if (j.terminal) {
      fail(j.message || '二维码已失效');
      return null;
    }
    lastStatus = status;
  }
  fail('等待扫码超时（' + timeoutSec + ' 秒）');
  return null;
}

async function loginQQ(timeoutSec) {
  const platform = 'qq';
  info('正在申请二维码…');
  const keyRes = await api(platform, '/login/qr/key', {}, { method: 'POST', timeoutMs: 20000 });
  const d = keyRes.json || {};
  const key = d.key;
  if (!key) throw new Error('未能取到二维码 key：' + JSON.stringify(d).slice(0, 150));
  if (!d.base64) warn('本地服务未返回二维码图片，将只用终端二维码');

  await showQr(platform, '', d.base64 || '', '手机 QQ → 扫一扫（使用已登录 QQ 音乐的账号）');

  const deadline = Date.now() + timeoutSec * 1000;
  let lastStatus = null;
  while (Date.now() < deadline) {
    await sleep(2500);
    let r;
    try {
      r = await api(platform, '/login/qr/check', { key, timestamp: Date.now() });
    } catch (e) {
      warn('查询状态出错，重试中：' + e.message);
      continue;
    }
    const j = (r.json && r.json.data) || {};
    const status = String(j.status);
    if (status !== lastStatus && j.message) info(j.message);
    if (status === '1' || j.loggedIn) {
      const cookieRes = await api(platform, '/login/status', {});
      const ck = (cookieRes.json && cookieRes.json.cookie) || '';
      if (ck) saveCookie(platform, ck);
      return ck || '__logged_in__';
    }
    lastStatus = status;
  }
  fail('等待扫码超时（' + timeoutSec + ' 秒）');
  return null;
}

/** 通用：粘贴 Cookie 登录 */
async function loginByCookie(platform, presetCookie) {
  const meta = CONFIG[platform];
  const hints = {
    netease: '需要包含 MUSIC_U（浏览器登录 music.163.com 后 F12 → Application → Cookies 复制整行）',
    qq: '需要包含 uin 与 qm_keyst（或 qqmusic_key）：浏览器登录 y.qq.com 后复制整行',
    kugou: '需要包含 token 与 userid：浏览器登录 kugou.com 后复制整行',
    kuwo: '需要包含 userid、sid、t3、websid：浏览器登录 kuwo.cn 后复制整行',
  };

  if (platform === 'kuwo') {
    say('');
    say(C.yellow + '  酷我也可以用微信扫码登录（见菜单里的「微信扫码」选项）。' + C.reset);
    say(C.yellow + '  如果你更习惯手动复制，按下面步骤粘贴 Cookie 也可以。' + C.reset);
    say('');
    say('  操作步骤：');
    say('    1. 用浏览器打开 https://www.kuwo.cn/ 并登录你的 VIP 账号');
    say('    2. 按 F12 打开开发者工具 → Application/应用 → Storage/存储 → Cookies');
    say('    3. 找到 https://www.kuwo.cn 这一项，把里面所有条目复制成一行');
    say('       形如： userid=12345678; sid=xxxxxx; t3=xxxxx; websid=xxxxx');
    say('       也可以直接在 Console/控制台里执行： copy(document.cookie)');
    say('    4. 粘贴到下面并回车');
    say('');
  } else {
    say('');
    say('  粘贴 Cookie 登录（' + meta.label + '）');
    say('  ' + (hints[platform] || ''));
    say('  提示：若不想粘贴，可按 Ctrl+C 退出后改用扫码方式。');
    say('');
  }

  const cookie = presetCookie || (await ask('  请粘贴 Cookie：'));
  if (!cookie || !cookie.trim()) {
    fail('没有输入内容，已取消');
    return null;
  }
  saveCookie(platform, cookie.trim());
  ok('Cookie 已保存到 core/platform-ports.json');
  return cookie.trim();
}

function extractCookie(json, setCookies) {
  if (json && typeof json.cookie === 'string' && json.cookie.trim()) return json.cookie.trim();
  for (const container of [json && json.body, json && json.data]) {
    if (container && typeof container.cookie === 'string' && container.cookie.trim()) return container.cookie.trim();
  }
  if (setCookies && setCookies.length) {
    const merged = mergeSetCookies(setCookies, '');
    if (merged) return merged;
  }
  if (json && Array.isArray(json['set-cookie'])) {
    return mergeSetCookies(json['set-cookie'], '');
  }
  return '';
}

/** 终端 + 图片双通道展示二维码 */
async function showQr(platform, url, dataUrlOrBase64, hint) {
  const meta = CONFIG[platform];
  say('');
  say(C.bold + line() + C.reset);
  say(C.bold + '  请用手机扫码登录：' + meta.label + C.reset);
  say(C.dim + '  ' + (hint || '') + C.reset);
  say(C.bold + line() + C.reset);
  say('');

  let printed = false;
  if (url) printed = await qrUtil.printTerminal(url);
  if (!printed) {
    if (qrUtil.loadQrcode()) warn('终端未能绘制二维码，请看弹出的图片窗口');
    else warn('缺少 qrcode 依赖，无法在终端绘制二维码，请看弹出的图片');
  }

  if (dataUrlOrBase64) {
    const b64 = dataUrlOrBase64.includes(',')
      ? dataUrlOrBase64.slice(dataUrlOrBase64.indexOf(',') + 1)
      : dataUrlOrBase64;
    if (b64) {
      const file = path.join(qrUtil.CORE_DIR, 'Alogorithm-main', 'logs', 'login-qr-' + platform + '.png');
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(b64, 'base64'));
        info('二维码图片：' + file);
        qrUtil.openImage(file);
      } catch (e) {
        warn('保存二维码图片失败：' + e.message);
      }
    }
  } else if (url) {
    const file = await qrUtil.writePng(
      url,
      path.join(qrUtil.CORE_DIR, 'Alogorithm-main', 'logs', 'login-qr-' + platform + '.png')
    );
    if (file) {
      info('二维码图片：' + file);
      qrUtil.openImage(file);
    }
  }

  say('');
  say(C.dim + '  等待扫码中…（最多等待一段时间，超时可重跑本程序）' + C.reset);
  say('');
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** 验证登录并打印账号信息 */
async function verify(platform) {
  const meta = CONFIG[platform];
  say('');
  info('正在验证登录状态…');
  try {
    let r;
    if (platform === 'netease') {
      r = await api(platform, '/login/status', { timestamp: Date.now() });
      const p = r.json && r.json.data && r.json.data.profile;
      if (p) {
        ok('账号：' + p.nickname + '（uid ' + p.userId + '）');
        const vip = p.vipType || 0;
        ok('VIP：' + (vip ? '是（可播放 VIP 歌曲）' : '否（VIP 歌曲只能试听）'));
        return true;
      }
    } else if (platform === 'qq') {
      r = await api(platform, '/login/status', {});
      if (r.json && r.json.loggedIn) {
        ok('账号：' + (r.json.musicid || '已登录'));
        return true;
      }
    } else if (platform === 'kugou') {
      const cfg = (cfgMod.platforms.kugou && cfgMod.platforms.kugou.cookie) || '';
      const hasToken = /(^|;\s*)token=/.test(cfg);
      const hasUser = /(^|;\s*)userid=/.test(cfg);
      if (hasToken && hasUser) {
        ok('已保存酷狗登录凭证（token + userid）');
        return true;
      }
      warn('Cookie 中缺少 token 或 userid，可能未登录成功');
    } else if (platform === 'kuwo') {
      const cfg = (cfgMod.platforms.kuwo && cfgMod.platforms.kuwo.cookie) || '';
      const need = ['userid', 'sid', 't3'];
      const missing = need.filter((k) => !new RegExp('(^|;\\s*)' + k + '=').test(cfg));
      if (missing.length === 0) {
        ok('已保存酷我登录凭证');
        return true;
      }
      warn('Cookie 中缺少：' + missing.join('/') + '，VIP 歌曲可能仍无法播放');
    }
  } catch (e) {
    warn('验证失败：' + e.message);
  }
  say(C.dim + '  （可在 Web UI 的「体检」里再确认一次）' + C.reset);
  return false;
}

async function showStatus(platform) {
  const meta = CONFIG[platform];
  say('');
  say(C.bold + meta.label + ' 登录状态' + C.reset);
  const online = await checkService(platform);
  info('本地 API 服务：' + (online ? C.green + '在线' : C.red + '未运行') + C.reset + '（端口 ' + (cfgMod.platforms[platform].port || meta.port) + '）');
  const cookie = (cfgMod.platforms[platform] && cfgMod.platforms[platform].cookie) || '';
  info('已保存 Cookie：' + (cookie ? cookie.length + ' 字符' : '（空）'));
  if (online) await verify(platform);
  return online;
}

// ------------------------------------------------------------------ 主流程

async function main() {
  cfgMod.ensureConfigFiles();
  const args = process.argv.slice(2);
  const platform = (args.find((a) => !a.startsWith('--')) || '').toLowerCase();
  const forceCookie = args.includes('--cookie');
  const onlyStatus = args.includes('--status');
  const timeoutArg = args.find((a) => a.startsWith('--timeout='));
  const timeoutSec = timeoutArg ? Number(timeoutArg.split('=')[1]) || 300 : 300;
  const cookieArg = args.find((a) => a.startsWith('--cookie='));

  say('');
  say(C.bold + line() + C.reset);
  say(C.bold + '  弹幕点歌机 · 平台登录工具' + C.reset);
  say(C.bold + line() + C.reset);

  if (!platform || !CONFIG[platform]) {
    say('');
    say('  用法：');
    say('    node core\\Alogorithm-main\\tools\\login.js netease    网易云（扫码）');
    say('    node core\\Alogorithm-main\\tools\\login.js kugou      酷狗（扫码）');
    say('    node core\\Alogorithm-main\\tools\\login.js qq         QQ音乐（扫码）');
    say('    node core\\Alogorithm-main\\tools\\login.js kuwo       酷我（微信扫码）');
    say('    node core\\Alogorithm-main\\tools\\login.js <平台> --cookie    改用粘贴 Cookie');
    say('    node core\\Alogorithm-main\\tools\\login.js <平台> --status    只看登录状态');
    say('');
    say('  说明：酷我走「微信扫码」——手机微信扫一扫并在手机上确认即可；');
    say('        未登录时酷我走匿名接口，128k 标准音质也能正常点歌。');
    say('');
    return 1;
  }

  const meta = CONFIG[platform];
  say(C.bold + '  目标平台：' + meta.label + '（' + platform + '）' + C.reset);
  say('');

  // 该平台已停用登录
  if (meta.disabled) {
    say(C.yellow + '  ' + (meta.disabledReason || '该平台暂时不支持登录') + C.reset);
    say('');
    if (platform === 'kuwo') {
      say('  说明：');
      say('    · 未登录时酷我走 antiserver 匿名接口，128k 标准音质，点歌播放不受影响');
      say('    · 如果你确实想启用：把 core\\Alogorithm-main\\tools\\login.js 里');
      say('      kuwo 的 disabled 改成 false，再用「粘贴 Cookie」方式登录');
      say('');
    }
    return 0;
  }

  const online = await checkService(platform);
  if (!online) {
    fail('本地 API 服务没在运行（端口 ' + (cfgMod.platforms[platform].port || meta.port) + '）');
    say('');
    say('  请先双击根目录的 ' + C.bold + '启动.bat' + C.reset + '，等服务起来后再运行本登录程序。');
    say('  （登录完成后可以保持服务运行，也可以双击 停止.bat 关掉）');
    say('');
    return 1;
  }
  ok('本地 API 服务在线');

  if (onlyStatus) {
    await showStatus(platform);
    say('');
    return 0;
  }

  // 选择登录方式
  let useCookie = forceCookie || !meta.qr || Boolean(cookieArg);

  let cookie = null;
  if (useCookie) {
    cookie = await loginByCookie(platform, cookieArg ? cookieArg.split('=').slice(1).join('=') : '');
  } else {
    try {
      if (platform === 'netease') cookie = await loginNetease(timeoutSec);
      else if (platform === 'kugou') cookie = await loginKugou(timeoutSec);
      else if (platform === 'qq') cookie = await loginQQ(timeoutSec);
      else if (platform === 'kuwo') cookie = await loginKuwoWx(timeoutSec);
    } catch (e) {
      fail('扫码登录失败：' + e.message);
      say('');
      const answer = await ask('  要改用「粘贴 Cookie」方式再试一次吗？(y/N) ');
      if (/^y/i.test(answer.trim())) cookie = await loginByCookie(platform);
    }
  }

  say('');
  if (cookie) {
    ok('登录流程结束');
    await verify(platform);
    say('');
    info('下一步：回到 Web UI（http://127.0.0.1:33000）即可看到该平台已登录。');
  } else {
    fail('未完成登录');
    say('');
    info('可以重跑本程序，或直接在 Web UI 的「平台登录」里粘贴 Cookie。');
  }
  say('');
  return cookie ? 0 : 1;
}

main()
  .then((code) => {
    // 交互式场景不立刻退出，避免窗口一闪而过
    if (process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(C.dim + '按回车键关闭本窗口…' + C.reset, () => {
        rl.close();
        process.exit(code);
      });
    } else {
      process.exit(code);
    }
  })
  .catch((e) => {
    console.error(C.red + '出错了：' + (e.stack || e.message) + C.reset);
    process.exit(1);
  });
