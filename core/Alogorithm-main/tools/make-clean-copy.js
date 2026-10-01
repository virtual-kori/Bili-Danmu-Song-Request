/**
 * 在桌面生成一份「干净副本」：程序本体齐全，但不含任何运行数据与凭据。
 *
 * 清掉的东西：
 *   · 运行日志（弹幕记录）           core/Alogorithm-main/logs/
 *   · 各平台登录 Cookie             core/platform-ports.json、各平台 data/cookie.json
 *   · B 站登录态                    core/Bullet-Screen-Capture/bili-auth.json
 *   · 直播间房间号 / 弹幕开关状态    config.json 里的 danmaku 段
 *   · 登录二维码图片、陈旧残留配置
 *
 * 用法：node core\Alogorithm-main\tools\make-clean-copy.js [目标目录]
 *   不传目标目录时，默认在项目同级生成「<项目名>-干净版」。
 */
const fs = require('fs');
const path = require('path');

// 本脚本在 core/Alogorithm-main/tools/ 下，项目根目录要往上一共三层
const ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_DEST = path.join(path.dirname(ROOT), path.basename(ROOT) + '-干净版');
const DEST = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DEST;

const log = (m) => console.log(m);
const line = () => '='.repeat(64);

/** 需要排除的文件（相对 ROOT，用 / 分隔） */
const EXCLUDE_FILES = [
  'core/platform-ports.json', // 含登录 Cookie
  'core/Bullet-Screen-Capture/bili-auth.json', // 含 B 站登录态
  'core/kuwoMusicApi/live/data/cookie.json',
  'core/QQMusicApi/live/data/cookie.json',
  'core/Alogorithm-main/config.json', // 旧版本残留，程序已不使用
  'core/KuGouMusicApi/_npmcache/package.json', // npm 缓存目录（整个目录见 EXCLUDE_DIRS）
];

/**
 * 需要排除的目录（相对 ROOT，用 / 分隔）。
 *
 * 注意：**不要**按名字通配排除 `_开头` 或 `.开头` 的条目 ——
 * 项目里有正经文件叫 `module/_comment.js`、`docs/_coverpage.md`，
 * npm 也会把作用域包存成 `node_modules/_types` 这种名字，
 * 一并排除会导致酷狗等服务直接起不来（真实踩过）。
 * 这里只精确排除已知的运行数据与缓存目录。
 */
const EXCLUDE_DIRS = [
  'core/Alogorithm-main/logs',
  'core/KuGouMusicApi/_npmcache',
  'core/KuGouMusicApi/.github',
  'core/kuwoMusicApi/.github',
  'core/kuwoMusicApi/.vscode',
  'core/QQMusicApi/.github',
  'core/QQMusicApi/.agents',
  'core/Netease-Api/.github',
];

/** 兜底：任何路径里出现这些「一定是运行数据」的模式都跳过 */
const SKIP_ANY = [
  /\\logs\\/i,
  /\\_npmcache\\/i,
  /[\\/]data[\\/]cookie\.json$/i,
  /bili-auth\.json$/i,
  /[\\/]platform-ports\.json$/i,
  /^Alogorithm-main[\\/]config\.json$/i,
];

function shouldSkip(relPath) {
  const p = relPath.split(path.sep).join('/');
  if (EXCLUDE_DIRS.some((d) => p === d || p.startsWith(d + '/'))) return true;
  if (EXCLUDE_FILES.some((f) => p === f)) return true;
  if (SKIP_ANY.some((re) => re.test(relPath))) return true;
  return false;
}

function copyTree(src, dst, rel = '') {
  let count = 0;
  let bytes = 0;
  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return { count, bytes };
  }
  for (const e of entries) {
    const relChild = rel ? path.join(rel, e.name) : e.name;
    if (shouldSkip(relChild)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      const sub = copyTree(s, d, relChild);
      count += sub.count;
      bytes += sub.bytes;
    } else if (e.isFile()) {
      fs.copyFileSync(s, d);
      count += 1;
      bytes += fs.statSync(d).size;
    }
  }
  return { count, bytes };
}

/**
 * 需要脱敏的文件内容。
 *
 * 上游库自带的一些模板/文档注释里，夹带了**别人的真实账号信息**
 * （酷我那套 config.default.ts 的示例 Cookie 里就有真实微信昵称、头像地址、
 * userid/websid）。虽然不是你自己的数据，但也没必要带着走，副本里抹成占位符。
 */
const REDACTIONS = [
  {
    file: 'core/kuwoMusicApi/config/config.default.ts',
    rules: [
      [/uname3=%u[0-9A-Fa-f]{4}(?:%u[0-9A-Fa-f]{4})*/g, 'uname3=<昵称已脱敏>'],
      [/t3kwid=\d+/g, 't3kwid=000000000'],
      [/userid=\d+/g, 'userid=000000000'],
      [/websid=\d+/g, 'websid=000000000'],
      [/JSESSIONID=[A-Za-z0-9]+/g, 'JSESSIONID=<已脱敏>'],
      [/gid=[0-9a-f-]{36}/g, 'gid=<已脱敏>'],
      [/pic3="[^"]*"/g, 'pic3="<头像地址已脱敏>"'],
    ],
  },
];

/** 对副本里的文件做内容脱敏 */
function applyRedactions(destRoot) {
  const done = [];
  for (const { file, rules } of REDACTIONS) {
    const full = path.join(destRoot, file);
    if (!fs.existsSync(full)) continue;
    let text = fs.readFileSync(full, 'utf8');
    let hits = 0;
    for (const [re, rep] of rules) {
      const next = text.replace(re, rep);
      if (next !== text) hits += 1;
      text = next;
    }
    if (hits) {
      fs.writeFileSync(full, text, 'utf8');
      done.push(file + '（' + hits + ' 处）');
    }
  }
  return done;
}

/** 清空 config.json 里的房间号等运行信息，但保留用户的规则设置结构 */
function sanitizeConfig(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const cfg = JSON.parse(raw);
  const before = {
    roomId: (cfg.danmaku && cfg.danmaku.roomId) || 0,
    enabled: cfg.danmaku && cfg.danmaku.enabled,
  };
  // 房间号与「已开启监听」属于运行期状态，干净副本里应回到未设置
  if (cfg.danmaku) {
    cfg.danmaku.roomId = 0;
    cfg.danmaku.enabled = false;
  }
  // 播放器路径可能与本机绑定
  if (cfg.play) cfg.play.mpvPath = '';
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return before;
}

/** 生成一份空的 platform-ports.json（保持结构，cookie 全空） */
function writeEmptyPorts(file) {
  const empty = {
    netease: { label: '网易云音乐', port: 33011, cookie: '', loggedInUser: '' },
    qq: { label: 'QQ音乐', port: 33012, cookie: '', loggedInUser: '' },
    kugou: { label: '酷狗音乐', port: 33013, cookie: '', loggedInUser: '' },
    kuwo: { label: '酷我音乐', port: 33014, cookie: '', token: '', loggedInUser: '' },
  };
  fs.writeFileSync(file, JSON.stringify(empty, null, 2) + '\n', 'utf8');
}

/** 生成空的 B 站登录态文件 */
function writeEmptyBiliAuth(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ sessdata: '', biliJct: '', buvid3: '', dedeUserId: '', updatedAt: 0 }, null, 2) + '\n',
    'utf8'
  );
}

// ---------------------------------------------------------------- 主流程

log(line());
log('  制作干净副本');
log(line());
log('源目录  : ' + ROOT);
log('目标目录: ' + DEST);
log('');

if (fs.existsSync(DEST)) {
  log('[1/5] 目标已存在，先删除…');
  fs.rmSync(DEST, { recursive: true, force: true });
} else {
  log('[1/5] 目标不存在，准备创建');
}
fs.mkdirSync(DEST, { recursive: true });

log('\n[2/5] 复制程序本体（跳过日志与凭据）…');
const t0 = Date.now();
const { count, bytes } = copyTree(ROOT, DEST);
log('      复制 ' + count + ' 个文件，' + (bytes / 1024 / 1024).toFixed(1) + ' MB，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

log('\n[3/5] 清理运行数据…');
const cfgPath = path.join(DEST, 'config.json');
let cfgBefore = null;
if (fs.existsSync(cfgPath)) {
  cfgBefore = sanitizeConfig(cfgPath);
  log('      config.json：房间号 ' + cfgBefore.roomId + ' → 0，弹幕监听 ' + cfgBefore.enabled + ' → false');
}
writeEmptyPorts(path.join(DEST, 'core', 'platform-ports.json'));
log('      core/platform-ports.json：重建为全空 Cookie');
writeEmptyBiliAuth(path.join(DEST, 'core', 'Bullet-Screen-Capture', 'bili-auth.json'));
log('      bili-auth.json：重建为未登录');
fs.mkdirSync(path.join(DEST, 'core', 'Alogorithm-main', 'logs'), { recursive: true });
log('      logs/：重建为空目录');
const redacted = applyRedactions(DEST);
if (redacted.length) log('      上游模板里的他人信息已脱敏：' + redacted.join('、'));

log('\n[4/5] 校验：确认副本不含任何凭据与房间号');
const findings = [];
(function scan(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      scan(p);
      continue;
    }
    const rel = path.relative(DEST, p);
    // 日志文件不该存在
    if (/diankeji-\d{4}-\d{2}-\d{2}\.log$/.test(e.name)) findings.push('残留日志 ' + rel);
    // 登录二维码图不该存在
    if (/^login-qr-.*\.png$/.test(e.name)) findings.push('残留二维码 ' + rel);
    // 目录名带 node_modules 的跳过内容扫描
    if (rel.includes('node_modules')) continue;
    if (e.name === 'config.json' || /\.json$/.test(e.name)) {
      let text = '';
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      // 找非空的 cookie 字段
      const m = /"(cookie|sessdata|biliJct|musickey|MUSIC_U)"\s*:\s*"([^"]{8,})"/i.exec(text);
      if (m) findings.push('疑似凭据 ' + rel + ' → ' + m[1] + ' 有值');
    }
  }
})(DEST);

// 房间号检查
let roomIdLeft = 0;
try {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  roomIdLeft = Number((cfg.danmaku && cfg.danmaku.roomId) || 0);
} catch {
  /* ignore */
}
if (roomIdLeft) findings.push('config.json 仍有 roomId=' + roomIdLeft);

if (findings.length) {
  log('      ❌ 发现 ' + findings.length + ' 处问题：');
  findings.slice(0, 20).forEach((f) => log('         · ' + f));
} else {
  log('      ✅ 未发现凭据、日志、二维码或房间号残留');
}

log('\n[5/5] 完成');
const total = (function size(dir) {
  let s = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) s += size(p);
    else if (e.isFile()) s += fs.statSync(p).size;
  }
  return s;
})(DEST);
log('      体积：' + (total / 1024 / 1024).toFixed(1) + ' MB');
log('      路径：' + DEST);
log(line());

process.exit(findings.length ? 1 : 0);
