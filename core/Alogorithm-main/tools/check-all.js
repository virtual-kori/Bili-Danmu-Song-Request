// 总验收：目录结构 / 一键启动 / 登录中心 / 弹幕捕捉 / 功能自检 / 一键停止
// 用法：先双击 启动.bat（本脚本会自己启动与停止），然后
//       node core\Alogorithm-main\tools\check-all.js
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync, spawn } = require('child_process');

const dir = path.resolve(__dirname, '..', '..', '..');
const TOOLS = __dirname;
const PORTS = [33000, 33011, 33012, 33013, 33014];
const BASE = 'http://127.0.0.1:33000';
const results = [];
const ok = (n, p, d) => {
  results.push({ n, p });
  console.log((p ? '✅' : '❌') + ' ' + n + (d ? '  → ' + d : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listening() {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, maxBuffer: 1e7 });
    const map = {};
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const m = line.trim().match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if (m && PORTS.includes(Number(m[1]))) map[m[1]] = m[2];
    }
    return map;
  } catch {
    return {};
  }
}
function killPorts() {
  for (const pid of Object.values(listening())) {
    try { execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
}
function runBat(file, ms) {
  const r = spawnSync('cmd.exe', ['/d', '/c', path.join(dir, file)], {
    cwd: dir, encoding: 'buffer', windowsHide: true, timeout: ms, input: '',
  });
  return { status: r.status, signal: r.signal, stderr: r.stderr ? new TextDecoder('gbk').decode(r.stderr) : '' };
}
function runTest(rel, args = []) {
  const r = spawnSync('node', [path.join(TOOLS, rel), ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 400000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const sums = out.match(/=====[^=]*=====/g) || [];
  const bad = out.match(/^❌.*$/gm) || [];
  return { failed: bad.length, summary: sums.length ? sums[sums.length - 1].replace(/=/g, '').trim() : '(无汇总)', bad, out };
}
async function waitPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listening()['33000']) return true;
    await sleep(500);
  }
  return false;
}
/** 等四个平台 API 全部起来（酷狗要注册设备指纹，可能比其它平台慢十几秒） */
async function waitPlatforms(timeoutMs) {
  const want = ['33011', '33012', '33013', '33014'];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = listening();
    if (want.every((k) => p[k])) return p;
    await sleep(700);
  }
  return listening();
}
async function api(pathname, method = 'GET', body) {
  try {
    const res = await fetch(BASE + pathname, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

/** 从一批大房间里挑一个正在开播的，用于验证弹幕真的能收到 */
async function pickLiveRoom() {
  for (const id of [21452505, 5050, 6, 5440, 3]) {
    try {
      const res = await fetch('https://api.live.bilibili.com/room/v1/Room/room_init?id=' + id, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://live.bilibili.com/' },
      });
      const j = await res.json();
      if (j.code === 0 && j.data && j.data.live_status === 1) return j.data.room_id;
    } catch {
      /* 换下一个 */
    }
    await sleep(400);
  }
  return 0;
}

(async () => {
  console.log('【1】目录结构');
  // 根目录只留「启动/停止 + config.json + core」，登录脚本统一收在 core/ 里。
  // node/ 与 runtime/ 是旧版运行时位置（仍兼容）；标准位置已改到 core/node 与 core/python。
  const root = fs.readdirSync(dir).filter((n) => !/^_/.test(n) && n !== 'node' && n !== 'runtime').sort();
  const wantRoot = ['config.json', 'core', '停止.bat', '启动.bat'].sort();
  ok('根目录 = 启动/停止 bat + config.json + core', JSON.stringify(root) === JSON.stringify(wantRoot), root.join(' , '));
  // 前置运行时（统一放 core/ 里）
  for (const [label, rel, arg] of [
    ['自带 Node 运行时可用', 'core\\node\\node.exe', '--version'],
    ['自带 Python 运行时可用', 'core\\python\\python.exe', '--version'],
  ]) {
    const exe = path.join(dir, rel);
    if (!fs.existsSync(exe)) continue;
    const r = require('child_process').spawnSync(exe, [arg], { encoding: 'utf8' });
    const out = ((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/)[0] || '';
    ok(label, /^(v\d+\.|Python 3)/.test(out), out);
  }

  const coreDir = path.join(dir, 'core');
  const coreBats = fs.readdirSync(coreDir).filter((n) => n.endsWith('.bat')).sort();
  const wantCoreBats = ['登录.bat', '登录QQ音乐.bat', '登录网易云.bat', '登录酷我.bat', '登录酷狗.bat'].sort();
  ok('登录脚本都在 core/ 里', JSON.stringify(coreBats) === JSON.stringify(wantCoreBats), coreBats.join(' , '));

  // 所有 bat 必须纯 ASCII，且用相对路径（能整体挪动）
  const allBats = root.filter((n) => n.endsWith('.bat')).map((n) => path.join(dir, n))
    .concat(coreBats.map((n) => path.join(coreDir, n)));
  let nonAscii = 0;
  const absPathBats = [];
  const badCd = [];
  for (const p of allBats) {
    const buf = fs.readFileSync(p);
    nonAscii += [...buf].filter((x) => x > 0x7f).length;
    const text = buf.toString('utf8');
    if (/[A-Za-z]:\\/.test(text)) absPathBats.push(path.basename(p));
    const inRoot = path.dirname(p) === dir;
    const okCd = inRoot ? /cd \/d "%~dp0"/.test(text) : /cd \/d "%~dp0\.\."/.test(text);
    if (!okCd) badCd.push(path.basename(p));
  }
  ok('所有 bat 均为纯 ASCII（不会再触发编码问题）', nonAscii === 0, allBats.length + ' 个脚本，非 ASCII 字节 ' + nonAscii);
  ok('所有 bat 都用相对路径（无盘符硬编码）', absPathBats.length === 0, absPathBats.join(', ') || '干净');
  ok('所有 bat 都正确切换工作目录', badCd.length === 0, badCd.join(', ') || '根目录用 %~dp0，core 内用 %~dp0..');

  // 源码级可移植性（绝对路径 / __dirname 推导）
  const paths = runTest('check-paths.js');
  ok('源码可移植性（无绝对路径 + 路径由 __dirname 推导）', paths.failed === 0, paths.summary);

  console.log('\n【2】一键启动');
  killPorts();
  const child = spawn('cmd.exe', ['/d', '/c', path.join(dir, '启动.bat')], { cwd: dir, windowsHide: true, stdio: 'ignore' });
  const up = await waitPort(30000);
  ok('启动.bat 成功拉起服务', up, up ? '33000 已监听' : '30 秒内未监听');
  const ports = await waitPlatforms(45000);
  ok(
    '四平台 API 端口全部监听',
    ['33011', '33012', '33013', '33014'].every((p) => ports[p]),
    JSON.stringify(ports)
  );

  console.log('\n【3】账号登录中心');
  const acc = await api('/api/accounts');
  const list = acc.data ? [acc.data.bilibili].concat(acc.data.platforms || []) : [];
  ok('账号接口返回 B 站 + 四平台', list.length === 5, list.map((a) => a.key).join(', '));
  const structOk = list.every((a) => {
    if (a.key === 'bilibili') return typeof a.loggedIn === 'boolean' && typeof a.note === 'string' && a.note.length > 0;
    return (
      typeof a.loggedIn === 'boolean' &&
      typeof a.online === 'boolean' &&
      typeof a.playable === 'boolean' &&
      typeof a.note === 'string' &&
      a.note.length > 0
    );
  });
  ok('每个账号都有登录态与可用性字段', structOk, list.map((a) => a.key + '=' + (a.loginDisabled ? '无需登录' : a.loggedIn ? '已登录' : '未登录')).join(' '));
  const kuwo = (acc.data.platforms || []).find((p) => p.key === 'kuwo') || {};
  const qq = (acc.data.platforms || []).find((p) => p.key === 'qq') || {};
  const qwx = await api('/api/login/qq/qr?kind=wx', 'POST', {});
  ok('酷我已开启登录（Cookie / 微信扫码）', kuwo.loginDisabled !== true && kuwo.qr === true, kuwo.note || '');
  ok('酷我标记为微信扫码', kuwo.qrKind === 'wechat', 'qrKind=' + kuwo.qrKind);
  ok('QQ 音乐已开启扫码（微信优先）', qq.qr === true && qq.qrKind === 'wechat', 'qr=' + qq.qr + ' kind=' + qq.qrKind);
  ok('QQ 微信扫码能出二维码', qwx.ok === true && String((qwx.data || {}).base64 || '').length > 500, '图片 ' + String((qwx.data || {}).base64 || '').length + ' 字符');
  for (const key of ['netease', 'kugou']) {
    const q = await api('/api/login/' + key + '/qr', 'POST', {});
    const qd = q.data || {};
    const chk = await api('/api/login/' + key + '/qr-check?key=' + encodeURIComponent(qd.key || ''));
    const cd = chk.data || {};
    ok(
      key + ' 扫码：能出二维码且状态正确',
      q.ok === true && String(qd.base64 || '').length > 500 && cd.loggedIn === false,
      '图片 ' + String(qd.base64 || '').length + ' 字符，状态「' + (cd.message || '?') + '」'
    );
  }
  const bq = await api('/api/bili/qr', 'POST', {});
  ok('B 站扫码：能出二维码', bq.ok === true && String((bq.data || {}).base64 || '').length > 500, '图片 ' + String((bq.data || {}).base64 || '').length + ' 字符');

  console.log('\n【3b】酷我微信扫码登录');
  const kq = await api('/api/login/kuwo/qr', 'POST', {});
  const kd = kq.data || {};
  ok('酷我能出微信二维码', kq.ok === true && String(kd.base64 || '').length > 500, 'kind=' + kd.qrKind + '，图片 ' + String(kd.base64 || '').length + ' 字符');
  ok('酷我二维码是微信来源（JPEG dataURL）', String(kd.base64 || '').startsWith('data:image/jpeg;base64,'), String(kd.base64 || '').slice(0, 30));
  const kchk = await api('/api/login/kuwo/qr-check?key=deadbeef');
  ok('酷我轮询对无效会话容错', Boolean((kchk.data || {}).message), (kchk.data || {}).message);

  console.log('\n【4】弹幕捕捉');
  const dcheck = runTest('check-danmaku.js', ['1017', '1']);
  ok('WBI 签名算法自检通过', /ea1db124af3c7062474693fa704f4ff8/.test(dcheck.out), '命中官方测试向量');
  ok('房间号解析（room_init）可用', /room_init 解析真实房间号/.test(dcheck.out), '');
  ok('弹幕服务器接口可用（getConf 优先，getDanmuInfo 兜底）', /取到弹幕服务器 token 与节点/.test(dcheck.out), (dcheck.out.match(/来源=(\w+)/) || [])[1] ? '来源=' + (dcheck.out.match(/来源=(\w+)/) || [])[1] : '');

  const liveRoom = await pickLiveRoom();
  if (liveRoom) {
    console.log('   找到开播中的房间 ' + liveRoom + '，实测收弹幕…');
    const live = runTest('check-danmaku-live.js', [String(liveRoom)]);
    ok('实测能收到直播弹幕（完整链路）', live.failed === 0, live.summary);
  } else {
    console.log('   ⚠ 当前没有开播中的测试房间，跳过实时收包验证（功能不受影响）');
  }

  console.log('\n【5】功能自检');
  let pf = runTest('check-platforms.js');
  if (pf.failed > 0) {
    console.log('   第一次有失败项，10 秒后重试… ' + pf.bad.join(' | ').slice(0, 80));
    await sleep(10000);
    pf = runTest('check-platforms.js');
  }
  ok('四平台（搜索 + 可播放直链）', pf.failed === 0, pf.summary + (pf.failed ? '（' + pf.bad.join(' | ').slice(0, 100) + '）' : ''));
  for (const [label, rel] of [
    ['端到端（队列/置顶/切歌/暂停/MPV 回收/开关）', 'self-test.js'],
    ['弹幕点歌链路（解析/黑名单/冷却/匹配/回复）', 'check-danmaku-flow.js'],
    ['Web UI（页面元素/静态资源/登录中心接口）', 'check-webui.js'],
    ['登录链路（Cookie 提取位置 / 状态准确性 / Cookie 校验）', 'check-login-flow.js'],
    ['QQ 音乐双扫码（微信可用 / QQ 受限提示）', 'check-qq-login.js'],
    ['自带 Node（优先自带 / 回退系统 / 缺失报错）', 'check-bundled-node.js'],
    ['相对路径（换目录 / 含空格中文 / 无关工作目录）', 'check-portable-relative.js'],
    ['小窗 UI（320-1440px 无重叠 / 无溢出 / 无越界）', 'check-ui-small.js'],
    ['OBS 歌词短链接（默认样式 / 参数覆盖 / 旧链接兼容）', 'check-obs-lytric.js'],
    ['自动启动（开浏览器 / 首启无 EPERM 与 xeapi 报错）', 'check-autostart.js'],
  ]) {
    const r = runTest(rel);
    ok(label, r.failed === 0, r.summary + (r.failed ? '（' + r.bad.join(' | ').slice(0, 100) + '）' : ''));
  }

  // 空闲选曲要真的跑一会儿（等它补歌/切歌），放最后单独跑。
  //
  // 注意：前面几项会反复拉起无头浏览器，本机负载高时四个平台子进程偶尔会
  // 冒一次 "fetch failed"（实测单独跑稳定 16/16）。这里失败就等一会儿重试一次，
  // 避免把「机器忙」误报成功能故障。
  let idle = runTest('check-idle-pick.js');
  if (idle.failed > 0) {
    console.log('   空闲选曲有失败项，等 8 秒重试一次… ' + idle.bad.join(' | ').slice(0, 80));
    await sleep(8000);
    idle = runTest('check-idle-pick.js');
  }
  ok('空闲选曲（榜单 / 开播即出队 / 跳过最近播放）', idle.failed === 0, idle.summary + (idle.failed ? '（' + idle.bad.join(' | ').slice(0, 100) + '）' : ''));

  console.log('\n【6】一键停止');
  try { child.kill(); } catch {}
  const t = runBat('停止.bat', 90000);
  ok('停止.bat 正常结束', t.status === 0, 'exit=' + t.status);
  ok('停止后所有端口已释放', Object.keys(listening()).length === 0, JSON.stringify(listening()));
  let mpv = 0;
  try {
    const tl = execFileSync('tasklist', ['/FI', 'IMAGENAME eq mpv.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
    mpv = (tl.match(/mpv\.exe/gi) || []).length;
  } catch { mpv = 0; }
  ok('无 mpv 残留', mpv === 0, 'mpv 进程数=' + mpv);

  const failed = results.filter((r) => !r.p);
  console.log('\n===== 最终总验收：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.n).join('；'));
    process.exit(1);
  }
})().catch((e) => {
  console.error('验收异常：' + (e.stack || e.message));
  process.exit(1);
});
