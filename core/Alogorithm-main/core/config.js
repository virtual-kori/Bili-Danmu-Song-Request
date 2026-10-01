/**
 * 配置加载与持久化。
 *
 * 目录约定（根目录只留「一键启动脚本 + config.json」，其余全部在 core/ 下）：
 *   <根目录>/config.json               用户可见的唯一主配置入口
 *   <根目录>/core/platform-ports.json  四个平台的端口与登录 Cookie
 */
const fs = require('fs');
const path = require('path');

/** 程序目录：core/Alogorithm-main */
const APP_DIR = path.resolve(__dirname, '..');
/** 二级文件夹：core/ */
const CORE_DIR = path.resolve(APP_DIR, '..');
/** 根目录：点歌机/ */
const ROOT = path.resolve(CORE_DIR, '..');

const CONFIG_PATH = path.join(ROOT, 'config.json');
const PLATFORM_PATH = path.join(CORE_DIR, 'platform-ports.json');

const DEFAULT_CONFIG = {
  server: { host: '127.0.0.1', port: 33000, openBrowser: true },
  danmaku: {
    enabled: true,
    roomId: 0,
    replyEnabled: true,
    replyPrefix: '【点歌机】',
    replyCooldownMs: 5000,
    reconnectBaseMs: 2000,
    reconnectMaxMs: 60000,
  },
  play: {
    mpvPath: '',
    volume: 80,
    audioDevice: '',
    extraArgs: [],
    streamTimeoutMs: 30000,
    wallClockSlackMs: 30000,
    unknownDurationTimeoutMs: 600000,
  },
  order: {
    prefixes: ['点歌'],
    allowStringPrefixMatch: true,
    userCooldownMs: 60000,
    queueLimit: 50,
    sameSongMaxTimes: 2,
    duplicateStrategy: 'cooldown',
    blacklistUsers: [],
    blacklistWords: [],
    requireDanmakuSwitch: true,
  },
  // 空闲自动播放：默认走「平台榜单/推荐」而不是「上次播放列表」——
  // 后者本质是把历史重放一遍，容易反复听到同一首；前者能一直有新歌。
  // maxTry = 一次空闲补充最多尝试解析几首（防把平台接口打爆）
  idle: { enabled: false, source: 'platform', playlistId: '', recommendCount: 20, maxTry: 6 },
  platforms: {
    priority: ['netease', 'qq', 'kugou', 'kuwo'],
    enabled: { netease: true, qq: true, kugou: true, kuwo: true },
  },
  log: { danmaku: true, level: 'info', keepDays: 7 },
};

const DEFAULT_PLATFORMS = {
  netease: { label: '网易云音乐', port: 33011, cookie: '', loggedInUser: '' },
  qq: { label: 'QQ音乐', port: 33012, cookie: '', loggedInUser: '' },
  kugou: { label: '酷狗音乐', port: 33013, cookie: '', loggedInUser: '' },
  kuwo: { label: '酷我音乐', port: 33014, cookie: '', token: '', loggedInUser: '' },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(patch)) {
    const bv = base ? base[key] : undefined;
    const pv = patch[key];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[key] = deepMerge(bv, pv);
    } else if (pv !== undefined) {
      out[key] = pv;
    }
  }
  return out;
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return JSON.parse(JSON.stringify(fallback));
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('[config] 读取失败 ' + file + ': ' + e.message + '，使用默认值');
    return JSON.parse(JSON.stringify(fallback));
  }
}

let config = deepMerge(DEFAULT_CONFIG, readJson(CONFIG_PATH, {}));
let platforms = deepMerge(DEFAULT_PLATFORMS, readJson(PLATFORM_PATH, {}));

/**
 * 就地合并进已有的对象，保证所有持有引用的模块（引擎、适配器）
 * 都能立即看到最新配置，避免出现「配置文件已改、运行时还是旧值」。
 */
function applyInPlace(target, patch) {
  if (!patch || typeof patch !== 'object') return target;
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    const tv = target[key];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      applyInPlace(tv, pv);
    } else if (pv !== undefined) {
      target[key] = pv;
    }
  }
  return target;
}

function saveConfig(patch) {
  applyInPlace(config, patch || {});
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  return config;
}

function savePlatforms(patch) {
  applyInPlace(platforms, patch || {});
  fs.writeFileSync(PLATFORM_PATH, JSON.stringify(platforms, null, 2), 'utf8');
  return platforms;
}

/** 把根目录的 config.json 补齐为完整结构（首次运行时用） */
function ensureConfigFiles() {
  if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  if (!fs.existsSync(PLATFORM_PATH)) fs.writeFileSync(PLATFORM_PATH, JSON.stringify(DEFAULT_PLATFORMS, null, 2), 'utf8');
}

module.exports = {
  ROOT,
  CORE_DIR,
  APP_DIR,
  CONFIG_PATH,
  PLATFORM_PATH,
  DEFAULT_CONFIG,
  DEFAULT_PLATFORMS,
  get config() {
    return config;
  },
  get platforms() {
    return platforms;
  },
  saveConfig,
  savePlatforms,
  ensureConfigFiles,
  deepMerge,
};
