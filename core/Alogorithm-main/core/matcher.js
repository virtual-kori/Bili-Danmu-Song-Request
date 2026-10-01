/**
 * 四平台搜索结果的匹配打分与排序。
 *
 * 匹配优先级（从高到低，对应需求 2）：
 *   1. 歌名完全一致 + 歌手完全一致
 *   2. 歌名完全一致 + 歌手包含/相似
 *   3. 歌名相似 + 歌手匹配
 *   4. 仅歌名相似
 * 同优先级下按平台优先级排序。
 */
const { normalizeForCompare, normalizeSinger } = require('../../Bullet-Screen-Capture/parse');

const TIER_NAMES = {
  1: '歌名+歌手完全一致',
  2: '歌名完全一致+歌手相似',
  3: '歌名相似+歌手匹配',
  4: '仅歌名相似',
  0: '未匹配',
};

/**
 * 最低相似度门槛。
 * 没有歌手信息时平台会「尽力而为」地返回一堆不相关结果（例如搜索乱码关键词
 * 也会返回某首歌），因此仅靠「歌名相似」这一档必须设下限，否则会误点歌。
 */
const MIN_NAME_SIMILARITY = 0.62;

/** Levenshtein 距离 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 0~1 的相似度 */
function similarity(a, b) {
  const x = normalizeForCompare(a);
  const y = normalizeForCompare(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
    return 0.75 + 0.2 * ratio;
  }
  const dist = levenshtein(x, y);
  return Math.max(0, 1 - dist / Math.max(x.length, y.length));
}

/** 歌手匹配度：完全一致 / 包含 / 相似 */
function singerScore(reqSinger, candSinger) {
  if (!reqSinger) return { level: 0, score: 0 };
  const reqList = normalizeSinger(reqSinger);
  const candList = normalizeSinger(candSinger);
  if (!reqList.length || !candList.length) return { level: 0, score: 0 };

  const reqJoined = reqList.join('');
  const candJoined = candList.join('');
  if (reqJoined === candJoined) return { level: 2, score: 1 };

  let best = 0;
  for (const r of reqList) {
    for (const c of candList) {
      if (r === c) best = Math.max(best, 1);
      else if (c.includes(r) || r.includes(c)) best = Math.max(best, 0.85);
      else best = Math.max(best, similarity(r, c) * 0.8);
    }
  }
  if (best >= 0.85) return { level: 2, score: best };
  if (best >= 0.6) return { level: 1, score: best };
  return { level: 0, score: best };
}

/**
 * 给单个候选打分。
 * @param {{name:string,singer:string}} request 点歌请求
 * @param {object} candidate 平台候选
 * @returns {{tier:number, tierName:string, score:number}}
 */
function scoreCandidate(request, candidate) {
  const nameSim = similarity(request.name, candidate.name);
  const singer = singerScore(request.singer, candidate.singer);
  const nameExact = normalizeForCompare(request.name) === normalizeForCompare(candidate.name);

  let tier = 0;
  if (nameExact && request.singer && singer.level === 2) tier = 1;
  else if (nameExact && request.singer && singer.level >= 1) tier = 2;
  else if (nameExact && !request.singer) tier = 1;
  else if (nameSim >= 0.72 && request.singer && singer.level >= 1) tier = 3;
  else if (nameSim >= MIN_NAME_SIMILARITY) tier = 4;
  else if (nameExact) tier = 2;

  // 歌名相似度过低时一律不接受（平台对无意义关键词也会返回结果）
  if (tier === 4 && nameSim < MIN_NAME_SIMILARITY) tier = 0;

  // 综合分：匹配层级为主，相似度与歌手匹配为辅
  const score = (5 - tier) * 100 + nameSim * 20 + singer.score * 10;
  return { tier, tierName: TIER_NAMES[tier] || TIER_NAMES[0], score, nameSim, singerScore: singer.score };
}

/**
 * 从所有平台候选中挑出最佳结果。
 *
 * @param {{name:string,singer:string}} request
 * @param {Array<object>} candidates 候选（需含 platform 字段）
 * @param {string[]} platformPriority 平台优先级（靠前优先）
 * @returns {{best:object|null, ranked:Array<object>}}
 */
function rankCandidates(request, candidates, platformPriority = []) {
  const prioIndex = (p) => {
    const i = platformPriority.indexOf(p);
    return i < 0 ? platformPriority.length + 1 : i;
  };

  const ranked = candidates
    .map((c) => {
      const s = scoreCandidate(request, c);
      return { ...c, ...s, priority: prioIndex(c.platform) };
    })
    .filter((c) => c.tier > 0)
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (b.score !== a.score) return b.score - a.score;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return 0;
    });

  return { best: ranked[0] || null, ranked };
}

module.exports = { rankCandidates, scoreCandidate, similarity, singerScore, levenshtein, TIER_NAMES };
