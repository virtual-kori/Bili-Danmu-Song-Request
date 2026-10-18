/**
 * 点歌机核心引擎：串联弹幕 → 指令解析 → 四平台匹配 → 入队 → MPV 播放 → 空闲推荐。
 *
 * 状态机（对应需求五）：
 *   IDLE     无播放任务，等待队列 / 等待新点歌
 *   PLAYING  MPV 正在播放一首歌
 *   STOPPING 收到结束或切歌信号，正在停止 MPV
 *   CLOSED   MPV 进程已关闭，准备取下一首或回到 IDLE
 */
const { EventEmitter } = require('events');
const logger = require('./logger').make('engine');
const { Queue, normKey } = require('./queue');
const { rankCandidates, scoreCandidate } = require('./matcher');
const { MpvPlayer } = require('./mpv');
const { parseSongRequest, normalizeForCompare } = require('../../Bullet-Screen-Capture/parse');

const PHASE = { IDLE: 'IDLE', PLAYING: 'PLAYING', STOPPING: 'STOPPING', CLOSED: 'CLOSED' };

/** 曲目唯一标识：优先 songId，没有就退回「平台+歌名+歌手」 */
function songKey(s) {
  if (!s) return '';
  if (s.songId) return String(s.platform || '') + '::' + String(s.songId);
  return String(s.platform || '') + '::' + String(s.name || '') + '::' + String(s.singer || '');
}

/**
 * 跨平台判重用的标识。
 * 直接复用队列的 normKey（会去掉空格与中英文标点），
 * 所以「阿楚姑娘」在酷我和 QQ 会被认为是同一首。
 */
function songNameKey(s) {
  if (!s || !s.name) return '';
  return normKey({ name: s.name, singer: s.singer || '' });
}

/**
 * 候选缓存：Web UI 手动点歌时，搜索接口返回的是精简结构，
 * 但解析播放地址需要各平台自己的原始字段（酷我的 rid、酷狗的 hash、
 * QQ 的 mediaMid 等），所以这里把完整候选暂存起来，用户点选时取回。
 * key = 平台 + 歌曲ID，5 分钟过期。
 */
const candidateCache = new Map();
const CANDIDATE_TTL = 5 * 60 * 1000;

function candidateKey(platform, songId) {
  return String(platform) + '::' + String(songId);
}

function cacheCandidate(platform, raw) {
  const now = Date.now();
  // 顺手清掉过期项，避免长期运行后无限增长
  if (candidateCache.size > 500) {
    for (const [k, v] of candidateCache) {
      if (now - v.at > CANDIDATE_TTL) candidateCache.delete(k);
    }
  }
  const key = candidateKey(platform, raw.songId || raw.id || raw.rid);
  candidateCache.set(key, { ...raw, platform, at: now });
  return key;
}

function getCachedCandidate(platform, songId) {
  const hit = candidateCache.get(candidateKey(platform, songId));
  if (!hit) return null;
  if (Date.now() - hit.at > CANDIDATE_TTL) {
    candidateCache.delete(candidateKey(platform, songId));
    return null;
  }
  return hit;
}

class Engine extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.config 完整配置对象
   * @param {object} deps.adapters 平台适配器字典
   * @param {(patch:object)=>object} deps.saveConfig 落盘配置
   */
  constructor(deps) {
    super();
    this.config = deps.config;
    this.adapters = deps.adapters;
    this.saveConfig = deps.saveConfig;

    this.queue = new Queue();
    this.queue.on('change', () => this.broadcast());

    this.player = new MpvPlayer({
      mpvPath: this.config.play && this.config.play.mpvPath,
      volume: this.config.play && this.config.play.volume,
      audioDevice: this.config.play && this.config.play.audioDevice,
      extraArgs: this.config.play && this.config.play.extraArgs,
      streamTimeoutMs: this.config.play && this.config.play.streamTimeoutMs,
      wallClockSlackMs: this.config.play && this.config.play.wallClockSlackMs,
      unknownDurationTimeoutMs: this.config.play && this.config.play.unknownDurationTimeoutMs,
    });

    this.player.on('state', () => this.broadcast());
    this.player.on('progress', () => this.broadcastThrottled());
    this.player.on('loaded', () => this.broadcast());
    this.player.on('finished', (ev) => this.onSongFinished(ev));

    this.phase = PHASE.IDLE;
    this.current = null;
    this.startedAt = 0;
    this.lastError = '';
    this.platformStatus = {};
    this.recentRequests = new Map(); // uid -> 时间戳（冷却）
    this.lastPlayed = []; // 空闲推荐可用
    this.recentKeys = []; // 最近播放过的曲目 key（新的在前），空闲选歌时跳过
    this.recentLimit = 40;
    this.lyric = { songKey: '', lines: [], raw: '', loading: false, at: 0 }; // 当前歌曲歌词缓存
    this.pumping = false;
    this.stats = { received: 0, ordered: 0, played: 0, failed: 0, rejected: 0 };
    this._broadcastTimer = null;
  }

  // ------------------------------------------------------------ 状态快照

  get switches() {
    return {
      danmakuOrder: Boolean(this.config.danmaku && this.config.danmaku.enabled),
      idleAutoPlay: Boolean(this.config.idle && this.config.idle.enabled),
    };
  }

  snapshot() {
    return {
      phase: this.phase,
      statusText: statusText(this.phase, this.switches),
      current: this.current
        ? {
            id: this.current.id,
            name: this.current.name,
            singer: this.current.singer,
            platform: this.current.platform,
            platformLabel: this.current.platformLabel,
            album: this.current.album,
            cover: this.current.cover,
            quality: this.current.quality,
            qualityLabel: this.current.qualityLabel,
            requester: this.current.requester,
            songId: this.current.songId,
            duration: this.player.duration || (this.current.duration || 0) / 1000,
            position: this.player.position,
            paused: this.player.state === 'paused',
            startedAt: this.startedAt,
          }
        : null,
      queue: this.queue.sorted().map((it) => ({
        id: it.id,
        name: it.name,
        singer: it.singer,
        platform: it.platform,
        platformLabel: it.platformLabel,
        album: it.album,
        quality: it.quality,
        qualityLabel: it.qualityLabel,
        duration: it.duration,
        cover: it.cover,
        requester: it.requester,
        addedAt: it.addedAt,
        pinned: it.pinned,
        pinnedAt: it.pinnedAt,
        source: it.source,
      })),
      switches: this.switches,
      lastError: this.lastError,
      platformStatus: this.platformStatus,
      recentDanmaku: this.recentDanmaku || [],
      stats: this.stats,
      mpvPath: this.player.mpvPath,
      config: {
        roomId: this.config.danmaku && this.config.danmaku.roomId,
        priority: this.config.platforms && this.config.platforms.priority,
        enabledPlatforms: this.config.platforms && this.config.platforms.enabled,
        userCooldownMs: this.config.order && this.config.order.userCooldownMs,
        queueLimit: this.config.order && this.config.order.queueLimit,
        duplicateStrategy: this.config.order && this.config.order.duplicateStrategy,
        sameSongMaxTimes: this.config.order && this.config.order.sameSongMaxTimes,
        blacklistUsers: (this.config.order && this.config.order.blacklistUsers) || [],
        blacklistWords: (this.config.order && this.config.order.blacklistWords) || [],
        idleSource: this.config.idle && this.config.idle.source,
        idlePlaylistId: this.config.idle && this.config.idle.playlistId,
        volume: this.config.play && this.config.play.volume,
      },
    };
  }

  broadcast() {
    this.emit('state', this.snapshot());
  }

  broadcastThrottled() {
    if (this._broadcastTimer) return;
    this._broadcastTimer = setTimeout(() => {
      this._broadcastTimer = null;
      this.broadcast();
    }, 400);
  }

  /** 记录最近的弹幕，用于 Web UI 展示 */
  logDanmaku(entry) {
    if (!this.recentDanmaku) this.recentDanmaku = [];
    this.recentDanmaku.unshift(entry);
    if (this.recentDanmaku.length > 60) this.recentDanmaku.length = 60;
    this.broadcastThrottled();
  }

  // ------------------------------------------------------------ 播放调度

  async pump(reason = '') {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (true) {
        if (this.phase === PHASE.PLAYING || this.phase === PHASE.STOPPING) return;

        const item = this.queue.peek();
        if (item) {
          const res = await this.playItem(item);
          if (res.ok) return; // 播完/切歌后由 finished 事件再次调用 pump
          // 播放失败：丢弃该曲目，继续下一首
          logger.warn('播放失败，跳过：' + item.name + ' - ' + item.singer + '（' + (res.error || '') + '）');
          this.lastError = '播放失败：' + item.name + '（' + (res.error || '未知原因') + '）';
          this.stats.failed += 1;
          this.queue.consume(item.id, null);
          continue;
        }

        // 队列空 → 空闲自动播放
        if (this.config.idle && this.config.idle.enabled) {
          const ok = await this.fillFromIdleSource();
          if (ok) continue;
        }
        this.phase = PHASE.IDLE;
        this.current = null;
        this.broadcast();
        return;
      }
    } finally {
      this.pumping = false;
      this.broadcast();
    }
  }

  async playItem(item) {
    this.phase = PHASE.PLAYING;
    this.current = item;
    this.startedAt = Date.now();
    this.lastError = '';
    this.broadcast();

    const res = await this.player.play(item);
    if (!res.ok) {
      this.phase = PHASE.CLOSED;
      this.current = null;
      this.broadcast();
      return res;
    }
    this.stats.played += 1;
    this.rememberPlayed(item);
    // 「未播放队列」语义：一开始播放就出队（它已经在「正在播放」里了）。
    // 播放失败由 pump() 负责丢弃；正常结束/切歌时这里已经不在队列里，consume 是幂等的。
    this.queue.consume(item.id, null);
    // 歌词异步取，不阻塞播放；Web UI 会自己来拉
    this.loadLyric(item).catch(() => {});
    return { ok: true };
  }

  /**
   * 取当前歌曲歌词并缓存（异步、失败不影响播放）。
   * 解析成 [{ t: 秒, text }] 交给前端按播放进度高亮。
   */
  async loadLyric(item) {
    if (!item) return;
    this.lyric = { songKey: this.songKeyOf(item), lines: [], raw: '', loading: true, at: Date.now() };
    const adapter = this.adapters[item.platform];
    if (!adapter || typeof adapter.lyric !== 'function') {
      this.lyric.loading = false;
      return;
    }
    let raw = '';
    try {
      raw = (await adapter.lyric(item.songId)) || '';
    } catch (e) {
      logger.debug('取歌词失败（' + item.platform + '）：' + e.message);
    }
    // 取回来的歌词可能已经换歌了，丢弃过期结果
    if (this.songKeyOf(this.current) !== this.lyric.songKey) return;
    this.lyric = {
      songKey: this.lyric.songKey,
      lines: parseLrc(raw),
      raw,
      loading: false,
      at: Date.now(),
    };
    this.broadcast();
  }

  songKeyOf(item) {
    return item ? item.platform + '::' + (item.songId || '') + '::' + (item.name || '') : '';
  }

  /** 当前歌词（供 HTTP 接口用），结构含 lines 供前端算高亮行 */
  getLyric() {
    const key = this.songKeyOf(this.current);
    if (!this.current) return { songKey: '', lines: [], name: '', singer: '', loading: false };
    // 换歌后歌词还没回来时，先给个 loading 状态
    const fresh = this.lyric && this.lyric.songKey === key ? this.lyric : { lines: [], loading: true };
    return {
      songKey: key,
      name: this.current.name,
      singer: this.current.singer,
      platform: this.current.platform,
      platformLabel: this.current.platformLabel,
      lines: fresh.lines || [],
      loading: Boolean(fresh.loading),
    };
  }

  rememberPlayed(item) {
    this.lastPlayed.unshift({
      platform: item.platform,
      platformLabel: item.platformLabel,
      songId: item.songId,
      name: item.name,
      singer: item.singer,
      album: item.album,
      duration: item.duration,
      cover: item.cover,
      url: item.url,
      quality: item.quality,
      qualityLabel: item.qualityLabel,
    });
    if (this.lastPlayed.length > 50) this.lastPlayed.length = 50;

    // 最近播放过的曲目：空闲随机选歌时要跳过它们，避免反复听到同一首。
    // 同时记录 songKey（平台内唯一）和 songNameKey（跨平台判重），
    // 这样同一首歌换个平台也不会接着又放一遍。
    for (const key of [songKey(item), songNameKey(item)]) {
      if (!key) continue;
      const i = this.recentKeys.indexOf(key);
      if (i >= 0) this.recentKeys.splice(i, 1);
      this.recentKeys.unshift(key);
    }
    if (this.recentKeys.length > this.recentLimit) this.recentKeys.length = this.recentLimit;
  }

  /** 这首歌最近播放过吗（空闲选歌用；跨平台按歌名+歌手判重） */
  isRecentlyPlayed(song) {
    if (!song) return false;
    return this.recentKeys.indexOf(songKey(song)) >= 0 || this.recentKeys.indexOf(songNameKey(song)) >= 0;
  }

  async onSongFinished(ev) {
    const item = ev.item || this.current;
    logger.info('播放结束（' + ev.reason + '）' + (item ? '：' + item.name + ' - ' + item.singer : ''));
    if (ev.reason === 'error') {
      this.lastError = '播放出错：' + (ev.error || '网络或解码错误');
      this.stats.failed += 1;
    }
    if (item) this.queue.consume(item.id, item);
    this.current = null;

    // 需求 5：播放结束 → 停止 MPV → 关闭进程 → 检查队列
    this.phase = PHASE.STOPPING;
    this.broadcast();
    await this.player.stop('finished');
    this.phase = PHASE.CLOSED;
    this.broadcast();

    await this.pump('finished');
  }

  async playNext() {
    // 切歌：立即停止并关闭 MPV → 取下一首 → 启动新 MPV
    const current = this.current;
    this.phase = PHASE.STOPPING;
    this.broadcast();
    await this.player.stop('switch');
    this.phase = PHASE.CLOSED;
    if (current) this.queue.consume(current.id, null);
    this.current = null;
    this.broadcast();
    await this.pump('switch');
  }

  async stopAll() {
    this.phase = PHASE.STOPPING;
    this.broadcast();
    await this.player.stop('shutdown');
    this.phase = PHASE.IDLE;
    this.current = null;
    this.broadcast();
  }

  // ------------------------------------------------------------ 弹幕点歌

  /**
   * 处理一条弹幕。
   * @param {{text:string, uid:number|string, uname:string, guard?:number, medal?:object}} dm
   */
  async handleDanmaku(dm) {
    this.stats.received += 1;
    const text = (dm.text || '').trim();
    const parsed = parseSongRequest(text, {
      prefixes: (this.config.order && this.config.order.prefixes) || ['点歌'],
      allowStringPrefixMatch: this.config.order ? this.config.order.allowStringPrefixMatch : true,
    });

    this.logDanmaku({
      at: Date.now(),
      uname: dm.uname,
      uid: dm.uid,
      text,
      kind: parsed.ok ? 'order' : parsed.reason === 'not-command' ? 'chat' : 'invalid',
      note: parsed.ok ? parsed.name + (parsed.singer ? ' / ' + parsed.singer : '') : parsed.reason,
    });

    if (this.config.log && this.config.log.danmaku) {
      logger.debug('弹幕 [' + dm.uname + '] ' + text);
    }
    if (!parsed.ok) {
      if (parsed.reason === 'no-keyword') {
        await this.reply(dm, '请在「点歌」后写上歌名，例如：点歌 夜曲 周杰伦');
      }
      return { ok: false, reason: parsed.reason };
    }

    return this.requestSong(parsed, dm, 'danmaku');
  }

  /** 申请点歌（弹幕或 Web UI 共用） */
  async requestSong(parsed, requester, source = 'danmaku') {
    const order = this.config.order || {};
    const isDanmaku = source === 'danmaku';

    if (isDanmaku && order.requireDanmakuSwitch !== false && !this.switches.danmakuOrder) {
      await this.reply(requester, '当前未开启弹幕点歌');
      return { ok: false, reason: 'switch-off' };
    }

    // 黑名单用户
    const uname = String(requester.uname || requester.name || '').trim();
    const uid = String(requester.uid || '');
    const blacklistUsers = (order.blacklistUsers || []).map((s) => String(s).trim()).filter(Boolean);
    if (uname && blacklistUsers.some((b) => b === uname || (uid && b === uid))) {
      this.stats.rejected += 1;
      await this.reply(requester, '你在黑名单中，暂时无法点歌');
      return { ok: false, reason: 'blacklist-user' };
    }

    // 敏感词
    const blacklistWords = (order.blacklistWords || []).filter(Boolean);
    if (blacklistWords.some((w) => parsed.name.includes(w) || (parsed.singer || '').includes(w))) {
      this.stats.rejected += 1;
      await this.reply(requester, '该歌曲包含受限关键词，无法点播');
      return { ok: false, reason: 'blacklist-word' };
    }

    // 同用户冷却
    if (isDanmaku && uid) {
      const cooldown = Number(order.userCooldownMs || 0);
      const last = this.recentRequests.get(uid) || 0;
      if (cooldown > 0 && Date.now() - last < cooldown) {
        const wait = Math.ceil((cooldown - (Date.now() - last)) / 1000);
        this.stats.rejected += 1;
        await this.reply(requester, '点歌太快啦，请 ' + wait + ' 秒后再试');
        return { ok: false, reason: 'cooldown' };
      }
    }

    // 搜索 + 匹配
    const found = await this.findBestSong(parsed);
    if (!found.ok) {
      if (found.reason === 'all-platforms-failed') {
        await this.reply(requester, '未找到该歌曲，可补充歌手名');
      } else {
        await this.reply(requester, '未找到该歌曲，可补充歌手名' + (found.detail ? '（' + found.detail + '）' : ''));
      }
      return { ok: false, reason: found.reason };
    }

    // 入队
    const pushed = this.queue.push(found.song, {
      requester: uname || 'Web UI',
      requesterUid: requester.uid || 0,
      source,
      config: order,
      queueLimit: Number(order.queueLimit || 50),
    });

    if (!pushed.ok) {
      this.stats.rejected += 1;
      await this.reply(requester, '点歌失败：' + pushed.reason);
      return { ok: false, reason: 'queue-reject', detail: pushed.reason };
    }

    if (isDanmaku && uid) this.recentRequests.set(uid, Date.now());
    this.stats.ordered += 1;
    this.broadcast();

    const tierNote = found.tier === 1 ? '' : '（匹配：' + found.tierName + '）';
    await this.reply(requester, '已加入点歌列表：' + found.song.name + (found.song.singer ? ' - ' + found.song.singer : '') + tierNote);

    // 需求 3：点歌不立即播放，只进入未播放列表；但如果当前空闲且队列刚变非空，进入播放
    if (this.phase === PHASE.IDLE && this.queue.length > 0) {
      setImmediate(() => this.pump('queue'));
    }
    return { ok: true, item: pushed.item, matched: found.song, tierName: found.tierName };
  }

  /**
   * 候选搜索：每个平台各返回前 N 个结果，供 Web UI 手动挑选。
   *
   * 与 findBestSong 的区别：这里不做「只挑一个最优」的收敛，
   * 而是把各平台的候选原样列出，并附带匹配等级，让用户自己决定。
   * 为了响应够快，这里**不预先解析播放地址**，用户点选时才解析。
   */
  async searchCandidates(name, singer = '', per = 3) {
    const priority = (this.config.platforms && this.config.platforms.priority) || ['netease', 'qq', 'kugou', 'kuwo'];
    const enabled = (this.config.platforms && this.config.platforms.enabled) || {};
    const active = priority.filter((p) => enabled[p] !== false && this.adapters[p]);
    const request = { name, singer };
    const keyword = singer ? name + ' ' + singer : name;

    const groups = await Promise.all(
      active.map(async (p) => {
        const adapter = this.adapters[p];
        let list = [];
        let note = '';
        try {
          list = await adapter.search(keyword, 12);
          if (!list.length && singer) {
            // 带歌手被平台拦掉时（如网易云无该歌手版权），退化成纯歌名
            await new Promise((r) => setTimeout(r, 800));
            list = await adapter.search(name, 12);
            if (list.length) note = '该平台按「歌名+歌手」无结果，已用歌名重搜';
          }
        } catch (e) {
          note = '搜索失败：' + e.message;
        }

        // 打分并排序，取前 per 个（同时把完整候选存进缓存，供点选时解析地址）
        const items = list
          .map((c) => {
            const s = scoreCandidate(request, c);
            cacheCandidate(p, c);
            return {
              platform: p,
              platformLabel: c.platformLabel,
              songId: c.songId,
              name: c.name,
              singer: c.singer,
              album: c.album,
              duration: c.duration,
              cover: c.cover,
              quality: '',
              tier: s.tier,
              tierName: s.tierName,
              score: Math.round(s.score),
              mediaMid: c.mediaMid,
              inQueue: this.queue.countDuplicate(c) > 0,
            };
          })
          .sort((a, b) => {
            if (a.tier !== b.tier) return (a.tier || 9) - (b.tier || 9);
            return b.score - a.score;
          })
          .slice(0, per);

        return { platform: p, label: (this.adapters[p] && this.adapters[p].label) || p, items, note, total: list.length };
      })
    );

    // 按平台优先级排列分组
    return { keyword, per, groups: groups.filter((g) => g.items.length || g.note), priority };
  }

  /**
   * 把用户选中的候选入队（Web UI 手动选择用）。
   * 这里才去解析播放地址并校验，失败会返回明确原因。
   */
  async enqueueCandidate(cand, requester, source = 'web') {
    const adapter = this.adapters[cand.platform];
    if (!adapter) return { ok: false, reason: 'platform-missing', detail: '平台未启用：' + cand.platform };

    let resolved = null;
    try {
      resolved = await adapter.resolveUrl(cand);
    } catch (e) {
      resolved = { ok: false, error: e.message };
    }
    if (!resolved || !resolved.ok || !resolved.url) {
      return {
        ok: false,
        reason: 'no-url',
        detail: (resolved && resolved.error) || '该平台取不到播放地址',
      };
    }

    const check = await this.verifyUrl(resolved.url);
    if (!check.ok && check.definitive) {
      return { ok: false, reason: 'bad-url', detail: check.reason || '播放地址不可用' };
    }

    const song = {
      platform: cand.platform,
      platformLabel: cand.platformLabel || adapter.label,
      songId: cand.songId,
      id: cand.songId,
      name: cand.name,
      singer: cand.singer,
      album: cand.album,
      duration: cand.duration || 0,
      cover: cand.cover || '',
      url: resolved.url,
      quality: resolved.quality || '',
      qualityLabel: resolved.qualityLabel || '',
      mediaMid: cand.mediaMid,
    };

    const pushed = this.queue.push(song, {
      requester: (requester && requester.uname) || 'Web UI',
      requesterUid: (requester && requester.uid) || 0,
      source,
      config: this.config.order || {},
      queueLimit: Number((this.config.order && this.config.order.queueLimit) || 50),
    });

    if (!pushed.ok) return { ok: false, reason: 'queue-reject', detail: pushed.reason };

    this.stats.ordered += 1;
    this.broadcast();
    if (this.phase === PHASE.IDLE && this.queue.length > 0) setImmediate(() => this.pump('queue'));
    return { ok: true, item: pushed.item, matched: song, tierName: cand.tierName || '' };
  }

  /** 跨平台搜索并按优先级匹配 */
  async findBestSong(parsed) {
    const priority = (this.config.platforms && this.config.platforms.priority) || ['netease', 'qq', 'kugou', 'kuwo'];
    const enabled = (this.config.platforms && this.config.platforms.enabled) || {};
    const keyword = parsed.singer ? parsed.name + ' ' + parsed.singer : parsed.name;

    const active = priority.filter((p) => enabled[p] !== false && this.adapters[p]);

    const searches = active.map(async (p) => {
      const adapter = this.adapters[p];
      try {
        const list = await adapter.search(keyword, 15);
        this.platformStatus[p] = { ok: true, count: list.length, at: Date.now(), error: '' };
        if (list.length) return list;
        // 返回空列表也算失败：某些平台对「歌名+歌手」这种关键词会直接返回空
        // （例如网易云没有周杰伦版权时，"夜曲 周杰伦" 会被拦掉），
        // 这时必须退化成纯歌名再搜一次，否则会白白丢掉整个平台的结果。
        // 注意先等一下，避免连续两次请求触发限流（网易云会回 405 操作频繁）。
        await new Promise((r) => setTimeout(r, 800));
        const retry = await adapter.search(parsed.name, 15);
        this.platformStatus[p] = {
          ok: true,
          count: retry.length,
          at: Date.now(),
          error: retry.length ? '带歌手关键词无结果，已用歌名重搜' : '无结果（歌名重搜也为空）',
        };
        if (!retry.length) logger.debug(p + ' 无结果：「' + parsed.name + '」（带歌手关键词已被平台拦掉）');
        return retry;
      } catch (e) {
        this.platformStatus[p] = { ok: false, count: 0, at: Date.now(), error: e.message };
        logger.warn(p + ' 搜索失败：' + e.message);
        // 抛错时同样退化为纯歌名重试
        try {
          await new Promise((r) => setTimeout(r, 800));
          const list = await adapter.search(parsed.name, 15);
          this.platformStatus[p] = { ok: true, count: list.length, at: Date.now(), error: '首次搜索出错，已用歌名重搜' };
          return list;
        } catch {
          return [];
        }
      }
    });

    const results = await Promise.all(searches);
    const candidates = results.flat();

    if (!candidates.length) {
      this.broadcast();
      return { ok: false, reason: 'all-platforms-failed' };
    }

    const { ranked } = rankCandidates(parsed, candidates, priority);
    if (!ranked.length) {
      this.broadcast();
      return { ok: false, reason: 'no-match' };
    }

    // 逐个候选校验播放地址（无效则尝试同平台下一候选）
    const maxTry = Math.min(ranked.length, 8);
    const errors = [];
    for (let i = 0; i < maxTry; i++) {
      const cand = ranked[i];
      const adapter = this.adapters[cand.platform];
      if (!adapter) continue;
      let resolved;
      try {
        resolved = await adapter.resolveUrl(cand);
      } catch (e) {
        resolved = { ok: false, error: e.message };
      }
      if (!resolved || !resolved.ok || !resolved.url) {
        errors.push(cand.platformLabel + '/' + cand.name + '：' + ((resolved && resolved.error) || '无地址'));
        continue;
      }

      // 校验地址有效性
      const check = await this.verifyUrl(resolved.url);
      if (!check.ok && check.definitive) {
        errors.push(cand.platformLabel + '/' + cand.name + '：' + check.reason);
        continue;
      }

      this.broadcast();
      return {
        ok: true,
        tier: cand.tier,
        tierName: cand.tierName,
        song: {
          platform: cand.platform,
          platformLabel: cand.platformLabel,
          songId: cand.songId,
          id: cand.songId,
          name: cand.name,
          singer: cand.singer,
          album: cand.album,
          duration: cand.duration || Math.round((resolved.size ? 0 : 0) || 0),
          cover: cand.cover || '',
          url: resolved.url,
          quality: resolved.quality || '',
          qualityLabel: resolved.qualityLabel || '',
          mediaMid: cand.mediaMid,
        },
      };
    }

    this.broadcast();
    return { ok: false, reason: 'no-playable', detail: errors.slice(0, 3).join('；') };
  }

  /** 校验播放地址（未能确定时按可用处理，交给 mpv 判定） */
  async verifyUrl(url) {
    try {
      const { probeUrl } = require('../platforms/http');
      const res = await probeUrl(url, { timeoutMs: 8000 });
      if (res.ok) return { ok: true };
      // 429/503 等临时状态不确定，放行
      if (res.status === 429 || res.status === 503 || res.status === 403) {
        return { ok: true, uncertain: true };
      }
      return { ok: false, definitive: true, reason: res.reason };
    } catch (e) {
      return { ok: true, uncertain: true };
    }
  }

  /** 回复弹幕（由 B 站模块注入实现） */
  async reply(requester, text) {
    const cfg = this.config.danmaku || {};
    const prefix = cfg.replyPrefix == null ? '【点歌机】' : cfg.replyPrefix;
    const content = prefix + text;
    logger.info('回复 ' + (requester.uname || requester.name || '?') + '：' + content);
    this.logDanmaku({ at: Date.now(), uname: '点歌机', uid: 0, text: content, kind: 'reply', note: '' });
    if (this.replyHandler) {
      try {
        await this.replyHandler(content);
      } catch (e) {
        logger.warn('弹幕回复失败：' + e.message);
      }
    }
  }

  setReplyHandler(fn) {
    this.replyHandler = fn;
  }

  // ------------------------------------------------------------ 空闲自动播放

  /**
   * 空闲时补充一首推荐曲。
   *
   * 设计为「一次只取一首」：播完一首再取下一首，队列不会被推荐曲塞满，
   * 期间观众来点歌也能立刻排到前面。
   */
  /**
   * 空闲自动播放：取一首歌补进队列。
   *
   * 选曲策略（按需求）：
   *   1. 优先从「榜单/推荐」里取（fetchIdleSongs 已经优先走各平台榜单）；
   *   2. **随机打乱**，不要每次都从榜单第一首开始；
   *   3. **跳过最近播放过的**（recentKeys），避免刚听过又来一遍；
   *   4. 逐个尝试解析播放地址，第一个成功的就入队（最多试 maxTry 首，别把接口打爆）。
   */
  async fillFromIdleSource() {
    const cfg = this.config.idle || {};
    const count = Number(cfg.recommendCount || 20);
    const maxTry = Math.min(8, Math.max(1, Number(cfg.maxTry || 6)));
    try {
      const songs = await this.fetchIdleSongs(cfg, count);
      if (!songs.length) {
        this.lastError = '空闲推荐未取到歌曲';
        return false;
      }

      // 跳过最近播放过的
      let pool = songs.filter((s) => !this.isRecentlyPlayed(s));
      if (!pool.length) {
        // 全都刚放过：放宽限制，但仍然打乱，避免死循环在同一首
        logger.debug('空闲推荐池里的歌最近都放过，放宽「跳过最近播放」限制');
        pool = songs.slice();
      }

      // 跨平台去重：同一首歌可能在多个平台的榜单里都出现
      const seen = Object.create(null);
      pool = pool.filter((s) => {
        const k = songNameKey(s);
        if (!k) return true;
        if (seen[k]) return false;
        seen[k] = 1;
        return true;
      });

      // 随机打乱（Fisher–Yates）
      const shuffled = pool.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = t;
      }

      for (const s of shuffled.slice(0, maxTry)) {
        const resolved = await this.resolveForIdle(s);
        if (!resolved) continue;
        const pushed = this.queue.pushSilent(resolved, {
          config: { ...(this.config.order || {}), duplicateStrategy: 'cooldown', sameSongMaxTimes: 1 },
          queueLimit: Number((this.config.order && this.config.order.queueLimit) || 50),
        });
        if (pushed.ok) {
          logger.info(
            '空闲自动播放补充 1 首：' + resolved.name + (resolved.singer ? ' - ' + resolved.singer : '') +
              '（来源 ' + (cfg.source || 'platform') + '，已跳过最近播放的 ' + (songs.length - pool.length) + ' 首）'
          );
          return true;
        }
      }

      this.lastError = '空闲推荐曲目均不可播放';
      return false;
    } catch (e) {
      this.lastError = '空闲推荐失败：' + e.message;
      logger.warn(this.lastError);
      return false;
    }
  }

  async resolveForIdle(song) {
    const adapter = this.adapters[song.platform];
    if (!adapter) return null;
    try {
      const resolved = await adapter.resolveUrl(song);
      if (!resolved || !resolved.ok) return null;
      return {
        ...song,
        url: resolved.url,
        quality: resolved.quality || '',
        qualityLabel: resolved.qualityLabel || '',
      };
    } catch {
      return null;
    }
  }

  /** 拉取推荐曲：lastPlayed / playlist / roam / recommend */
  async fetchIdleSongs(cfg, count) {
    const priority = (this.config.platforms && this.config.platforms.priority) || ['netease'];
    const enabled = (this.config.platforms && this.config.platforms.enabled) || {};

    if (cfg.source === 'lastPlayed') {
      const pool = this.lastPlayed.filter((s) => s.url && enabled[s.platform] !== false);
      if (!pool.length) {
        // 没有历史时退化为平台推荐
        return this.fetchPlatformRecommend(priority, enabled, count);
      }
      return pool.slice(0, count);
    }

    if (cfg.source === 'playlist' && cfg.playlistId) {
      const p = priority.find((x) => enabled[x] !== false);
      const adapter = this.adapters[p];
      if (adapter && adapter.playlistSongs) {
        const list = await adapter.playlistSongs(cfg.playlistId, count);
        if (list.length) return list;
      }
      return this.fetchPlatformRecommend(priority, enabled, count);
    }

    // 漫游（私人FM）：按平台优先级找第一个支持的平台。
    // 目前只有网易云实现了 roamSongs；它未登录 / 被限流时会抛错或返回空，
    // 这时**退化为榜单推荐**，保证空闲时不会没歌可放。
    if (cfg.source === 'roam') {
      for (const p of priority) {
        if (enabled[p] === false) continue;
        const adapter = this.adapters[p];
        if (!adapter || typeof adapter.roamSongs !== 'function') continue;
        try {
          const list = await adapter.roamSongs(count);
          if (list && list.length) {
            logger.info('空闲漫游：' + p + ' 取到 ' + list.length + ' 首');
            return list;
          }
          logger.debug('空闲漫游：' + p + ' 返回空，换下一个平台或榜单');
        } catch (e) {
          logger.warn('空闲漫游 ' + p + ' 失败：' + e.message + '，退化为榜单');
        }
      }
      logger.info('空闲漫游没有取到歌，退化为榜单推荐');
      return this.fetchPlatformRecommend(priority, enabled, count);
    }

    return this.fetchPlatformRecommend(priority, enabled, count);
  }

  /**
   * 汇总所有启用平台的榜单/推荐，按平台优先级轮流交错。
   *
   * 不能「取第一个有结果的平台就返回」——那样只会一直用优先级最高的那家
   * （实测全是网易云）。这里把各平台的榜单都拉回来，再按 1:1:1:1 交错，
   * 这样既有榜单保证质量，四个平台也都能轮到。
   */
  async fetchPlatformRecommend(priority, enabled, count) {
    const usable = priority.filter((p) => enabled[p] !== false && this.adapters[p] && this.adapters[p].recommendSongs);
    if (!usable.length) return [];

    const lists = await Promise.all(
      usable.map(async (p) => {
        try {
          const list = await this.adapters[p].recommendSongs(count);
          if (list && list.length) {
            logger.debug(p + ' 榜单取到 ' + list.length + ' 首');
            return { p, list };
          }
        } catch (e) {
          logger.debug(p + ' 榜单失败：' + e.message);
        }
        return { p, list: [] };
      })
    );

    // 按优先级顺序轮流取（round-robin），保证第一个位置仍是最高优先级平台
    const merged = [];
    let idx = 0;
    let added = true;
    while (added && merged.length < count * usable.length) {
      added = false;
      for (const { list } of lists) {
        if (idx < list.length) {
          merged.push(list[idx]);
          added = true;
        }
      }
      idx += 1;
    }
    return merged;
  }

  // ------------------------------------------------------------ 开关与配置

  updateConfig(patch) {
    // 先合并进引擎自己的配置对象（保持引用），再落盘
    const cfgMod = require('./config');
    cfgMod.deepMerge(this.config, patch || {});
    this.saveConfig(patch);
    if (patch.play) {
      if (patch.play.volume != null) this.player.setVolume(patch.play.volume);
      if (patch.play.mpvPath) this.player.mpvPath = patch.play.mpvPath;
    }
    this.broadcast();
    // 开关变化后重新评估播放
    if (patch.idle || patch.danmaku || patch.order || patch.platforms) {
      setImmediate(() => this.pump('config'));
    }
    return this.snapshot();
  }

  async shutdown() {
    await this.stopAll();
  }
}

/**
 * 判断一行歌词是不是「制作信息」而不是真正要唱的歌词。
 * 酷我/网易云/QQ 的 LRC 里常见 作词/作曲/编曲/制作人 这类行，
 * 它们会在歌曲开头停留很久，如果拿去当「当前歌词」展示，
 * 看上去就像「歌词没出来」。
 */
const LRC_META_RE = /^\s*(\[[^\]]*\]\s*)*\s*(作词|作曲|编曲|填词|谱曲|制作人|出品|监制|混音|母带|录音|吉他|贝斯|鼓|键盘|弦乐|和声|合声|配唱|OP|SP|发行|策划|统筹|企划|文案|封面|设计|录音室|录音棚|音乐总监|专辑|原唱|翻唱|演唱|词|曲)\s*[:：]/;

/**
 * 解析 LRC 歌词文本为 [{ t, text, meta }]，按时间升序。
 * 兼容 [mm:ss.xx] / [mm:ss:xx] / [mm:ss] 三种时间戳，一行多个时间戳会展开成多条。
 * meta=true 表示这行是制作信息，展示端可以选择跳过。
 */
function parseLrc(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const out = [];
  const timeRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of raw.split(/\r?\n/)) {
    timeRe.lastIndex = 0;
    const stamps = [];
    let m;
    while ((m = timeRe.exec(line)) !== null) {
      const min = Number(m[1]) || 0;
      const sec = Number(m[2]) || 0;
      const fracRaw = m[3] || '0';
      const frac = Number(fracRaw) / Math.pow(10, fracRaw.length || 1);
      stamps.push(min * 60 + sec + frac);
    }
    if (!stamps.length) continue;
    const text = line.replace(timeRe, '').trim();
    if (!text) continue;
    const meta = LRC_META_RE.test(text);
    for (const t of stamps) out.push({ t, text, meta });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function statusText(phase, switches) {
  if (!switches.danmakuOrder && !switches.idleAutoPlay) return '已关闭';
  switch (phase) {
    case PHASE.PLAYING:
      return '播放中';
    case PHASE.STOPPING:
      return '停止中';
    case PHASE.CLOSED:
      return '已关闭';
    case PHASE.IDLE:
    default:
      return switches.idleAutoPlay ? '空闲（等待推荐）' : '空闲';
  }
}

module.exports = { Engine, PHASE, statusText, getCachedCandidate, candidateKey };
