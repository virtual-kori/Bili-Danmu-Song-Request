/**
 * QQ 音乐适配器。
 *
 * 通过 QQMusicApi/live/server.js 提供的本地服务访问（默认 127.0.0.1:33012）；
 * 榜单/推荐走腾讯的公开 c.y.qq.com 接口。
 */
const { getJson, getLocalJson } = require('./http');
const logger = require('../core/logger').make('qq');

class QQAdapter {
  constructor(getPlatform) {
    this.key = 'qq';
    this.label = 'QQ音乐';
    this.getPlatform = getPlatform;
  }

  get base() {
    return 'http://127.0.0.1:' + (this.getPlatform().port || 33012);
  }

  async ping() {
    // 可用性判据 = 能否真的取到直链（未登录时大量曲目只有试听）
    try {
      const r = await getLocalJson(this.base, '/login/status', {}, { timeoutMs: 4000 });
      const loggedIn = Boolean(r && r.loggedIn);
      const list = await this.search('周杰伦', 5);
      if (!list.length) return { ok: false, loggedIn, user: '', error: '搜索无结果（QQ 接口可能已变动）' };
      for (const cand of list.slice(0, 3)) {
        const u = await this.resolveUrl(cand);
        if (u && u.ok && u.url) {
          return {
            ok: true,
            loggedIn,
            user: loggedIn ? String(r.musicid || '已登录') : '',
            quality: u.qualityLabel || u.quality,
            error: '',
          };
        }
      }
      return {
        ok: false,
        loggedIn,
        user: loggedIn ? '已登录' : '',
        error: loggedIn ? '已登录但取不到直链（该曲可能需付费）' : '未登录：VIP 曲目取不到直链',
      };
    } catch (e) {
      return { ok: false, loggedIn: false, user: '', error: e.message };
    }
  }

  async search(keyword, limit = 15) {
    const res = await getLocalJson(this.base, '/search/song', { keywords: keyword, page: 1, pagesize: limit });
    const songs = (res && res.songs) || [];
    return songs.map((s) => ({
      platform: this.key,
      platformLabel: this.label,
      songId: s.mid || s.id,
      name: s.name,
      singer: s.singer,
      album: s.album,
      duration: s.duration || 0,
      cover: s.albumMid ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + s.albumMid + '.jpg' : '',
      pay: s.pay,
      mediaMid: s.mediaMid,
      raw: s,
    }));
  }

  /**
   * 校验一份 QQ 音乐 Cookie。
   *
   * 现实情况（实测）：
   *   · 本地服务只要 cookie 里有 uin + qm_keyst 就报 loggedIn=true，key 是乱写的也一样；
   *   · 未登录时腾讯也会给出**完整可播**的直链（实测 23MB 全曲，
   *     即使这首歌 pay_play=1），所以「试听 vs 完整」这条差异并不存在。
   *
   * 因此这里只做能可靠判断的两件事：
   *   1. Cookie 里必须含有 uin 与 qm_keyst/qqmusic_key；
   *   2. 本地服务是否认这份 Cookie（loggedIn）。
   * 不谎报「已登录且能取无损」——那需要真实账号才能验证。
   */
  async validateCookie(cookie) {
    const c = String(cookie || '');
    const hasUin = /(^|;\s*)(uin|qqmusic_uin|wxuin)=\d+/.test(c);
    const hasKey = /(^|;\s*)(qm_keyst|qqmusic_key|musickey)=[^;\s]+/.test(c);
    if (!hasUin || !hasKey) {
      return {
        ok: false,
        loggedIn: false,
        error: 'Cookie 里缺少必需字段（需要 uin 和 qm_keyst，或 qqmusic_key）',
      };
    }
    try {
      const s = await getLocalJson(this.base, '/login/status', {}, { timeoutMs: 8000 });
      const loggedIn = Boolean(s && s.loggedIn);
      return {
        ok: loggedIn,
        loggedIn,
        user: s && s.musicid ? String(s.musicid) : '',
        // 说明清楚：本地服务只做字段提取，伪造的 key 也能过这一关，
        // 真正有没有生效要看之后取直链的音质。
        error: loggedIn ? '' : '本地服务没有识别出登录态（Cookie 可能不完整或已过期）',
      };
    } catch (e) {
      return { ok: false, loggedIn: false, error: '无法连接 QQ 本地服务：' + e.message };
    }
  }

  async resolveUrl(candidate) {
    try {
      const res = await getLocalJson(this.base, '/song/url', {
        id: candidate.songId,
        mediaMid: candidate.mediaMid || '',
      });
      if (res && res.url) {
        return {
          ok: true,
          url: res.url,
          quality: res.quality,
          qualityLabel: res.qualityLabel || res.quality,
          size: res.size || 0,
        };
      }
      logger.debug('QQ 取直链失败：' + (res && res.message));
      return { ok: false, error: (res && res.message) || '未取得播放地址' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async lyric(songId) {
    try {
      const res = await getLocalJson(this.base, '/lyric', { id: songId });
      return (res && res.lyric) || '';
    } catch {
      return '';
    }
  }

  /** 推荐曲目：用热门榜单代替 */
  async recommendSongs(limit = 20) {
    try {
      const res = await getJson(
        'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=26&format=json&page=detail&type=top&tpl=3&platform=yqq.json&needNewCode=0',
        { headers: { Referer: 'https://y.qq.com/' } }
      );
      const list = (res && res.songlist) || [];
      return list.slice(0, limit).map((it) => {
        const d = it.data || it;
        return {
          platform: this.key,
          platformLabel: this.label,
          songId: d.songmid,
          name: d.songname,
          singer: (d.singer || []).map((x) => x.name).join('、'),
          album: d.albumname || '',
          duration: (d.interval || 0) * 1000,
          cover: '',
          mediaMid: d.media_mid || '',
          raw: d,
        };
      });
    } catch (e) {
      logger.debug('QQ 推荐失败：' + e.message);
      return [];
    }
  }
}

module.exports = { QQAdapter };
