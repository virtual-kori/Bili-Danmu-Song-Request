/**
 * 网易云音乐适配器。
 *
 * 搜索/取直链全部通过本地已安装的 Netease-Api 服务（默认 127.0.0.1:33011），
 * 登录态通过 cookie 透传，VIP 账号可解出更高音质直链。
 */
const { getLocalJson } = require('./http');
const logger = require('../core/logger').make('netease');

// 音质优先级：越高越优先，取到可用即返回
const LEVELS = ['lossless', 'exhigh', 'higher', 'standard'];

/**
 * 限流熔断状态。
 *
 * 网易云服务端的风控是「操作频繁」→ code 405，一旦触发，
 * 按 IP 判定且恢复很慢（实测数分钟以上）。触发后我们主动冷却一段时间，
 * 期间不再请求，直接让其它三个平台顶上，避免反复空撞把风控拖得更久。
 */
let cooldownUntil = 0;
const COOLDOWN_MS = 90 * 1000;

function noteRateLimited() {
  cooldownUntil = Date.now() + COOLDOWN_MS;
}

function inCooldown() {
  return Date.now() < cooldownUntil;
}

function cooldownSeconds() {
  return Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
}

function pickUrl(payload) {
  const data = payload && payload.data;
  if (!data) return null;
  if (Array.isArray(data)) {
    const first = data[0] || {};
    return { url: first.url || '', level: first.level || '', size: first.size || 0, br: first.br || 0 };
  }
  return { url: data.url || '', level: data.level || '', size: data.size || 0, br: data.br || 0 };
}

class NeteaseAdapter {
  constructor(getPlatform) {
    this.key = 'netease';
    this.label = '网易云音乐';
    this.getPlatform = getPlatform;
  }

  get base() {
    const p = this.getPlatform();
    return 'http://127.0.0.1:' + (p.port || 33011);
  }

  get cookie() {
    return this.getPlatform().cookie || '';
  }

  get enabled() {
    return true;
  }

  /**
   * 查当前登录账号。
   *
   * 参照参考项目（B站弹幕点歌机器人便携版 `netease_api.current_account`）：
   * **以 profile 为准**——有 profile 才算真登录。未登录时 /login/status 也会返回
   * 一个「匿名账号」（account.userName 形如 1000_XXX、type=1000），那不是登录，
   * 只看 account 会误判成功。
   *
   * @returns {{loggedIn:boolean, uid:number|string, nickname:string, vip:boolean, raw:object}}
   */
  async currentAccount() {
    const r = await getLocalJson(this.base, '/login/status', { timestamp: Date.now() }, { cookie: this.cookie, timeoutMs: 6000 });
    const d = (r && r.data) || {};
    const profile = d.profile || null;
    const account = d.account || {};
    if (!profile) {
      return { loggedIn: false, uid: 0, nickname: '', vip: false, raw: d };
    }
    const vipType = Number(profile.vipType || account.vipType || 0);
    return {
      loggedIn: true,
      uid: profile.userId || account.id || 0,
      nickname: profile.nickname || '',
      vip: vipType > 0,
      raw: d,
    };
  }

  async ping() {
    // 可用性判据 = 能否真的取到直链；登录态单独查 /login/status
    try {
      const acc = await this.currentAccount();
      const loggedIn = acc.loggedIn;
      // user 只放**纯用户名**，VIP 之类的后缀单独给 vip 字段，
      // 这样 UI 里「账号：xxx」不会被拼上一堆括号说明。
      const user = acc.nickname;
      const vip = acc.vip ? '（VIP）' : '';

      const list = await this.search('周杰伦', 5);
      if (!list.length) {
        if (inCooldown()) {
          return { ok: false, loggedIn, user, vip: acc.vip, error: '网易云限流冷却中（还需 ' + cooldownSeconds() + ' 秒自动恢复）' };
        }
        return { ok: false, loggedIn, user, vip: acc.vip, error: '搜索无结果（网易云接口可能已变动）' };
      }
      for (const cand of list.slice(0, 3)) {
        const u = await this.resolveUrl(cand);
        if (u && u.ok && u.url) {
          return { ok: true, loggedIn, user: loggedIn ? user : '', vip: acc.vip, quality: u.qualityLabel || u.quality, error: '' };
        }
      }
      return {
        ok: false,
        loggedIn,
        user: loggedIn ? user : '',
        vip: acc.vip,
        error: loggedIn ? '已登录但取不到直链（该曲可能无版权）' : '未登录：VIP 曲目只能试听',
      };
    } catch (e) {
      return { ok: false, loggedIn: false, user: '', error: e.message };
    }
  }

  async search(keyword, limit = 15) {
    // 处于限流冷却期时直接返回空，让其它平台顶上（不再空撞）
    if (inCooldown()) {
      logger.debug('网易云限流冷却中（还需 ' + cooldownSeconds() + ' 秒），本次跳过搜索');
      return [];
    }

    // 网易云对「歌名+歌手」这种关键词经常直接返回空（无版权时会拦掉），
    // 也可能回 405「操作频繁」。这里对空结果重试一次，间隔略长一点避免加剧限流。
    let songs = [];
    let lastCode = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await getLocalJson(this.base, '/search', {
        keywords: keyword,
        limit,
        type: 1,
        timestamp: Date.now(),
      });
      lastCode = (res && res.code) || 0;
      songs = (res && res.result && res.result.songs) || [];
      if (songs.length) break;
      // 405 = 操作频繁：进入冷却，并交给上层用歌名再试
      if (lastCode === 405) {
        noteRateLimited();
        logger.warn('网易云触发限流（405 操作频繁），暂停网易云请求 ' + Math.round(COOLDOWN_MS / 1000) + ' 秒');
        break;
      }
      await new Promise((r) => setTimeout(r, 900));
    }
    if (!songs.length && lastCode === 405) {
      logger.debug('网易云搜索「' + keyword + '」被限流，交由上层用歌名重搜');
    }
    return songs.map((s) => ({
      platform: this.key,
      platformLabel: this.label,
      songId: String(s.id),
      name: s.name,
      singer: (s.artists || s.ar || []).map((a) => a.name).join('、'),
      album: (s.album && s.album.name) || (s.al && s.al.name) || '',
      duration: s.duration || s.dt || 0,
      cover: (s.album && s.album.picUrl) || (s.al && s.al.picUrl) || '',
      fee: s.fee,
      raw: s,
    }));
  }

  async resolveUrl(candidate, options = {}) {
    for (const level of LEVELS) {
      try {
        const res = await getLocalJson(
          this.base,
          '/song/url/v1',
          { id: candidate.songId, level, timestamp: Date.now() },
          { cookie: this.cookie }
        );
        const picked = pickUrl(res);
        if (picked && picked.url) {
          return {
            ok: true,
            url: picked.url,
            quality: picked.level || level,
            qualityLabel: qualityLabel(picked.level || level),
            size: picked.size,
          };
        }
        if (res && res.data && res.data.freeTrialInfo) {
          logger.debug('歌曲 ' + candidate.name + ' 仅可试听');
        }
      } catch (e) {
        logger.debug('取直链失败 level=' + level + ' : ' + e.message);
      }
    }
    return { ok: false, error: '未取得可用播放地址' };
  }

  async lyric(songId) {
    try {
      const res = await getLocalJson(this.base, '/lyric', { id: songId, timestamp: Date.now() });
      return (res && res.lrc && res.lrc.lyric) || '';
    } catch {
      return '';
    }
  }

  /**
   * 榜单/推荐曲：优先真实榜单（热歌榜），拿不到再退化为个性化推荐。
   * 空闲自动播放优先用榜单，比个性化推荐更稳定（未登录时个性化经常为空）。
   */
  async recommendSongs(limit = 20) {
    // 1) 热歌榜歌单（3778678 = 热歌榜），曲目字段与搜索接口一致，能直接复用 mapSong
    for (const id of [3778678, 19723756, 2884035]) {
      try {
        const res = await getLocalJson(
          this.base,
          '/playlist/detail',
          { id, timestamp: Date.now() },
          { cookie: this.cookie, timeoutMs: 12000 }
        );
        const tracks = (res && res.playlist && res.playlist.tracks) || [];
        if (tracks.length) {
          logger.debug('网易云榜单歌单 ' + id + ' 取到 ' + tracks.length + ' 首');
          return tracks.slice(0, limit).map((s) => this.mapSong(s));
        }
      } catch (e) {
        logger.debug('网易云榜单歌单 ' + id + ' 失败：' + e.message);
      }
    }

    // 2) 新歌榜（/top/song 的 data 就是歌曲数组）
    try {
      const res = await getLocalJson(this.base, '/top/song', { type: 0, timestamp: Date.now() }, { cookie: this.cookie, timeoutMs: 12000 });
      const arr = Array.isArray(res && res.data) ? res.data : [];
      if (arr.length) return arr.slice(0, limit).map((s) => this.mapSong(s));
    } catch (e) {
      logger.debug('网易云新歌榜失败：' + e.message);
    }

    // 3) 兜底：个性化推荐
    const tried = ['/recommend/songs', '/personalized/newsong', '/personalized'];
    for (const path of tried) {
      try {
        const res = await getLocalJson(
          this.base,
          path,
          path === '/personalized' ? { limit } : { timestamp: Date.now() },
          { cookie: this.cookie, timeoutMs: 12000 }
        );
        const list = extractNeteaseSongs(res);
        if (list.length) return list.slice(0, limit).map((s) => this.mapSong(s));
      } catch (e) {
        logger.debug('推荐接口 ' + path + ' 失败：' + e.message);
      }
    }
    return [];
  }

  /**
   * 漫游（私人FM）：每次只返回 1 首随机歌，所以连拉几次攒一批。
   *
   * 网易云这套接口底层是 /api/v1/radio/get，返回的是**个性化随机**曲目，
   * 跟榜单完全不同 —— 空闲时想「一直在放没听过的歌」就用它。
   *
   * 注意：
   *   · 一次一首，limit 越大请求越多（实测单次约 250~400ms）；
   *   · 未登录时经常返回空，这时抛错让上层退化为榜单；
   *   · 命中限流（405）会抛错，上层据此进入冷却。
   */
  async roamSongs(limit = 8) {
    if (cooldownSeconds() > 0) {
      throw new Error('网易云限流冷却中（还需 ' + cooldownSeconds() + ' 秒自动恢复）');
    }
    const want = Math.max(1, Math.min(20, Number(limit) || 8));
    const out = [];
    const seen = Object.create(null);

    for (let i = 0; i < want; i++) {
      let res;
      try {
        res = await getLocalJson(
          this.base,
          '/personal_fm',
          { timestamp: Date.now() },
          { cookie: this.cookie, timeoutMs: 12000 }
        );
      } catch (e) {
        if (out.length) break; // 已经攒到一些就先用着
        throw e;
      }

      // 限流：标记冷却并抛错，别静默返回空
      if (res && res.code === 405) {
        noteRateLimited();
        throw new Error('网易云限流（code=405 操作频繁），已进入冷却');
      }

      const d = res && res.data;
      const arr = Array.isArray(d) ? d : (d && Array.isArray(d.data) ? d.data : []);
      const raw = arr[0];
      if (!raw) {
        if (out.length) break;
        // 未登录 / 没有漫游权限
        return [];
      }
      const song = this.mapSong(raw);
      const key = String(song.songId || song.name);
      if (seen[key]) continue;
      seen[key] = 1;
      out.push(song);
    }

    if (!out.length) return [];
    logger.debug('网易云漫游取到 ' + out.length + ' 首');
    return out;
  }

  /** 歌单曲目 */
  async playlistSongs(playlistId, limit = 20) {
    try {
      const res = await getLocalJson(
        this.base,
        '/playlist/track/all',
        { id: playlistId, limit, offset: 0, timestamp: Date.now() },
        { cookie: this.cookie, timeoutMs: 15000 }
      );
      const songs = (res && res.songs) || [];
      return songs.slice(0, limit).map((s) => this.mapSong(s));
    } catch (e) {
      logger.debug('歌单拉取失败：' + e.message);
      return [];
    }
  }

  mapSong(s) {
    return {
      platform: this.key,
      platformLabel: this.label,
      songId: String(s.id),
      name: s.name,
      singer: (s.artists || s.ar || []).map((a) => a.name).join('、'),
      album: (s.album && s.album.name) || (s.al && s.al.name) || '',
      duration: s.duration || s.dt || 0,
      cover: (s.album && s.album.picUrl) || (s.al && s.al.picUrl) || (s.picUrl || ''),
      raw: s,
    };
  }
}

/** 网易云推荐接口返回结构不一，这里做统一抽取 */
function extractNeteaseSongs(res) {
  if (!res) return [];
  if (Array.isArray(res.data) && res.data.length && res.data[0].song) return res.data.map((d) => d.song);
  if (res.data && Array.isArray(res.data.dailySongs)) return res.data.dailySongs;
  if (Array.isArray(res.result)) return res.result;
  if (res.data && Array.isArray(res.data)) return res.data;
  return [];
}

function qualityLabel(level) {
  const map = {
    standard: '标准',
    higher: '较高',
    exhigh: '极高',
    lossless: '无损',
    hires: 'Hi-Res',
    jyeffect: '沉浸环绕声',
    sky: '沉浸环绕声',
    jymaster: '超清母带',
  };
  return map[level] || level || '';
}

module.exports = { NeteaseAdapter, qualityLabel };
