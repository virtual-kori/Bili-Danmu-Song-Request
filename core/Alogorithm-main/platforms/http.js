/**
 * 平台适配器公用的 HTTP 小工具。
 */
const logger = require('../core/logger').make('http');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 12000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, options = {}) {
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': DEFAULT_UA, ...(options.headers || {}) },
    timeoutMs: options.timeoutMs,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('返回非 JSON：' + text.slice(0, 160));
  }
}

/** 带 cookie 的本地 API 请求 */
async function getLocalJson(base, pathname, params = {}, options = {}) {
  const url = new URL(base.replace(/\/+$/, '') + pathname);
  for (const key of Object.keys(params)) {
    const v = params[key];
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(key, String(v));
  }
  const headers = { 'User-Agent': DEFAULT_UA };
  if (options.cookie) headers.Cookie = options.cookie;
  const res = await fetchWithTimeout(url.toString(), { headers, timeoutMs: options.timeoutMs || 15000 });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('本地 API 返回非 JSON（' + pathname + '）：' + text.slice(0, 160));
  }
}

/** 探测一个播放地址是否真的可用（返回 200/206 且有音频类型或字节） */
async function probeUrl(url, options = {}) {
  if (!url) return { ok: false, reason: '空地址' };
  try {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'User-Agent': DEFAULT_UA,
        Range: 'bytes=0-2047',
        ...(options.headers || {}),
      },
      timeoutMs: options.timeoutMs || 12000,
    });
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const len = Number(res.headers.get('content-length') || 0);
    if (res.status !== 200 && res.status !== 206) {
      // 某些 CDN 不允许 Range，退化为 HEAD 再试一次
      try {
        const head = await fetchWithTimeout(url, {
          method: 'HEAD',
          headers: { 'User-Agent': DEFAULT_UA, ...(options.headers || {}) },
          timeoutMs: options.timeoutMs || 12000,
        });
        if (head.status === 200) return { ok: true, status: 200, type: head.headers.get('content-type') || '' };
      } catch {
        /* ignore */
      }
      return { ok: false, reason: 'HTTP ' + res.status, status: res.status };
    }
    if (type.includes('text/html') || type.includes('application/json')) {
      return { ok: false, reason: '返回内容不是音频（' + type + '）', status: res.status };
    }
    if (len > 0 && len < 2048 && !type.startsWith('audio') && !type.includes('octet-stream')) {
      return { ok: false, reason: '内容过小（' + len + ' 字节）', status: res.status };
    }
    return { ok: true, status: res.status, type, len };
  } catch (e) {
    logger.debug('探测地址失败 ' + url.slice(0, 80) + ' : ' + e.message);
    return { ok: false, reason: e.message };
  }
}

module.exports = { fetchWithTimeout, getJson, getLocalJson, probeUrl, DEFAULT_UA };
