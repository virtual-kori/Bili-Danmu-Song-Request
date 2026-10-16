/**
 * 验证「自带 Node 优先」是否真的生效。
 *
 * 做法：给项目造一个「探针」，让 node.exe 把自己的路径写进文件，
 * 然后真的用 启动.bat / 停止.bat 跑一遍，看写出来的是哪个 node。
 *
 * 用法：node core\Alogorithm-main\tools\check-bundled-node.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const REAL_NODE = process.execPath;
const TMP = path.join(process.env.TEMP || ROOT, 'dgj-bundled-node-test');

const results = [];
const ok = (n, p, d) => {
  results.push({ n, p });
  console.log((p ? '✅' : '❌') + ' ' + n + (d ? '  → ' + d : ''));
};
const line = () => console.log('-'.repeat(62));

/**
 * 在项目根建一个自包含测试目录：
 *   node\node.exe        —— 探针（或真实 node.exe 的替身）
 *   probe.js             —— 把 process.execPath 写进 out.txt
 *   run.bat              —— 应用同款探测逻辑后调用探针
 */
function makeSandbox(name) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'node'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'core', 'node'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'probe.js'),
    "require('fs').writeFileSync(require('path').join(__dirname,'out.txt'), process.execPath, 'utf8');\n",
    'utf8'
  );
  return dir;
}

/** 写一个 run.bat：内容与项目里的探测块一致，但调用探针脚本 */
function writeRunBat(dir) {
  const bat = [
    '@echo off',
    'cd /d "%~dp0"',
    '',
    'rem --- BUNDLED_NODE_DETECT ---',
    'set "NODE_BIN="',
    'set "NODE_SRC="',
    'if exist "core\\node\\node.exe" set "NODE_BIN=core\\node\\node.exe"',
    'if not defined NODE_BIN if exist "node\\node.exe" set "NODE_BIN=node\\node.exe"',
    'if defined NODE_BIN set "NODE_SRC=bundled"',
    'if not defined NODE_BIN (',
    '  where node >nul 2>nul',
    '  if not errorlevel 1 (',
    '    set "NODE_BIN=node"',
    '    set "NODE_SRC=system"',
    '  )',
    ')',
    'if not defined NODE_BIN goto NONODE',
    '"%NODE_BIN%" "probe.js"',
    'echo SOURCE=%NODE_SRC% > src.txt',
    'exit /b 0',
    '',
    ':NONODE',
    'echo NO_NODE > nonode.txt',
    'exit /b 1',
  ].join('\r\n');
  fs.writeFileSync(path.join(dir, 'run.bat'), bat, 'utf8');
}

function runBat(dir) {
  spawnSync('cmd.exe', ['/c', 'run.bat'], { cwd: dir, stdio: 'ignore' });
  const out = path.join(dir, 'out.txt');
  const src = path.join(dir, 'src.txt');
  const nonode = path.join(dir, 'nonode.txt');
  return {
    execPath: fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim() : '',
    source: fs.existsSync(src) ? fs.readFileSync(src, 'utf8').trim() : '',
    noNode: fs.existsSync(nonode),
  };
}

// ---------------------------------------------------------------- 开始

console.log('项目根：' + ROOT);
console.log('系统 node：' + REAL_NODE);
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

console.log('\n【1】自带 node 存在时，必须优先用自带的');
{
  const dir = makeSandbox('both');
  // 用真实 node.exe 当「自带运行时」，这样探针能真的执行
  fs.copyFileSync(REAL_NODE, path.join(dir, 'core', 'node', 'node.exe'));
  writeRunBat(dir);
  const r = runBat(dir);
  ok('选中了自带 node', r.source.includes('bundled'), r.source || '（无输出）');
  ok('实际执行的是 core\\node\\node.exe', /core\\node\\node\.exe$/i.test(r.execPath), r.execPath);
}

console.log('\n【1b】只有旧位置 node\\node.exe 时，也要能找到');
{
  const dir = makeSandbox('legacy');
  fs.copyFileSync(REAL_NODE, path.join(dir, 'node', 'node.exe'));
  writeRunBat(dir);
  const r = runBat(dir);
  ok('兼容旧的 node\\node.exe', r.source.includes('bundled') && /\\node\\node\.exe$/i.test(r.execPath), r.execPath);
}

console.log('\n【2】自带 node 缺失时，回退到系统 node');
{
  const dir = makeSandbox('system-only');
  writeRunBat(dir);
  const r = runBat(dir);
  ok('回退到系统 node', r.source.includes('system'), r.source || '（无输出）');
  ok('确实跑起来了', r.execPath.length > 0, r.execPath);
}

console.log('\n【3】两者都没有时，给出错误而不是静默失败');
{
  const dir = path.join(TMP, 'none');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writeRunBat(dir);
  // 清空 PATH，模拟没装 node 的电脑
  const bat = fs.readFileSync(path.join(dir, 'run.bat'), 'utf8').replace('cd /d "%~dp0"', 'cd /d "%~dp0"\r\nset "PATH=C:\\Windows\\System32"');
  fs.writeFileSync(path.join(dir, 'run.bat'), bat, 'utf8');
  const r = runBat(dir);
  ok('没有 node 时走 NONODE 分支', r.noNode === true, r.noNode ? 'NONODE' : '未触发（execPath=' + r.execPath + '）');
}

console.log('\n【4】项目里 7 个 bat 都改成了自带 Node 模式');
{
  const bats = ['启动.bat', '停止.bat', 'core\\登录.bat', 'core\\登录网易云.bat', 'core\\登录QQ音乐.bat', 'core\\登录酷狗.bat', 'core\\登录酷我.bat'];
  let good = 0;
  for (const b of bats) {
    const f = path.join(ROOT, b);
    if (!fs.existsSync(f)) continue;
    const t = fs.readFileSync(f, 'utf8');
    const hasDetect = t.includes('BUNDLED_NODE_DETECT') && /node\\node\.exe/.test(t);
    const usesVar = /"%NODE_BIN%"/.test(t);
    const ascii = ![...fs.readFileSync(f)].some((x) => x > 0x7f);
    if (hasDetect && usesVar && ascii) good += 1;
    else console.log('     · ' + b + '  探测=' + hasDetect + ' 用变量=' + usesVar + ' 纯ASCII=' + ascii);
  }
  ok('7 个 bat 全部就绪', good === bats.length, good + '/' + bats.length);
}

console.log('\n【5】项目里确实带了前置运行时');
{
  const candidates = [
    ['core\\node\\node.exe（标准位置）', path.join(ROOT, 'core', 'node', 'node.exe')],
    ['node\\node.exe（旧位置）', path.join(ROOT, 'node', 'node.exe')],
  ];
  const found = candidates.find(([, p]) => fs.existsSync(p));
  ok('找到 Node 运行时', Boolean(found), found ? found[0] + '  ' + (fs.statSync(found[1]).size / 1024 / 1024).toFixed(1) + ' MB' : '缺失');
  if (found) {
    const exe = found[1];
    let ver = '';
    try {
      ver = spawnSync(exe, ['--version'], { encoding: 'utf8' }).stdout.trim();
    } catch {
      /* ignore */
    }
    ok('自带 node 可执行', /^v\d+\./.test(ver), ver);
    let api = '';
    try {
      api = spawnSync(exe, ['-e', "console.log([typeof fetch,typeof WebSocket,typeof AbortSignal.timeout].join(','))"], { encoding: 'utf8' }).stdout.trim();
    } catch {
      /* ignore */
    }
    ok('自带 node 具备所需 API', api === 'function,function,function', api);
    const npmCli = path.join(path.dirname(exe), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    ok('附带 npm（可用于排障）', fs.existsSync(npmCli), fs.existsSync(npmCli) ? '' : '无');
  }
  const py = path.join(ROOT, 'core', 'python', 'python.exe');
  if (fs.existsSync(py)) {
    const pv = spawnSync(py, ['--version'], { encoding: 'utf8' });
    ok('core\\python 可用', /Python 3/.test((pv.stdout || '') + (pv.stderr || '')), ((pv.stdout || '') + (pv.stderr || '')).trim());
  } else {
    console.log('   （未带 Python 运行时，跳过）');
  }
}

const failed = results.filter((r) => !r.p);
console.log('\n' + '='.repeat(62));
console.log('自带 Node 验证：' + (results.length - failed.length) + '/' + results.length + ' 项通过');
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.n).join('；'));
  process.exit(1);
}
fs.rmSync(TMP, { recursive: true, force: true });
