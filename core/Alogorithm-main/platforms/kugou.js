/**
 * 酷狗音乐适配器。
 *
 * 直连酷狗移动端搜索接口（无需登录即可搜索），取播放地址时优先走本地
 * KuGouMusicApi 服务（带登录 Cookie 才拿得到高音质），失败则回退到
 * 公开的 get_res_privilege 接口。
 */
const { getJson, getLocalJson, DEFAULT_UA } = require('./http');
const logger = require('../core/logger').make('kugou');

const MOBILE_UA = 'IPhone-8990-searchSong';

const QUALITY_STEPS = [
  { key: 'flac', label: '无损FLAC', field: 'sqhash', privilege: 'sqprivilege' },
  { key: '320', label: '高品质320', field: '320hash', privilege: '320privilege' },
  { key: '128', label: '标准128', field: 'hash', privilege: '128privilege' },
];

class KugouAdapter {
  constructor(getPlatform) {
    this.key = 'kugou';
    this.label = '酷狗音乐';
    this.getPlatform = getPlatform;
    this.base = 'http://mobilecdn.kugou.com';
  }

  get localBase() {
    return 'http://127.0.0.1:' + (this.getPlatform().port || 33013);
  }

  get cookie() {
    return this.getPlatform().cookie || '';
  }

  /** 取一次设备指纹 dfid（酷狗取直链时必须有，否则会返回「本次请求需要验证」） */
  async ensureDfid() {
    if (this.dfid && Date.now() - this.dfidAt < 12 * 60 * 60 * 1000) return this.dfid;
    try {
      const res = await getLocalJson(this.localBase, '/register/dev', { timestamp: Date.now() }, { timeoutMs: 8000 });
      const dfid = res && res.data && res.data.dfid;
      if (dfid) {
        this.dfid = dfid;
        this.dfidAt = Date.now();
        logger.info('酷狗设备指纹 dfid=' + dfid);
        return dfid;
      }
    } catch (e) {
      logger.debug('注册酷狗设备失败：' + e.message);
    }
    return this.dfid || '';
  }

  /** 组合出带回登录态与 dfid 的 cookie 串 */
  async effectiveCookie() {
    const parts = [];
    if (this.cookie) parts.push(this.cookie);
    const dfid = await this.ensureDfid();
    if (dfid && !/dfid=/.test(this.cookie)) parts.push('dfid=' + dfid);
    return parts.join('; ');
  }

  async ping() {
    // 「已登录」的判据不是「能搜到歌」（酷狗搜索本来就不需要登录），
    // 而是「浏览器 Cookie 里有没有登录凭证」；「可用」则看能否真的取到直链。
    const cookie = this.cookie || '';
    const hasToken = /(^|;\s*)token=/.test(cookie);
    const hasUser = /(^|;\s*)userid=/.test(cookie);
    const loggedIn = hasToken && hasUser;

    // 酷狗拿不到昵称，但 Cookie 里有 userid，就把它当账号名显示。
    const uidMatch = /(?:^|;\s*)userid=([^;]+)/.exec(cookie);
    const accountName = loggedIn && uidMatch ? uidMatch[1].trim() : '';

    try {
      const list = await this.search('周杰伦', 5);
      if (!list.length) return { ok: false, loggedIn, user: accountName, error: '搜索无结果（酷狗接口可能已变动）' };
      for (const cand of list.slice(0, 3)) {
        const r = await this.resolveUrl(cand);
        if (r && r.ok && r.url) {
          return { ok: true, loggedIn, user: accountName, quality: r.qualityLabel || r.quality, error: '' };
        }
      }
      return {
        ok: false,
        loggedIn,
        user: accountName,
        error: loggedIn ? '已登录但取不到直链（该曲可能需付费）' : '未登录：热门/付费曲取不到直链',
      };
    } catch (e) {
      return { ok: false, loggedIn, user: '', error: e.message };
    }
  }

  async search(keyword, limit = 15) {
    // 1) 本地 KuGouMusicApi（已修好搜索参数，且能给出 SQ/HQ 哈希）
    try {
      const res = await getLocalJson(
        this.localBase,
        '/search/song',
        { keywords: keyword, page: 1, pagesize: limit, timestamp: Date.now() },
        { cookie: this.cookie, timeoutMs: 12000 }
      );
      const list = (res && res.data && res.data.lists) || [];
      if (list.length) return list.map((s) => this.mapLocalSong(s));
    } catch (e) {
      logger.debug('本地酷狗搜索失败，回退移动端接口：' + e.message);
    }

    // 2) 移动端公开接口
    const url =
      this.base +
      '/api/v3/search/song?api_ver=1&area_code=1&correct=1&pagesize=' +
      limit +
      '&plat=2&tag=1&sver=5&showtype=10&page=1&keyword=' +
      encodeURIComponent(keyword) +
      '&version=8990';
    const res = await getJson(url, { headers: { 'User-Agent': MOBILE_UA, 'UNI-UserAgent': 'iOS11.4-Phone8990-1009-0-WiFi' } });
    const list = (res && res.data && res.data.info) || [];
    return list.map((s) => this.mapMobileSong(s));
  }

  /** 本地接口返回结构 */
  mapLocalSong(s) {
    const fileName = s.FileName || '';
    const dash = fileName.indexOf(' - ');
    const singer = s.SingerName || (dash > 0 ? fileName.slice(0, dash) : '');
    const name = s.SongName || (dash > 0 ? fileName.slice(dash + 3) : fileName);
    return {
      platform: this.key,
      platformLabel: this.label,
      songId: (s.FileHash || '').toLowerCase(),
      name,
      singer,
      album: s.AlbumName || '',
      duration: (Number(s.Duration) || 0) * 1000,
      cover: '',
      hash: (s.FileHash || '').toLowerCase(),
      sqhash: (s.SQFileHash || '').toLowerCase(),
      hqhash: (s.HQFileHash || '').toLowerCase(),
      albumId: s.AlbumID || '',
      albumAudioId: s.Audioid || s.Audioid || '',
      audioId: s.Audioid || '',
      privilege: { 128: s.Privilege, 320: s.Privilege, sq: s.Privilege },
      payType: s.PayType,
      raw: s,
    };
  }

  /** 移动端接口返回结构 */
  mapMobileSong(s) {
    return {
      platform: this.key,
      platformLabel: this.label,
      songId: s.hash,
      name: s.songname,
      singer: s.singername || '',
      album: s.album_name || '',
      duration: (s.duration || 0) * 1000,
      cover: s.img || s.album_img || '',
      hash: s.hash,
      sqhash: s.sqhash || '',
      hqhash: s['320hash'] || '',
      albumId: s.album_id || '',
      albumAudioId: s.album_audio_id || '',
      audioId: s.audio_id || '',
      privilege: { 128: s['128privilege'], 320: s['320privilege'], sq: s.sqprivilege },
      payType: s.pay_type,
      raw: s,
    };
  }

  async resolveUrl(candidate) {
    // 1) 先尝试本地 KuGouMusicApi（带登录态可拿高音质）
    const local = await this.resolveViaLocal(candidate);
    if (local.ok) return local;

    // 2) 回退：公开 get_res_privilege 接口
    const hashes = [];
    if (candidate.sqhash) hashes.push({ hash: candidate.sqhash, quality: 'flac', qualityLabel: '无损FLAC' });
    if (candidate.hqhash) hashes.push({ hash: candidate.hqhash, quality: '320', qualityLabel: '高品质320' });
    hashes.push({ hash: candidate.hash || candidate.songId, quality: '128', qualityLabel: '标准128' });

    for (const h of hashes) {
      try {
        const url = 'http://media.store.kugou.com/v1/get_res_privilege';
        const body = JSON.stringify({
          relate: 1,
          userid: '0',
          vip: 0,
          appid: 1000,
          token: '',
          behavior: 'play',
          area_code: '1',
          clientver: '8990',
          resource: [{ id: 0, type: 'audio', hash: h.hash }],
        });
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': MOBILE_UA, 'Content-Type': 'application/json' },
          body,
        });
        const json = await res.json();
        const item = json && json.data && json.data[0];
        const playUrl = item && item.url && (Array.isArray(item.url) ? item.url[0] : item.url);
        if (playUrl) {
          return { ok: true, url: playUrl, quality: h.quality, qualityLabel: h.qualityLabel, size: item.info && item.info.filesize };
        }
      } catch (e) {
        logger.debug('酷狗直连接口失败：' + e.message);
      }
    }
    return { ok: false, error: local.error || '未取得可用播放地址（可能需要登录酷狗账号）' };
  }

  /** 通过本地 KuGouMusicApi 取直链（需要 dfid，登录后可拿高音质） */
  async resolveViaLocal(candidate) {
    const tries = [];
    if (candidate.sqhash) tries.push({ hash: candidate.sqhash, quality: 'flac', qualityLabel: '无损FLAC' });
    if (candidate.hqhash) tries.push({ hash: candidate.hqhash, quality: '320', qualityLabel: '高品质320' });
    tries.push({ hash: candidate.hash || candidate.songId, quality: '128', qualityLabel: '标准128' });

    const cookie = await this.effectiveCookie();

    for (const t of tries) {
      try {
        const res = await getLocalJson(
          this.localBase,
          '/song/url',
          {
            hash: t.hash,
            album_id: candidate.albumId || 0,
            album_audio_id: candidate.albumAudioId || 0,
            quality: t.quality,
            timestamp: Date.now(),
          },
          { cookie, timeoutMs: 12000 }
        );
        const urls = res && res.url;
        const playUrl = Array.isArray(urls) ? urls[0] : urls;
        if (playUrl) {
          return { ok: true, url: playUrl, quality: t.quality, qualityLabel: t.qualityLabel };
        }
        if (res && (res.errcode === 20028 || /验证/.test(String(res.error_msg || '')))) {
          this.dfid = '';
          this.dfidAt = 0;
        }
      } catch (e) {
        logger.debug('本地酷狗服务取直链失败：' + e.message);
      }
    }
    return { ok: false };
  }

  /**
   * 榜单推荐：优先移动端「TOP500」榜单接口（无需登录），失败再退化为搜索「热门」。
   * 空闲自动播放优先从榜单取歌，比随机搜索更稳定、也更好听。
   */
  async recommendSongs(limit = 20) {
    // rankid=8888 是酷狗 TOP500；加 rp_type/with_cover 拿到的字段最全
    for (const rankid of [8888, 6666, 52144]) {
      try {
        const res = await getJson(
          this.base +
            '/api/v3/rank/song?version=8990&plat=2&pagesize=' + Math.min(50, limit) +
            '&page=1&rankid=' + rankid + '&with_cover=1&area_code=1',
          { headers: { 'User-Agent': MOBILE_UA, 'UNI-UserAgent': 'iOS11.4-Phone8990-1009-0-WiFi' }, timeoutMs: 12000 }
        );
        const info = (res && res.data && (res.data.info || res.data.songs)) || [];
        if (info.length) {
          logger.debug('酷狗榜单 rankid=' + rankid + ' 取到 ' + info.length + ' 首');
          return info.slice(0, limit).map((s) => this.mapMobileSong(s));
        }
      } catch (e) {
        logger.debug('酷狗榜单 rankid=' + rankid + ' 失败：' + e.message);
      }
    }
    // 兜底：搜「热门」（搜索结果按热度排序，效果接近榜单）
    try {
      const list = await this.search('热门', limit);
      if (list.length) return list;
    } catch (e) {
      logger.debug('酷狗热门兜底失败：' + e.message);
    }
    return [];
  }

  async lyric(hash) {
    try {
      const s = await getJson(
        'http://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&hash=' + hash,
        { headers: { 'User-Agent': MOBILE_UA } }
      );
      const cand = s && s.candidates && s.candidates[0];
      if (!cand) return '';
      const d = await getJson(
        'http://lyrics.kugou.com/download?ver=1&client=pc&id=' + cand.id + '&accesskey=' + cand.accesskey + '&fmt=lrc&charset=utf8',
        { headers: { 'User-Agent': MOBILE_UA } }
      );
      if (d && d.content) return Buffer.from(d.content, 'base64').toString('utf8');
      return '';
    } catch {
      return '';
    }
  }
}

module.exports = { KugouAdapter, DEFAULT_UA };
