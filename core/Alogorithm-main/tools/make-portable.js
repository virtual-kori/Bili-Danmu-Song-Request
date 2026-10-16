/**
 * 打包「自带前置运行时的绿色便携版」。
 *
 * 产出：
 *   Desktop\点歌机-便携版\        （解压后的样子）
 *   Desktop\DianGeJi-Portable.zip （发给别人的压缩包）
 *
 * 目录约定：**前置运行时统一放 core\ 里**
 *   core\node\node.exe      启动脚本优先用它（找不到才回退系统 Node）
 *   core\python\python.exe  一起带上。注意：本项目**运行时并不调用 Python** ——
 *                           QQ 服务跑的是 live\server.js（Node 实现，配方移植自
 *                           QQMusicApi 里那套 Python 库）。带上 Python 是为了让
 *                           core\QQMusicApi 的 Python 库/mqtt 相关脚本能直接跑。
 *
 * 额外做的三件事：
 *   1. 从指定位置把运行时复制到 core\
 *   2. 把 7 个 .bat 改成「优先自带 Node，缺失才回退系统 Node」
 *   3. 清运行数据 + 脱敏 + 自查 + 打 zip
 *
 * 用法：node core\Alogorithm-main\tools\make-portable.js [--node <node运行时目录>] [--python <python运行时目录>] [--out <目标目录>]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DESKTOP = path.dirname(ROOT);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT_DIR = path.resolve(arg('--out', path.join(DESKTOP, '点歌机-便携版')));
const ZIP_PATH = path.join(DESKTOP, 'DianGeJi-Portable.zip');

/** 运行时来源：项目自身优先（core\node、core\python），再去常见位置找 */
const SEARCH_BASES = [
  path.join(ROOT, 'core'),
  path.join(ROOT, 'runtime'),
  path.join(DESKTOP, '点歌机-便携版', 'runtime'),
  DESKTOP,
];

function findRuntimeDir(name, explicit) {
  if (explicit) return path.resolve(explicit);
  for (const base of SEARCH_BASES) {
    const p = path.join(base, name);
    if (fs.existsSync(path.join(p, name + '.exe'))) return p;
  }
  return '';
}

const NODE_SRC = findRuntimeDir('node', arg('--node', ''));
const PYTHON_SRC = findRuntimeDir('python', arg('--python', ''));

const log = (m) => console.log(m);
const hr = () => log('='.repeat(64));

// ---------------------------------------------------------------- 排除规则

const EXCLUDE_DIRS = [
  'core/Alogorithm-main/logs',
  // 网易云 API 的运行时缓存（匿名 token / xeapi 公钥），不该跟着打包走
  'core/tmp',
  'core/KuGouMusicApi/_npmcache',
  'core/KuGouMusicApi/.github',
  'core/kuwoMusicApi/.github',
  'core/kuwoMusicApi/.vscode',
  'core/QQMusicApi/.github',
  'core/QQMusicApi/.agents',
  'core/Netease-Api/.github',
];

const SKIP_ANY = [
  /\\logs\\/i,
  /\\_npmcache\\/i,
  /[\\/]data[\\/]cookie\.json$/i,
  /bili-auth\.json$/i,
  /[\\/]platform-ports\.json$/i,
  /^Alogorithm-main[\\/]config\.json$/i,
];

function shouldSkip(rel) {
  const p = rel.split(path.sep).join('/');
  if (EXCLUDE_DIRS.some((d) => p === d || p.startsWith(d + '/'))) return true;
  if (SKIP_ANY.some((re) => re.test(rel))) return true;
  return false;
}

function copyTree(src, dst, rel = '') {
  let count = 0;
  let bytes = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return { count, bytes };
  }
  for (const e of entries) {
    const rc = rel ? path.join(rel, e.name) : e.name;
    if (shouldSkip(rc)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      const sub = copyTree(s, d, rc);
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

// ---------------------------------------------------------------- 数据清理

const REDACTIONS = [
  {
    file: 'core/kuwoMusicApi/config/config.default.ts',
    rules: [
      [/uname3=%u[0-9A-Fa-f]{4}(?:%u[0-9A-Fa-f]{4})*/g, 'uname3=<redacted>'],
      [/t3kwid=\d+/g, 't3kwid=000000000'],
      [/userid=\d+/g, 'userid=000000000'],
      [/websid=\d+/g, 'websid=000000000'],
      [/JSESSIONID=[A-Za-z0-9]+/g, 'JSESSIONID=<redacted>'],
      [/gid=[0-9a-f-]{36}/g, 'gid=<redacted>'],
      [/pic3="[^"]*"/g, 'pic3="<redacted>"'],
    ],
  },
];

function sanitizeAll(dest) {
  const notes = [];

  // config.json：房间号 / 弹幕开关 / 播放器路径
  const cfgPath = path.join(dest, 'config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const prev = cfg.danmaku ? cfg.danmaku.roomId : 0;
    if (cfg.danmaku) {
      cfg.danmaku.roomId = 0;
      cfg.danmaku.enabled = false;
    }
    if (cfg.play) cfg.play.mpvPath = '';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    notes.push('config.json：房间号 ' + prev + ' -> 0，弹幕监听 -> false');
  }

  // platform-ports.json：Cookie 全清空
  fs.writeFileSync(
    path.join(dest, 'core', 'platform-ports.json'),
    JSON.stringify(
      {
        netease: { label: '网易云音乐', port: 33011, cookie: '', loggedInUser: '' },
        qq: { label: 'QQ音乐', port: 33012, cookie: '', loggedInUser: '' },
        kugou: { label: '酷狗音乐', port: 33013, cookie: '', loggedInUser: '' },
        kuwo: { label: '酷我音乐', port: 33014, cookie: '', token: '', loggedInUser: '' },
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  notes.push('platform-ports.json：Cookie 已清空');

  // B 站登录态
  fs.writeFileSync(
    path.join(dest, 'core', 'Bullet-Screen-Capture', 'bili-auth.json'),
    JSON.stringify({ sessdata: '', biliJct: '', buvid3: '', dedeUserId: '', updatedAt: 0 }, null, 2) + '\n',
    'utf8'
  );
  notes.push('bili-auth.json：已登出');

  // 日志目录留空
  fs.mkdirSync(path.join(dest, 'core', 'Alogorithm-main', 'logs'), { recursive: true });
  notes.push('logs/：已清空');

  // 上游模板里的他人信息
  for (const { file, rules } of REDACTIONS) {
    const full = path.join(dest, file);
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
      notes.push(file + '：脱敏 ' + hits + ' 处');
    }
  }

  return notes;
}

// ---------------------------------------------------------------- 主流程

hr();
log('  打包自带前置运行时的便携版');
hr();
log('项目根  : ' + ROOT);
log('输出目录: ' + OUT_DIR);
log('Node 来源  : ' + (NODE_SRC || '（未找到）'));
log('Python 来源: ' + (PYTHON_SRC || '（未找到，将不带 Python）'));
log('');

// [1] 确认 Node 运行时可用
log('[1/6] 检查前置运行时…');
if (!NODE_SRC || !fs.existsSync(path.join(NODE_SRC, 'node.exe'))) {
  log('  ❌ 找不到 node.exe，请用 --node 指定运行时目录');
  process.exit(1);
}
const nodeExe = path.join(NODE_SRC, 'node.exe');
const ver = spawnSync(nodeExe, ['--version'], { encoding: 'utf8' }).stdout.trim();
const apiCheck = spawnSync(nodeExe, ['-e', "console.log([typeof fetch,typeof WebSocket,typeof AbortSignal.timeout].join(','))"], {
  encoding: 'utf8',
}).stdout.trim();
log('  Node 版本: ' + ver + '  @ ' + NODE_SRC);
if (apiCheck !== 'function,function,function') {
  log('  ❌ 该 Node 缺少本项目需要的 API：' + apiCheck);
  process.exit(1);
}
log('  ✓ 具备 fetch / WebSocket / AbortSignal.timeout');
if (PYTHON_SRC) {
  const pyExe = path.join(PYTHON_SRC, 'python.exe');
  const pyVer = fs.existsSync(pyExe) ? spawnSync(pyExe, ['--version'], { encoding: 'utf8' }).stdout.trim() || spawnSync(pyExe, ['--version'], { encoding: 'utf8' }).stderr.trim() : '';
  log('  ✓ Python: ' + (pyVer || '已找到') + '  @ ' + PYTHON_SRC);
} else {
  log('  ⚠ 没找到 Python 运行时，本次不带 Python（本项目运行时不依赖它）');
}

// [2] 清目录并复制
log('\n[2/6] 复制程序本体…');
if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
const t0 = Date.now();
const { count, bytes } = copyTree(ROOT, OUT_DIR);
log('  复制 ' + count + ' 个文件，' + (bytes / 1024 / 1024).toFixed(1) + ' MB，' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

// [3] 把前置运行时放进 core\
log('\n[3/6] 把前置运行时放进 core\\ …');
function putRuntime(src, name) {
  if (!src) return 0;
  const dst = path.join(OUT_DIR, 'core', name);
  if (fs.existsSync(path.join(dst, name + '.exe'))) return -1; // 已随本体复制
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  return 1;
}
const nodeCopied = putRuntime(NODE_SRC, 'node');
const pyCopied = putRuntime(PYTHON_SRC, 'python');
const dirSize = (d) => {
  let s = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) s += dirSize(p);
    else if (e.isFile()) s += fs.statSync(p).size;
  }
  return s;
};
const coreNode = path.join(OUT_DIR, 'core', 'node');
log('  core\\node   ' + (dirSize(coreNode) / 1024 / 1024).toFixed(1) + ' MB' + (nodeCopied === 1 ? '（新复制）' : nodeCopied === -1 ? '（随本体带来）' : ''));
if (PYTHON_SRC) {
  const corePy = path.join(OUT_DIR, 'core', 'python');
  log('  core\\python ' + (dirSize(corePy) / 1024 / 1024).toFixed(1) + ' MB' + (pyCopied === 1 ? '（新复制）' : pyCopied === -1 ? '（随本体带来）' : ''));
}
// 旧位置如果还在，清掉，避免两份运行时
const legacy = path.join(OUT_DIR, 'node');
if (fs.existsSync(legacy)) {
  fs.rmSync(legacy, { recursive: true, force: true });
  log('  已移除旧的 node\\ 目录（统一收到 core\\node）');
}
const legacyRt = path.join(OUT_DIR, 'runtime');
if (fs.existsSync(legacyRt)) {
  fs.rmSync(legacyRt, { recursive: true, force: true });
  log('  已移除旧的 runtime\\ 目录（统一收到 core\\）');
}

// [4] 改 bat 指向自带 Node
log('\n[4/6] 让启动脚本使用自带 Node…');
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'core', 'Alogorithm-main', 'tools', 'use-bundled-node.js'), OUT_DIR], {
    encoding: 'utf8',
  });
  out
    .trim()
    .split(/\r?\n/)
    .forEach((l) => log('  ' + l));
} catch (e) {
  log('  ❌ 打补丁失败：' + (e.stdout || e.message));
  process.exit(1);
}

// [5] 清运行数据
log('\n[5/6] 清理运行数据…');
for (const n of sanitizeAll(OUT_DIR)) log('  ' + n);

// [6] 自查 + 打 zip
log('\n[6/6] 自查并打包…');
let secretsOk = true;
try {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'core', 'Alogorithm-main', 'tools', 'check-no-secrets.js'), OUT_DIR], {
    encoding: 'utf8',
  });
  log('  隐私自查：' + (/通过/.test(out) ? '✅ 通过' : '结果见下'));
  if (/❌/.test(out)) {
    secretsOk = false;
    out.split(/\r?\n/).filter((l) => /·/.test(l)).forEach((l) => log('    ' + l.trim()));
  }
} catch (e) {
  secretsOk = false;
  log('  ❌ 隐私自查未通过：');
  String(e.stdout || '').split(/\r?\n/).filter((l) => /·/.test(l)).forEach((l) => log('    ' + l.trim()));
}

if (fs.existsSync(ZIP_PATH)) fs.rmSync(ZIP_PATH, { force: true });
log('\n  正在压缩…');
try {
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', 'Compress-Archive -Path "' + OUT_DIR + '" -DestinationPath "' + ZIP_PATH + '" -CompressionLevel Optimal -Force'],
    { stdio: 'ignore' }
  );
  const zs = fs.statSync(ZIP_PATH).size;
  log('  ✓ ' + ZIP_PATH + '  (' + (zs / 1024 / 1024).toFixed(1) + ' MB)');
} catch (e) {
  log('  ⚠ 压缩失败：' + e.message);
}

log('');
hr();
const totalSize = (function size(d) {
  let s = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) s += size(p);
    else if (e.isFile()) s += fs.statSync(p).size;
  }
  return s;
})(OUT_DIR);
log('  目录: ' + OUT_DIR + '  (' + (totalSize / 1024 / 1024).toFixed(1) + ' MB)');
log('  压缩包: ' + (fs.existsSync(ZIP_PATH) ? ZIP_PATH + '  (' + (fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(1) + ' MB)' : '未生成'));
log('  自带 Node: ' + ver + '（7 个 bat 已优先使用）');
hr();
process.exit(secretsOk ? 0 : 1);
