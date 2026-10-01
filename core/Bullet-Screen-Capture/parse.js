/**
 * 点歌指令解析。
 *
 * 规则（对应需求 1）：
 *  - 仅处理以「点歌」为前缀的弹幕，兼容「点歌：」「点歌，」「点歌 」「点歌xxx」；
 *  - 去除首尾空格、统一全角标点为半角；
 *  - 按空格 / 逗号 / 顿号 / 竖线拆分；
 *  - 只有一段 → 全部作为歌名；
 *  - 两段及以上 → 最后一段作为歌手，其余合并为歌名。
 */

/** 全角字符转半角（含全角空格） */
function toHalfWidth(text) {
  return String(text).replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');
}

/** 统一标点：把各种分隔符统一为半角逗号 */
function normalizePunctuation(text) {
  return String(text)
    .replace(/[：:]/g, ':')
    .replace(/[，、,]/g, ',')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[「」【】《》]/g, '')
    .replace(/[！!]+/g, '!')
    .replace(/[？?]+/g, '?');
}

/** 基础清洗：去零宽字符、合并空白 */
function clean(text) {
  return String(text == null ? '' : text)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 是否是一条点歌指令。
 * @param {string} text 弹幕原文
 * @param {string[]} prefixes 前缀表，默认 ['点歌']
 * @returns {{matched:boolean, prefix?:string, rest?:string}}
 */
function matchPrefix(text, prefixes = ['点歌'], allowStringPrefixMatch = true) {
  const raw = clean(text);
  if (!raw) return { matched: false };
  for (const prefix of prefixes) {
    const p = clean(prefix);
    if (!p) continue;
    if (raw.startsWith(p)) {
      return { matched: true, prefix: p, rest: raw.slice(p.length) };
    }
    // 允许「点歌xxx」这类无分隔写法，仅当剩余部分不是纯标点
    if (allowStringPrefixMatch && raw.startsWith(p)) {
      return { matched: true, prefix: p, rest: raw.slice(p.length) };
    }
  }
  return { matched: false };
}

/**
 * 解析点歌指令。
 *
 * @param {string} text 弹幕原文
 * @param {object} [options]
 * @param {string[]} [options.prefixes] 前缀表
 * @param {boolean} [options.allowStringPrefixMatch] 是否允许前缀后无分隔符
 * @returns {{ok:boolean, reason?:string, name?:string, singer?:string, raw:string, rest?:string}}
 */
function parseSongRequest(text, options = {}) {
  const prefixes = options.prefixes || ['点歌'];
  const allowStringPrefixMatch = options.allowStringPrefixMatch !== false;
  const raw = clean(text);

  if (!raw) return { ok: false, reason: 'empty', raw };

  const hit = matchPrefix(raw, prefixes, allowStringPrefixMatch);
  if (!hit.matched) return { ok: false, reason: 'not-command', raw };

  // 去掉前缀后的分隔符（: ， 、 ! ? 空格等）
  let rest = toHalfWidth(hit.rest);
  rest = normalizePunctuation(rest);
  rest = rest.replace(/^[\s:,!?.\-|~]+/, '').replace(/[\s:,!?.\-|~]+$/, '');
  rest = clean(rest);

  if (!rest) return { ok: false, reason: 'no-keyword', raw, prefix: hit.prefix };

  // 拆分：空格 / 逗号 / 顿号 / 竖线 / 斜杠
  const parts = rest
    .split(/[\s,|/]+/)
    .map((s) => clean(s))
    .filter(Boolean);

  if (parts.length === 0) return { ok: false, reason: 'no-keyword', raw, prefix: hit.prefix };
  if (parts.length === 1) {
    return { ok: true, name: parts[0], singer: '', raw, rest, prefix: hit.prefix };
  }

  const singer = parts[parts.length - 1];
  const name = parts.slice(0, -1).join(' ');
  return { ok: true, name, singer, raw, rest, prefix: hit.prefix };
}

/**
 * 歌曲名/歌手清洗，用于「完全一致」比较：
 * 去空格、去括号内容、忽略大小写、去掉常见后缀。
 */
function normalizeForCompare(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/（[^）]*）/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[·、,，.。!！?？'"“”‘’\-_—~～&+]/g, '')
    .replace(/(live|feat|ft|remix|伴奏|纯音乐|翻自|cover|dj版|正式版|原唱|高音质|无损)/g, '')
    .trim();
}

/** 比较用简化的歌手串（多个歌手统一分隔） */
function normalizeSinger(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .split(/[&、,，/;；]+/)
    .map((s) => s.replace(/[()（）\[\]【】]/g, ''))
    .filter(Boolean);
}

module.exports = {
  parseSongRequest,
  matchPrefix,
  normalizeForCompare,
  normalizeSinger,
  clean,
  toHalfWidth,
  normalizePunctuation,
};
