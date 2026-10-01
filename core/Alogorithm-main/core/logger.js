/**
 * 简易日志：同时输出到控制台与 logs/ 目录下的按天文件。
 */
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel = LEVELS.info;
let stream = null;
let streamDate = '';
let keepDays = 7;

/**
 * 防「日志把自己写爆」的几个闸门。
 *
 * 背景（真实事故）：控制台被关闭后往 stdout 写会抛 EPIPE，
 * 而 `uncaughtException` 处理器又把这条异常写进日志 → 又抛 EPIPE → 无限递归，
 * 结果一个日志文件涨到 2.5 GB。
 *
 * 所以这里做三件事：
 *   1. 写控制台本身用 try/catch 包住，写失败绝不再抛；
 *   2. 日志写入可重入保护：正在写日志时发生的新日志直接丢弃；
 *   3. 完全忽略 EPIPE / ERR_STREAM_DESTROYED 这类「对端没了」的错误。
 */
const IGNORED_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);
let insideWrite = false;

function isIgnorable(err) {
  if (!err) return false;
  if (IGNORED_CODES.has(err.code)) return true;
  return /broken pipe|EPIPE|write after end/i.test(String(err.message || ''));
}

/** 往控制台写，失败就算了 —— 绝不能让「打日志」变成新的异常源 */
function safeConsole(fn, line) {
  try {
    fn(line);
  } catch {
    /* stdout/stderr 已经不可用（控制台被关、管道断开），忽略 */
  }
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function ensureStream() {
  const day = today();
  if (stream && streamDate === day) return stream;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (stream) stream.end();
    stream = fs.createWriteStream(path.join(LOG_DIR, 'diankeji-' + day + '.log'), { flags: 'a' });
    // 写文件出错（磁盘满、权限变化等）不能让进程崩
    stream.on('error', () => {
      stream = null;
    });
    streamDate = day;
    cleanup();
  } catch {
    stream = null;
  }
  return stream;
}

function cleanup() {
  try {
    const files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => /^diankeji-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort();
    while (files.length > keepDays) {
      const f = files.shift();
      fs.unlinkSync(path.join(LOG_DIR, f));
    }
  } catch {
    /* ignore */
  }
}

function setLevel(level) {
  if (LEVELS[level]) minLevel = LEVELS[level];
}

function setKeepDays(days) {
  keepDays = Math.max(1, Number(days) || 7);
}

function write(level, scope, args) {
  if (LEVELS[level] < minLevel) return;
  // 可重入保护：写日志的过程中又触发写日志（典型是 uncaughtException 处理器的递归），
  // 直接丢弃，避免无限循环把日志文件写爆。
  if (insideWrite) return;
  insideWrite = true;
  try {
    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    const text = args
      .map((a) => {
        if (a instanceof Error) {
          if (isIgnorable(a)) return '(忽略：' + (a.code || a.message) + ')';
          return a.stack || a.message;
        }
        if (a && typeof a === 'object' && isIgnorable(a)) return '(忽略：' + a.code + ')';
        if (typeof a === 'object') {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(' ');
    const line = '[' + time + '][' + level.toUpperCase() + '][' + scope + '] ' + text;
    if (level === 'error') safeConsole((l) => console.error(l), line);
    else if (level === 'warn') safeConsole((l) => console.warn(l), line);
    else safeConsole((l) => console.log(l), line);
    const s = ensureStream();
    if (s) {
      try {
        s.write(line + '\n');
      } catch {
        /* 磁盘/权限问题，忽略 */
      }
    }
  } finally {
    insideWrite = false;
  }
}

function make(scope) {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}

module.exports = { make, setLevel, setKeepDays, LOG_DIR };
