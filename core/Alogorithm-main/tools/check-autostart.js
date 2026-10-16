/**
 * 自动打开 Web UI + 首启无报错 自检。
 *
 * 背景（两个真实踩过的坑）：
 *   1) 网易云那套 API 启动时会往 os.tmpdir() 写 anonymous_token / xeapi_public_key，
 *      有些环境不允许写系统 temp，会抛
 *        EPERM: operation not permitted, open 'C:\...\Temp\xeapi_public_key'
 *      现在把临时目录指到项目内的 core/tmp，这段错不再出现。
 *   2) 上游 generateConfig 是「先注册匿名 token、后取 xeapi 公钥」的顺序，
 *      而 request.js 在模块加载时就把公钥缓存成 null，首启必然抛
 *      "xeapi public key is missing"（无害但吓人）。现在首启也不再刷这段。
 *
 * 用法：node core\Alogorithm-main\tools\check-autostart.js
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const results = [];
const ok = (n, p, d) => {
  results.push({ n, p });
  console.log((p ? '✅ ' : '❌ ') + n + (d ? '  → ' + d : ''));
};

console.log('=== 1) 自动打开浏览器：代码层面 ===');
{
  const server = fs.readFileSync(path.join(ROOT, 'core', 'Alogorithm-main', 'server.js'), 'utf8');
  ok('存在 openBrowser 实现', /function openBrowser\(/.test(server), '');
  ok(
    '有多种兜底方式（start / explorer / rundll32）',
    /cmd/.test(server) && /explorer\.exe/.test(server) && /rundll32/.test(server),
    ''
  );
  ok('启动流程里调用了它', /openBrowser\(\s*url\s*\)/.test(server), '');
  ok('关掉时不会调用', /config\.server\.openBrowser !== false/.test(server), '开关读的是 server.openBrowser');

  // 顺序最关键：必须等弹幕接入、并且打完「启动完成」之后才开浏览器，
  // 否则用户打开页面时平台/弹幕还没就绪，看到的是「正在启动」。
  const iDanmaku = server.indexOf('await attachDanmaku()');
  const iDone = server.indexOf('=== 启动完成，等待点歌 ===');
  const iOpen = server.indexOf('openBrowser(url)');
  ok(
    '弹幕接入在开浏览器之前（且已 await）',
    iDanmaku > 0 && iOpen > 0 && iDanmaku < iOpen,
    iDanmaku > 0 ? 'attachDanmaku 早于 openBrowser' : '未找到 await attachDanmaku()'
  );
  ok(
    '「启动完成」在开浏览器之前',
    iDone > 0 && iOpen > 0 && iDone < iOpen,
    iDone > 0 ? '启动完成 → 才开浏览器' : '未找到启动完成日志'
  );
  ok('开浏览器放在定时器里（让首屏 WebSocket 先连上）', /setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,220}openBrowser\(url\)/.test(server), '');

  // 配置默认值
  const cfgMod = fs.readFileSync(path.join(ROOT, 'core', 'Alogorithm-main', 'core', 'config.js'), 'utf8');
  ok('配置默认值 openBrowser=true', /openBrowser:\s*true/.test(cfgMod), '');
}

console.log('\n=== 2) 网易云首启不再刷错：代码层面 ===');
{
  const serve = fs.readFileSync(path.join(ROOT, 'core', 'Netease-Api', 'serve.js'), 'utf8');
  ok('临时目录指到项目内 core/tmp', /LOCAL_TMP/.test(serve) && /process\.env\.TMP\s*=\s*LOCAL_TMP/.test(serve), '');
  ok(
    '临时目录在加载 api 包之前就设好（避免 request.js 缓存错路径）',
    serve.indexOf('prepareTmpDir()') < serve.indexOf('pkgDir()'),
    ''
  );
  ok('会预取 xeapi 公钥', /ensureXeapiKey/.test(serve), '');
  ok('过滤了首启那句已知无害报错', /xeapi public key is missing/i.test(serve) && /withQuietXeapiError/.test(serve), '');
}

console.log('\n=== 3) 临时目录确实可写且落在项目内 ===');
{
  const localTmp = path.join(ROOT, 'core', 'tmp');
  fs.mkdirSync(localTmp, { recursive: true });
  let writable = false;
  try {
    const probe = path.join(localTmp, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    writable = true;
  } catch {
    writable = false;
  }
  ok('core\\tmp 存在且可写', writable, localTmp.replace(ROOT, ''));

  // 跑一次真实启动，检查输出里没有那两句错
  const out = spawnSync(process.execPath, [path.join(ROOT, 'core', 'Alogorithm-main', 'tools', 'stop-all.js')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  void out;
  const logDir = path.join(ROOT, 'core', 'Alogorithm-main', 'logs');
  const files = fs.existsSync(logDir)
    ? fs
        .readdirSync(logDir)
        .filter((f) => /^diankeji-.*\.log$/.test(f))
        .sort()
    : [];
  if (files.length) {
    const text = fs.readFileSync(path.join(logDir, files[files.length - 1]), 'utf8');
    const eperm = /EPERM: operation not permitted, open[^\n]*xeapi_public_key/.test(text);
    ok('最近的日志里没有 EPERM', !eperm, eperm ? '仍有 EPERM' : '干净');
  } else {
    console.log('   （暂无日志文件，跳过日志扫描）');
  }
}

console.log('\n=== 4) 服务能起来并仍在监听 ===');
{
  let alive = false;
  try {
    const r = spawnSync(
      process.execPath,
      ['-e', "fetch('http://127.0.0.1:33000/style.css').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
      { encoding: 'utf8', timeout: 8000 }
    );
    alive = r.status === 0;
  } catch {
    alive = false;
  }
  if (alive) {
    ok('Web UI 正在监听 33000', true, 'http://127.0.0.1:33000');
  } else {
    console.log('   （主服务未运行，跳过——本项需要 check-all 先启动服务）');
  }
}

const failed = results.filter((r) => !r.p);
console.log('\n===== 自动启动自检：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
if (failed.length) {
  console.log('失败项：' + failed.map((f) => f.n).join('；'));
  process.exit(1);
}
