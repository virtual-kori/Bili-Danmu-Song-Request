/**
 * 可移植性自检：确认整个文件夹可以随便挪动。
 *
 * 检查三件事：
 *   1. 源码（排除 node_modules）里有没有硬编码的绝对路径；
 *   2. 关键路径是否都由 __dirname 推导出来，而不是依赖当前工作目录；
 *   3. 所有 .bat 是否用相对路径、是否正确切换工作目录、是否纯 ASCII。
 *
 * 用法：node core\Alogorithm-main\tools\check-paths.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.bat', '.cmd', '.md', '.txt']);
// 只找「像是本机绝对路径」的写法，避免误报注释里的示例
const ABS_RE = /(?:^|[^A-Za-z0-9_])([A-Za-z]:[\\/](?:Users|Program|Windows|Temp|tmp)[^\s"'`;,)]*)/g;

const results = [];
const ok = (name, pass, detail) => {
  results.push({ name, pass });
  console.log((pass ? '✅' : '❌') + ' ' + name + (detail ? '  → ' + detail : ''));
};

// ---------------------------------------------------------------- 1) 绝对路径扫描
const hits = [];
let scanned = 0;
(function walk(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    // 第三方依赖与前置运行时都不扫：
    //   node_modules  第三方依赖
    //   node/python   前置运行时（二进制 + 官方附带脚本）
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'node' || e.name === 'python') continue;
    // Alogorithm-main/tools 下是自检脚本：它们内部含有「用于查找绝对路径」的正则样本，
    // 扫它们等于自我匹配，所以整目录跳过。
    if (e.isDirectory() && e.name === 'tools' && path.basename(dir) === 'Alogorithm-main') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
      continue;
    }
    if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
    scanned += 1;
    let text = '';
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((line, i) => {
      ABS_RE.lastIndex = 0;
      const m = ABS_RE.exec(line);
      if (m) hits.push({ file: path.relative(ROOT, p), line: i + 1, text: m[1].slice(0, 80) });
    });
  }
})(ROOT);

console.log('【1】源码绝对路径扫描（' + scanned + ' 个文本文件，已排除 node_modules）');
ok('没有硬编码的绝对路径', hits.length === 0, hits.length ? hits.slice(0, 5).map((h) => h.file + ':' + h.line).join(' , ') : '干净');

// ---------------------------------------------------------------- 2) __dirname 推导
console.log('\n【2】关键路径是否由 __dirname 推导（与当前工作目录无关）');
// login.js 自己不算路径，全部委托给 qr-util 的 CORE_DIR/ROOT_DIR，所以两者取其一即可
const files = [
  'core/Alogorithm-main/core/config.js',
  'core/Alogorithm-main/core/mpv.js',
  'core/Alogorithm-main/core/platforms.js',
  'core/Alogorithm-main/core/logger.js',
  'core/Alogorithm-main/server.js',
  'core/Alogorithm-main/tools/qr-util.js',
  'core/Bullet-Screen-Capture/auth.js',
  'core/kuwoMusicApi/live/server.js',
];
for (const rel of files) {
  let pass = false;
  try {
    pass = /__dirname/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch {
    /* 文件缺失 */
  }
  ok(rel, pass, pass ? '' : '未用 __dirname');
}

// login.js 本身不拼路径，但要确认它确实是从 qr-util 拿的
{
  const rel = 'core/Alogorithm-main/tools/login.js';
  let pass = false;
  try {
    const t = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    pass = /qrUtil\.CORE_DIR/.test(t) && !/['"][A-Za-z]:\\/.test(t);
  } catch {
    /* 文件缺失 */
  }
  ok(rel + '（路径委托给 qr-util.CORE_DIR）', pass, pass ? '' : '没有从 qr-util 取根目录');
}

// ---------------------------------------------------------------- 3) bat 检查
console.log('\n【3】启动脚本');
const rootBats = fs.readdirSync(ROOT).filter((n) => n.endsWith('.bat'));
const coreDir = path.join(ROOT, 'core');
const coreBats = fs.existsSync(coreDir) ? fs.readdirSync(coreDir).filter((n) => n.endsWith('.bat')) : [];
const bats = rootBats.map((n) => [path.join(ROOT, n), true]).concat(coreBats.map((n) => [path.join(coreDir, n), false]));

const wantRootBats = ['停止.bat', '启动.bat', '重置.bat'].sort();
ok('根目录只有启动/停止/重置三个 bat', JSON.stringify(rootBats.sort()) === JSON.stringify(wantRootBats), rootBats.join(' , '));

const wantCoreBats = ['登录.bat', '登录QQ音乐.bat', '登录网易云.bat', '登录酷我.bat', '登录酷狗.bat'].sort();
ok('登录脚本都在 core/ 里', JSON.stringify(coreBats.sort()) === JSON.stringify(wantCoreBats), coreBats.join(' , '));

let nonAscii = 0;
const badPath = [];
const badCd = [];
for (const [p, inRoot] of bats) {
  const buf = fs.readFileSync(p);
  nonAscii += [...buf].filter((b) => b > 0x7f).length;
  const text = buf.toString('utf8');
  if (/[A-Za-z]:\\/.test(text)) badPath.push(path.basename(p));
  const okCd = inRoot ? /cd \/d "%~dp0"/.test(text) : /cd \/d "%~dp0\.\."/.test(text);
  if (!okCd) badCd.push(path.basename(p));
}
ok('所有 bat 都是纯 ASCII', nonAscii === 0, bats.length + ' 个脚本，非 ASCII 字节 ' + nonAscii);
ok('所有 bat 都没有盘符硬编码', badPath.length === 0, badPath.join(', ') || '干净');
ok('所有 bat 都正确切换工作目录', badCd.length === 0, badCd.join(', ') || '根目录用 %~dp0，core 内用 %~dp0..');

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.pass);
console.log('\n===== 可移植性：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.name).join('；'));
  process.exit(1);
}
