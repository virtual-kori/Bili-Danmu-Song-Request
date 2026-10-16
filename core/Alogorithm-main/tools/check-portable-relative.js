/**
 * 便携版「相对路径」自查。
 *
 * 便携版必须在任何目录、任何盘符下都能跑，所以包里不能出现
 * 与本机绑定的绝对路径（C:\Users\你的名字\... 之类）。
 *
 * 用法：node core\Alogorithm-main\tools\check-portable-relative.js [要检查的目录]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', '..', '..');
const HOME_PATH = process.env.USERPROFILE || '';

const results = [];
const ok = (n, p, d) => {
  results.push({ n, p });
  console.log((p ? '✅' : '❌') + ' ' + n + (d ? '  → ' + d : ''));
};

// ---------------------------------------------------------------- 1) bat 脚本

console.log('=== 1) .bat 启动脚本：只能用 %~dp0 这类相对基准 ===');
{
  const bats = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'node') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(bat|cmd)$/i.test(e.name)) bats.push(p);
    }
  })(ROOT);

  const hardCoded = [];
  const noCd = [];
  const nonAscii = [];
  for (const b of bats) {
    const buf = fs.readFileSync(b);
    const text = buf.toString('utf8');
    const rel = path.relative(ROOT, b);

    // 盘符绝对路径（如 C:\...）或 UNC 路径
    if (/[A-Za-z]:\\\\?[A-Za-z]/.test(text) || /\\\\[A-Za-z0-9._-]+\\/.test(text)) hardCoded.push(rel);
    // 每个脚本都要自己切到正确的工作目录
    if (!/cd \/d "%~dp0/.test(text)) noCd.push(rel);
    if ([...buf].some((x) => x > 0x7f)) nonAscii.push(rel);
  }
  ok('没有硬编码盘符/UNC 路径', hardCoded.length === 0, hardCoded.length ? hardCoded.join(', ') : bats.length + ' 个脚本干净');
  ok('每个脚本都自己设定工作目录（cd /d %~dp0）', noCd.length === 0, noCd.length ? noCd.join(', ') : '全部就位');
  ok('脚本均为纯 ASCII（cmd.exe 按 GBK 解析）', nonAscii.length === 0, nonAscii.length ? nonAscii.join(', ') : bats.length + ' 个');
}

// ---------------------------------------------------------------- 2) 源码

console.log('\n=== 2) 源码/配置：不能绑定本机绝对路径 ===');
{
  // 注意：本文件自己的正则里就含 "C:\Users\" 这种字样，扫描时必须跳过它，
  // 否则会自我匹配（这个坑已踩过一次）。
  const SELF = path.basename(__filename);
  const patterns = [
    /[A-Za-z]:[\\/]{1,2}Users[\\/]/i,
    /[A-Za-z]:[\\/]{1,2}Program Files/i,
  ];
  const hits = [];
  let scanned = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'node' || e.name === '.git') continue;
      // Alogorithm-main/tools 下是自检脚本，里面本来就含「用来找绝对路径」的正则样本
      // 和浏览器安装路径候选，扫它们等于自我匹配
      if (e.isDirectory() && e.name === 'tools' && path.basename(d) === 'Alogorithm-main') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(js|json|ts|md|txt|yml|yaml)$/i.test(e.name)) continue;
      if (e.name === SELF) continue; // 跳过自查脚本自身
      let text = '';
      try {
        text = fs.readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      scanned += 1;
      for (const re of patterns) {
        const m = re.exec(text);
        if (m) {
          hits.push(path.relative(ROOT, p));
          break;
        }
      }
    }
  })(ROOT);
  ok('没有本机盘符用户目录路径', hits.length === 0, hits.length ? hits.slice(0, 6).join(', ') : scanned + ' 个文件干净');
  if (HOME_PATH) {
    const homeRe = new RegExp(HOME_PATH.replace(/\\/g, '\\\\'), 'i');
    const homeHits = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'node' || e.name === '.git') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(js|json|md|txt)$/i.test(e.name)) continue;
        if (e.name === SELF) continue;
        try {
          if (homeRe.test(fs.readFileSync(p, 'utf8'))) homeHits.push(path.relative(ROOT, p));
        } catch {
          /* ignore */
        }
      }
    })(ROOT);
    ok('没有当前用户名 ' + path.basename(HOME_PATH) + ' 的绝对路径', homeHits.length === 0, homeHits.slice(0, 5).join(', ') || '干净');
  }
}

// ---------------------------------------------------------------- 3) 真的挪个地方跑

console.log('\n=== 3) 挪到完全不同的目录（含空格与中文），用相对路径启动 ===');
{
  const probe = path.join(process.env.TEMP, '便携 相对路径 测试', 'DianGeJi');
  fs.rmSync(path.dirname(probe), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(probe), { recursive: true });

  // 只复制启动必需的部分，够验证「相对路径可跑」即可
  for (const n of ['启动.bat', '停止.bat', 'config.json']) {
    const s = path.join(ROOT, n);
    if (fs.existsSync(s)) fs.cpSync(s, path.join(probe, n), { recursive: true });
  }
  fs.mkdirSync(path.join(probe, 'core'), { recursive: true });
  for (const n of ['Alogorithm-main', 'Bullet-Screen-Capture', 'Netease-Api', 'KuGouMusicApi', 'kuwoMusicApi', 'QQMusicApi', 'node', 'python']) {
    const s = path.join(ROOT, 'core', n);
    if (fs.existsSync(s)) fs.cpSync(s, path.join(probe, 'core', n), { recursive: true });
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'core'))) {
    const s = path.join(ROOT, 'core', f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(probe, 'core', f));
  }

  ok('已复制到带空格+中文的路径', fs.existsSync(path.join(probe, '启动.bat')), probe);

  // 用自带 node 起一次服务，确认路径解析不依赖当前位置
  const nodeExe = fs.existsSync(path.join(probe, 'core', 'node', 'node.exe'))
    ? path.join(probe, 'core', 'node', 'node.exe')
    : path.join(probe, 'node', 'node.exe');
  ok('前置 Node 已随目录复制', fs.existsSync(nodeExe), nodeExe);
  const r = spawnSync(nodeExe, [path.join(probe, 'core', 'Alogorithm-main', 'tools', 'check-paths.js')], {
    cwd: path.join(process.env.TEMP, '便携 相对路径 测试'), // 故意用无关的工作目录
    encoding: 'utf8',
    timeout: 180000,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const pass = /可移植性：(\d+)\/(\d+) 项通过/.exec(out);
  ok('从无关工作目录运行也能通过可移植性检查', Boolean(pass && pass[1] === pass[2]), pass ? pass[0] : out.slice(-160));

  fs.rmSync(path.dirname(probe), { recursive: true, force: true });
}

const failed = results.filter((x) => !x.p);
console.log('\n' + '='.repeat(62));
console.log('相对路径自查：' + (results.length - failed.length) + '/' + results.length + ' 项通过');
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.n).join('；'));
  process.exit(1);
}
