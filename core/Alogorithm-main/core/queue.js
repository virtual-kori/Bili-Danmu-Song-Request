/**
 * 点歌队列：负责入队校验、排序、置顶、删除与去重。
 *
 * 排序规则（取队首时）：
 *   1. 置顶项优先（置顶时间早的在前）
 *   2. 其余按加入时间先后
 */
const { EventEmitter } = require('events');
const logger = require('./logger').make('queue');

let seq = 0;
function nextId() {
  seq += 1;
  return 'q' + Date.now().toString(36) + '-' + seq;
}

class Queue extends EventEmitter {
  constructor() {
    super();
    /** @type {Array<object>} */
    this.items = [];
    /** @type {Array<object>} 已播放历史（最新在前） */
    this.history = [];
    this.maxHistory = 200;
  }

  get length() {
    return this.items.length;
  }

  list() {
    return this.sorted();
  }

  /** 按播放顺序返回队列 */
  sorted() {
    return [...this.items].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) return (a.pinnedAt || 0) - (b.pinnedAt || 0);
      return a.addedAt - b.addedAt;
    });
  }

  peek() {
    const s = this.sorted();
    return s.length ? s[0] : null;
  }

  find(id) {
    return this.items.find((it) => it.id === id) || null;
  }

  /** 同名同歌手（清洗后）在队列中的出现次数 */
  countDuplicate(song) {
    const key = normKey(song);
    return this.items.filter((it) => normKey(it) === key).length;
  }

  /**
   * 入队。
   * @returns {{ok:boolean, reason?:string, item?:object}}
   */
  push(song, options = {}) {
    const cfg = options.config || {};
    const strategy = cfg.duplicateStrategy || 'cooldown';
    const sameSongMaxTimes = Math.max(1, Number(cfg.sameSongMaxTimes) || 1);

    if (this.items.length >= (options.queueLimit || 50)) {
      return { ok: false, reason: '队列已满（上限 ' + (options.queueLimit || 50) + ' 首）' };
    }

    const dupCount = this.countDuplicate(song);
    if (strategy === 'reject' && dupCount > 0) {
      return { ok: false, reason: '该歌曲已在队列中' };
    }
    if (strategy === 'cooldown' && dupCount >= sameSongMaxTimes) {
      return { ok: false, reason: '该歌曲已在队列中（同曲最多 ' + sameSongMaxTimes + ' 次）' };
    }

    const item = {
      id: nextId(),
      name: song.name,
      singer: song.singer || '',
      platform: song.platform,
      platformLabel: song.platformLabel || song.platform,
      songId: song.songId || song.id || '',
      album: song.album || '',
      quality: song.quality || '',
      qualityLabel: song.qualityLabel || '',
      duration: song.duration || 0,
      url: song.url || '',
      cover: song.cover || '',
      requester: options.requester || 'Web UI',
      requesterUid: options.requesterUid || 0,
      source: options.source || 'danmaku',
      addedAt: Date.now(),
      pinned: false,
      pinnedAt: 0,
      playCount: dupCount + 1,
      lyric: song.lyric || '',
    };
    this.items.push(item);
    this.emit('change');
    logger.info('入队 ' + item.name + ' - ' + item.singer + '（' + item.platformLabel + '） by ' + item.requester);
    return { ok: true, item };
  }

  remove(id) {
    const idx = this.items.findIndex((it) => it.id === id);
    if (idx < 0) return false;
    const [item] = this.items.splice(idx, 1);
    this.emit('change');
    logger.info('删除队列项 ' + item.name + ' - ' + item.singer);
    return true;
  }

  clear() {
    const n = this.items.length;
    this.items = [];
    this.emit('change');
    logger.info('清空队列，共 ' + n + ' 首');
    return n;
  }

  setPinned(id, pinned) {
    const item = this.find(id);
    if (!item) return null;
    item.pinned = Boolean(pinned);
    item.pinnedAt = item.pinned ? Date.now() : 0;
    this.emit('change');
    logger.info((pinned ? '置顶 ' : '取消置顶 ') + item.name);
    return item;
  }

  /** 把队列项移动到指定位置（drag 排序，仅影响同优先级内部顺序） */
  move(id, toIndex) {
    const sorted = this.sorted();
    const from = sorted.findIndex((it) => it.id === id);
    if (from < 0) return false;
    const [item] = sorted.splice(from, 1);
    const clamped = Math.max(0, Math.min(sorted.length, Number(toIndex)));
    sorted.splice(clamped, 0, item);

    // 依据新顺序重写 addedAt / pinnedAt，保证 sorted() 结果与用户预期一致
    const pinnedItems = sorted.filter((it) => it.pinned);
    const normalItems = sorted.filter((it) => !it.pinned);
    const base = Date.now() - sorted.length * 1000;
    pinnedItems.forEach((it, i) => {
      it.pinnedAt = base + i;
    });
    normalItems.forEach((it, i) => {
      it.addedAt = base + 10000 + i;
    });
    this.emit('change');
    return true;
  }

  /** 记录一次播放（从队列取出并写入历史） */
  consume(id, playing) {
    const idx = this.items.findIndex((it) => it.id === id);
    if (idx >= 0) this.items.splice(idx, 1);
    if (playing) {
      this.history.unshift({
        name: playing.name,
        singer: playing.singer,
        platform: playing.platform,
        platformLabel: playing.platformLabel,
        songId: playing.songId,
        album: playing.album,
        url: playing.url,
        requester: playing.requester,
        playedAt: Date.now(),
      });
      if (this.history.length > this.maxHistory) this.history.length = this.maxHistory;
    }
    this.emit('change');
  }

  /** 给推荐曲目使用：静默入队（不触发“点歌”语义） */
  pushSilent(song, options = {}) {
    return this.push(song, { ...options, requester: options.requester || '空闲推荐' });
  }
}

function normKey(song) {
  const clean = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[\s()（）[\]【】·、,，.。!！?？'"“”‘’\-_/\\]/g, '');
  return clean(song.name) + '|' + clean(song.singer);
}

module.exports = { Queue, normKey };
