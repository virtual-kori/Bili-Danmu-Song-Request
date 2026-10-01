/**
 * 酷我音乐适配器。
 *
 * 关键事实（2026-09 实测）：
 *  - 网页版接口的 Secret 校验算法没变，但「盐」换成了新的 Cookie 名
 *    `Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324`（旧盐已失效，直接返回
 *    "The request is illegal!"）；
 *  - 歌曲搜索请用 /search/searchMusicBykeyWord（无需签名）；
 *  - 取播放地址：登录后走带签名的 playUrl 拿高音质，否则退回 antiserver 的
 *    convert_url3 匿名接口（免登录，稳定可用，通常 128k）。
 */
const { getJson, getLocalJson, DEFAULT_UA } = require('./http');
const logger = require('../core/logger').make('kuwo');

// 登录态判定与微信扫码共用同一套规则（酷我 / 酷我本地服务 / 主程序三处必须一致）
const { isLoggedInCookie } = require('../../kuwoMusicApi/live/wechat-login');

const TOKEN_COOKIE = 'Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324';

/** 酷我网页版 Secret 头算法（算法未变，盐需用当前 Cookie 名） */
function buildSecret(token, salt = TOKEN_COOKIE) {
  const e = String(salt || '');
  if (!e) return null;
  const t = String(token || '');
  let n = '';
  for (let i = 0; i < e.length; i++) n += e.charCodeAt(i).toString();
  const r = Math.floor(n.length / 5);
  const o = parseInt(n.charAt(r) + n.charAt(2 * r) + n.charAt(3 * r) + n.charAt(4 * r) + n.charAt(5 * r));
  if (!(o >= 2)) return null;
  const l = Math.ceil(e.length / 2);
  const c = Math.pow(2, 31) - 1;
  let d = Math.round(1e9 * Math.random()) % 1e8;
  for (n += d; n.length > 10; ) n = (parseInt(n.substring(0, 10)) + parseInt(n.substring(10, n.length))).toString();
  n = (o * n + l) % c;
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const hh = parseInt(t.charCodeAt(i) ^ Math.floor((n / c) * 255));
    out += hh < 16 ? '0' + hh.toString(16) : hh.toString(16);
    n = (o * n + l) % c;
  }
  for (d = d.toString(16); d.length < 8; ) d = '0' + d;
  return out + d;
}

function qualityLabel(br) {
  const map = { '2000kflac': '无损FLAC', '320kmp3': '高品质320', '192kmp3': '较高192', '128kmp3': '标准128' };
  return map[br] || br;
}

/** 把搜索接口返回的各种字段名统一成内部结构 */
function mapSong(s) {
  const rid = String(s.rid || s.MUSICRID || s.musicrid || s.id || '').replace(/^MUSIC_/i, '');
  return {
    platform: 'kuwo',
    platformLabel: '酷我音乐',
    songId: rid,
    rid,
    name: s.name || s.SONGNAME || s.songname || '',
    singer: s.artist || s.ARTIST || s.artistName || '',
    album: s.album || s.ALBUM || s.albumName || '',
    duration: (Number(s.duration || s.DURATION) || 0) * 1000,
    cover:
      s.pic ||
      (s.web_albumpic_short ? 'https://img2.kuwo.cn/star/albumcover/' + s.web_albumpic_short : '') ||
      '',
    raw: s,
  };
}

class KuwoAdapter {
  constructor(getPlatform) {
    this.key = 'kuwo';
    this.label = '酷我音乐';
    this.getPlatform = getPlatform;
    this.token = '';
    this.tokenAt = 0;
    this.lastError = '';
  }

  get localBase() {
    return 'http://127.0.0.1:' + (this.getPlatform().port || 33014);
  }

  get cookie() {
    return this.getPlatform().cookie || '';
  }

  /** 获取网页会话 token（当前 Cookie 名），失败也不阻塞（搜索无需签名） */
  async ensureToken(force = false) {
    const configured = this.getPlatform().token;
    if (configured && !force && !this.token) {
      this.token = configured;
      return this.token;
    }
    if (this.token && !force && Date.now() - this.tokenAt < 30 * 60 * 1000) return this.token;
    try {
      const res = await fetch('https://www.kuwo.cn/', {
        headers: { 'User-Agent': DEFAULT_UA, Accept: 'text/html,application/xhtml+xml' },
      });
      const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const line of setCookies) {
        const kv = line.split(';')[0];
        const idx = kv.indexOf('=');
        if (idx < 0) continue;
        const name = kv.slice(0, idx).trim();
        if (name === TOKEN_COOKIE || name === 'kw_token') {
          this.token = kv.slice(idx + 1).trim();
          this.tokenAt = Date.now();
          return this.token;
        }
      }
    } catch (e) {
      logger.debug('获取酷我 token 失败：' + e.message);
    }
    return this.token;
  }

  signedHeaders() {
    const token = this.token || '';
    const headers = {
      'User-Agent': DEFAULT_UA,
      Referer: 'https://www.kuwo.cn/',
      Accept: 'application/json, text/plain, */*',
    };
    if (token) {
      headers.Secret = buildSecret(token) || '';
      headers.Cookie = this.cookie || TOKEN_COOKIE + '=' + token;
    } else if (this.cookie) {
      headers.Cookie = this.cookie;
    }
    return headers;
  }

  /**
   * 判断 Cookie 里是否带着酷我的登录凭证。
   * 微信扫码登录下发的字段与手动粘贴略有不同（可能没有 sid），
   * 判定规则统一由 wechat-login 提供，避免三处逻辑漂移。
   */
  isLoggedInCookie(cookie) {
    return isLoggedInCookie(cookie);
  }

  async ping() {
    // 登录态看 Cookie 里有没有登录凭证；可用性看能否真的取到直链
    const cookie = this.cookie || '';
    const loggedIn = this.isLoggedInCookie(cookie);
    try {
      const list = await this.search('周杰伦', 5);
      if (!list.length) return { ok: false, loggedIn, user: '', error: this.lastError || '搜索无结果' };
      for (const cand of list.slice(0, 3)) {
        const u = await this.resolveUrl(cand);
        if (u && u.ok && u.url) {
          return { ok: true, loggedIn, user: loggedIn ? '已登录' : '', quality: u.qualityLabel || u.quality, error: '' };
        }
      }
      return { ok: false, loggedIn, user: loggedIn ? '已登录' : '', error: '取不到可用播放地址' };
    } catch (e) {
      return { ok: false, loggedIn, user: '', error: e.message };
    }
  }

  /** 搜索：优先无签名的 /search/searchMusicBykeyWord，其次旧接口与本地服务 */
  async search(keyword, limit = 15) {
    const errors = [];

    // 方案 1：网页版无签名搜索（当前网页搜索页使用的接口）
    try {
      const url =
        'https://www.kuwo.cn/search/searchMusicBykeyWord?vipver=1&client=kt&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&mobi=1&issubtitle=1&show_copyright_off=1&pn=1&rn=' +
        limit +
        '&all=' +
        encodeURIComponent(keyword);
      const res = await getJson(url, { headers: { 'User-Agent': DEFAULT_UA, Referer: 'https://www.kuwo.cn/' } });
      const list = (res && res.abslist) || [];
      if (list.length) return list.map(mapSong);
      errors.push('search: 无结果');
    } catch (e) {
      errors.push('search: ' + e.message);
    }

    // 方案 2：旧版移动端 r.s 接口
    try {
      const url =
        'http://search.kuwo.cn/r.s?client=kt&all=' +
        encodeURIComponent(keyword) +
        '&pn=0&rn=' +
        limit +
        '&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1';
      const res = await getJson(url, { headers: { 'User-Agent': DEFAULT_UA } });
      const list = (res && res.abslist) || [];
      if (list.length) return list.map(mapSong);
      errors.push('legacy: 无结果');
    } catch (e) {
      errors.push('legacy: ' + e.message);
    }

    // 方案 3：本地 kuwoMusicApi 服务
    try {
      const res = await getLocalJson(this.localBase, '/search/song', { keywords: keyword, limit }, { timeoutMs: 12000 });
      const list = (res && res.data && res.data.list) || [];
      if (list.length) return list.map(mapSong);
      errors.push('local: ' + ((res && res.msg) || '无结果'));
    } catch (e) {
      errors.push('local: ' + e.message);
    }

    this.lastError = errors.join(' | ');
    logger.warn('酷我搜索全部方案失败：' + this.lastError);
    return [];
  }

  /** 取播放地址：VIP 账号走签名接口拿高音质，否则退回匿名接口 */
  async resolveUrl(candidate) {
    const rid = candidate.rid || candidate.songId;
    const errors = [];

    // 方案 1：签名接口（需要登录 Cookie 才能拿无损/320）
    if (this.cookie) {
      try {
        await this.ensureToken();
        for (const br of ['2000kflac', '320kmp3', '128kmp3']) {
          const url =
            'https://www.kuwo.cn/api/v1/www/music/playUrl?mid=' +
            rid +
            '&type=music&httpsStatus=1&plat=web_www&from=&br=' +
            br;
          const res = await getJson(url, { headers: this.signedHeaders() });
          const playUrl = res && res.data && res.data.url;
          if (playUrl) return { ok: true, url: playUrl, quality: br, qualityLabel: qualityLabel(br) };
          errors.push('playUrl(' + br + '): ' + ((res && (res.msg || res.message)) || '无地址'));
        }
      } catch (e) {
        errors.push('playUrl: ' + e.message);
      }
    }

    // 方案 2：匿名接口（免登录、免签名，稳定可用）
    for (const url of [
      'https://antiserver.kuwo.cn/anti.s?type=convert_url3&rid=' + rid + '&format=mp3&response=url',
      'https://antiserver.kuwo.cn/anti.s?type=convert_url&rid=MUSIC_' + rid + '&format=mp3&response=url',
    ]) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(url, {
          headers: { 'User-Agent': DEFAULT_UA, Referer: 'https://www.kuwo.cn/' },
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = (await res.text()).trim();
        let playUrl = '';
        if (text.startsWith('{')) {
          try {
            const j = JSON.parse(text);
            playUrl = (j && (j.url || (j.data && j.data.url))) || '';
          } catch {
            /* ignore */
          }
        } else if (/^https?:\/\//.test(text)) {
          playUrl = text;
        }
        if (playUrl) return { ok: true, url: playUrl, quality: '128kmp3', qualityLabel: '标准128' };
        errors.push('antiserver: 无地址');
      } catch (e) {
        errors.push('antiserver: ' + e.message);
      }
    }

    // 方案 3：本地服务
    try {
      const res = await getLocalJson(this.localBase, '/song/url', { id: rid, br: '320kmp3' }, { timeoutMs: 12000 });
      const playUrl = res && res.data && res.data.url;
      if (playUrl) return { ok: true, url: playUrl, quality: '320kmp3', qualityLabel: '高品质320' };
    } catch (e) {
      errors.push('local: ' + e.message);
    }

    return { ok: false, error: errors.slice(-3).join(' | ') };
  }

  async lyric(rid) {
    try {
      const res = await getJson('https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=' + rid + '&httpsStatus=1', {
        headers: this.signedHeaders(),
      });
      const list = res && res.data && res.data.lrclist;
      if (!Array.isArray(list)) return '';
      return list
        .map((l) => {
          const t = parseFloat(l.time) || 0;
          const mm = String(Math.floor(t / 60)).padStart(2, '0');
          const ss = String(Math.floor(t % 60)).padStart(2, '0');
          const xx = String(Math.floor((t % 1) * 100)).padStart(2, '0');
          return '[' + mm + ':' + ss + '.' + xx + ']' + (l.lineLyric || '');
        })
        .join('\n');
    } catch {
      return '';
    }
  }

  /** 推荐曲：榜单接口需要签名，失败时用无签名搜索兜底 */
  async recommendSongs(count = 20) {
    try {
      await this.ensureToken();
      const res = await getJson(
        'https://www.kuwo.cn/api/www/bang/bang/musicList?bangId=93&pn=1&rn=' + count + '&httpsStatus=1',
        { headers: this.signedHeaders() }
      );
      const list = (res && res.data && res.data.musicList) || [];
      if (list.length) return list.map(mapSong);
    } catch (e) {
      logger.debug('酷我榜单推荐失败：' + e.message);
    }
    return this.search('热门歌曲', count);
  }

  async playlistSongs(playlistId, count = 20) {
    try {
      await this.ensureToken();
      const res = await getJson(
        'https://www.kuwo.cn/api/www/playlist/playListInfo?pid=' + playlistId + '&pn=1&rn=' + count + '&httpsStatus=1',
        { headers: this.signedHeaders() }
      );
      const list = (res && res.data && res.data.musicList) || [];
      return list.map(mapSong);
    } catch {
      return [];
    }
  }
}

module.exports = { KuwoAdapter, buildSecret, TOKEN_COOKIE, qualityLabel, mapSong };
