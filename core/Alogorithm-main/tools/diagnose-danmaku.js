/**
 * 弹幕抓不到时的现场诊断。
 *
 * 会在**当前这份目录**上依次检查：
 *   1) 这份副本里的弹幕代码是不是修好的版本（uid 必须固定发 0）
 *   2) 直播间是否真的在播、人气多少
 *   3) 弹幕服务器信息能不能取到、token 有没有
 *   4) 真连一次，看 30 秒内收到多少条
 *
 * 用法（在点歌机目录里）：
 *   node core\Alogorithm-main\tools\diagnose-danmaku.js [房间号]
 *
 * 房间号不填就用 config.json 里配置的那个。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CAP = path.join(ROOT, 'core', 'Bullet-Screen-Capture');
const CFG = path.join(ROOT, 'config.json');

const hr = () => console.log('-'.repeat(62));
const results = [];

function readCfgRoom() {
  try {
    const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    return { roomId: Number((c.danmaku && c.danmaku.roomId) || 0), enabled: Boolean(c.danmaku && c.danmaku.enabled) };
  } catch {
    return { roomId: 0, enabled: false };
  }
}

(async () => {
  console.log('='.repeat(62));
  console.log('  弹幕抓取诊断');
  console.log('='.repeat(62));
  console.log('目录：' + ROOT);
  hr();

  // ---------------- 1) 代码版本 ----------------
  console.log('【1】这份副本的弹幕代码是不是修好的版本');
  const livePath = path.join(CAP, 'live.js');
  if (!fs.existsSync(livePath)) {
    console.log('  ❌ 找不到 ' + livePath);
    process.exit(1);
  }
  const live = fs.readFileSync(livePath, 'utf8');
  const hasBank = /uid:\s*0,/.test(live);
  const usesSelfUid = /auth\.loggedIn\s*&&\s*this\.auth\.selfUid/.test(live);
  console.log('  live.js 修改时间：' + fs.statSync(livePath).mtime.toLocaleString('zh-CN'));
  console.log('  鉴权 uid 固定发 0：' + (hasBank ? '✅ 是' : '❌ 否'));
  console.log('  还在用登录 uid 鉴权：' + (usesSelfUid ? '❌ 是（这就是收不到弹幕的原因）' : '✅ 否'));
  const codeOk = hasBank && !usesSelfUid;
  results.push({ n: '代码是修好的版本', p: codeOk });
  if (!codeOk) {
    console.log('');
    console.log('  ⚠ 这份副本是**旧版**：它会把你的登录 uid 填进鉴权包，');
    console.log('    网易云/哔哩哔哩会因为「uid 与 token 身份不匹配」直接掐断连接 ——');
    console.log('    表现为「已连接、弹幕认证成功，但一条弹幕都收不到」。');
    console.log('    解决：换用最新的发行包（live.js 里应含「固定发 0」注释）。');
  }
  hr();

  // ---------------- 2) 房间状态 ----------------
  const cfg = readCfgRoom();
  const roomArg = Number(process.argv[2] || 0);
  const room = roomArg || cfg.roomId;
  console.log('【2】直播间状态');
  if (!room) {
    console.log('  ⚠ 没有房间号（命令行和 config.json 都没有）');
    console.log('    config.json 里 danmaku.roomId = ' + cfg.roomId + '，danmaku.enabled = ' + cfg.enabled);
    process.exit(1);
  }
  console.log('  使用的房间号：' + room + (roomArg ? '（命令行指定）' : '（来自 config.json）'));
  if (!roomArg && !cfg.enabled) {
    console.log('  ⚠ 注意：config.json 里 danmaku.enabled = false，程序启动时不会自动连弹幕');
  }
  try {
    const r = await fetch('https://api.live.bilibili.com/room/v1/Room/get_info?room_id=' + room, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    const d = j.data || {};
    const liveText = d.live_status === 1 ? '直播中' : d.live_status === 2 ? '轮播' : '未开播';
    console.log('  直播状态：' + liveText + '（live_status=' + d.live_status + '）');
    console.log('  房间标题：' + (d.title || ''));
    console.log('  人气值：' + d.online + '   真实房间号：' + d.room_id);
    if (d.live_status !== 1) {
      console.log('  ⚠ 房间没在直播时，弹幕服务器通常不会推送任何消息 —— 这时候「收不到」是正常的。');
      console.log('    请让主播开播后再测，或换一个正在直播、有人聊天的房间。');
    }
    results.push({ n: '房间在直播', p: d.live_status === 1 });
  } catch (e) {
    console.log('  查询失败：' + e.message);
  }
  hr();

  // ---------------- 3+4) 真连一次 ----------------
  console.log('【3】连接弹幕服务器并观察 30 秒');
  let danmaku = 0;
  let authed = false;
  let connected = false;
  const cmds = {};

  const { LiveDanmakuClient } = require(livePath);
  const client = new LiveDanmakuClient({
    roomId: room,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  client.on('status', (s) => {
    if (s.state === 'connected') {
      connected = true;
      console.log('  ✓ 已连接（房间 ' + s.roomId + '）');
    }
  });
  client.on('danmaku', (d) => {
    danmaku += 1;
    if (danmaku <= 8) console.log('  [弹幕] ' + (d.uname || '?') + '：' + d.text);
  });
  client.on('other', (o) => {
    const c = (o && o.cmd) || '?';
    cmds[c] = (cmds[c] || 0) + 1;
    if (c === 'AUTH_REPLY' || /AUTH/.test(c)) authed = true;
  });
  client.on('error', (e) => console.log('  ✗ 连接错误：' + (e && e.message)));

  client.start().catch((e) => console.log('  ✗ 启动失败：' + e.message));

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (i === 9 || i === 19 || i === 29) {
      console.log('  t+' + (i + 1) + 's  已连接=' + connected + '  弹幕=' + danmaku + '  其他命令=' + Object.keys(cmds).length);
    }
  }
  try {
    client.stop();
  } catch {
    /* ignore */
  }

  hr();
  console.log('【4】结论');
  console.log('  连接成功：' + (connected ? '✅' : '❌'));
  console.log('  收到弹幕：' + danmaku + ' 条');
  console.log('  其他消息：' + (Object.keys(cmds).length ? JSON.stringify(cmds) : '（无）'));
  console.log('');

  if (!codeOk) {
    console.log('  → 首要问题：**这份副本的代码是旧的**，见【1】。先换成最新发行包。');
  } else if (!connected) {
    console.log('  → 连不上弹幕服务器：多半是网络/防火墙挡了 WebSocket，或 B 站接口临时不可用。');
  } else if (danmaku === 0 && Object.keys(cmds).length === 0) {
    console.log('  → 连上了、但服务端一个包都没推：通常就是这个房间没人说话，换热闹的房间再试。');
  } else if (danmaku === 0) {
    console.log('  → 连上了、也收到了别的消息，但没有弹幕：房间当时确实没人在发言。');
  } else {
    console.log('  → 一切正常，能抓到弹幕。若界面里看不到，请确认房间号填的是本房间、且已点「连接」。');
  }
  hr();
  results.push({ n: '能收到弹幕', p: danmaku > 0 });
  const failed = results.filter((r) => !r.p);
  console.log('诊断小结：' + (results.length - failed.length) + '/' + results.length + ' 项通过');
  process.exit(0);
})().catch((e) => {
  console.error('诊断异常：' + (e.stack || e.message));
  process.exit(1);
});
