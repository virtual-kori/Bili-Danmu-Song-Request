/**
 * 扫码登录里的 Cookie 提取工具。
 *
 * 参照参考项目（B站弹幕点歌机器人便携版 `netease_api.cookie_from_qr_response`）：
 * 网易云的登录凭证放在 `/login/qr/check` 的**响应体**里，而且不同版本位置不一样
 * （顶层 cookie / body.cookie / data.cookie / set-cookie 数组），
 * 只看 Set-Cookie 头是拿不到的。
 */

/** 这些是 Cookie 的属性，不是键值对，合并时要丢掉 */
const COOKIE_ATTR = /^(path|expires|domain|max-age|samesite|secure|httponly)$/i;

/**
 * 从扫码查询接口的响应里提取登录 Cookie 字符串。
 * @param {object} data 解析后的 JSON
 * @returns {string} 形如 "MUSIC_U=xxx; __csrf=yyy"，提取不到返回空串
 */
function extractQrCookie(data) {
  if (!data || typeof data !== 'object') return '';

  const top = data.cookie;
  if (typeof top === 'string' && top.trim()) return top.trim();

  for (const key of ['body', 'data']) {
    const c = data[key];
    if (c && typeof c === 'object' && typeof c.cookie === 'string' && c.cookie.trim()) {
      return c.cookie.trim();
    }
  }

  // 兜底：把 set-cookie 数组拼起来
  const arr = data['set-cookie'] || data.setCookie;
  if (Array.isArray(arr)) {
    const parts = [];
    for (const item of arr) {
      if (typeof item === 'string' && item.includes('=')) parts.push(item.split(';', 1)[0].trim());
    }
    if (parts.length) return parts.join('; ');
  }
  return '';
}

/**
 * 把 "a=1; b=2; Path=/" 拆成 ["a=1", "b=2"]，丢掉属性项。
 * @param {string} cookieStr
 * @returns {string[]}
 */
function splitCookiePairs(cookieStr) {
  const out = [];
  for (const part of String(cookieStr || '').split(';')) {
    const kv = part.trim();
    const i = kv.indexOf('=');
    if (i <= 0) continue;
    if (COOKIE_ATTR.test(kv.slice(0, i).trim())) continue;
    out.push(kv);
  }
  return out;
}

/**
 * 合并多份 Cookie 字符串，**同名以最新的为准**。
 * @param {string[]} parts
 * @returns {string}
 */
function mergeCookies(parts) {
  const map = new Map();
  for (const p of parts) {
    for (const kv of splitCookiePairs(p)) {
      const i = kv.indexOf('=');
      map.set(kv.slice(0, i).trim(), kv);
    }
  }
  return [...map.values()].join('; ');
}

module.exports = { extractQrCookie, splitCookiePairs, mergeCookies };
