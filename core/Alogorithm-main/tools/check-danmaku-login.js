/**
 * 「登录 B 站后弹幕必须仍能连上」自检。
 *
 * 背景（恶性 bug）：鉴权包里的 uid 必须固定发 0。
 * 实测矩阵（本机，房间 21452505）：
 *   匿名token + uid=0      → ✅ 稳定
 *   登录token + uid=0      → ✅ 稳定
 *   任意token + 登录uid    → ❌ 服务端立刻掐断，零帧、无 AUTH_REPLY
 * 表现就是「登录 B 站后怎么都连不上弹幕」。
 *
 * 所以这里做两件事：
 *   ① 静态检查：鉴权包里不能出现 selfUid / loggedIn
 *   ② 动态检查：带着「已登录」的 auth 真连一次，必须收到 AUTH_REPLY
 *
 * 用法：node core\Alogorithm-main\tools\check-danmaku-login.js [房间号]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CAP = path.join(ROOT, 'core', 'Bullet-Screen-Capture');
const livePath = path.join(CAP, 'live.js');
const live = require(livePath);
const { BiliAuth } = require(path.join(CAP, 'auth.js'));

const results = [];
const ok = (n, p, d) => {
  results.push({ n, p });
  console.log((p ? '✅ ' : '❌ ') + n + (d ? '  → ' + d : ''));
};

(async () => {
  console.log('=== 1) 静态：鉴权包必须固定 uid=0 ===');
  const src = fs.readFileSync(livePath, 'utf8');
  // 只取「构造鉴权包」的那一小段（authBody = { ... }）
  const m = /const authBody = \{([\s\S]*?)\};/.exec(src);
  const body = m ? m[1] : '';
  ok('找得到 authBody 构造处', Boolean(m), m ? '' : '源码结构可能变了');
  ok('鉴权包里 uid 写死为 0', /uid:\s*0\s*,/.test(body), body ? body.split('\n')[0].trim() : '');
  ok('鉴权包里没有引用 selfUid', !/selfUid/.test(body), '');
  ok('鉴权包里没有引用 loggedIn', !/loggedIn/.test(body), '');

  // 取 token 也必须匿名：实测「带登录 Cookie 的 token」即使 uid=0 也会被秒断。
  // 这两条缺一不可，所以都要静态钉住。
  const confBlock = /getConf[\s\S]{0,900}?collectCookies:\s*false/.test(src);
  ok('取弹幕 token 时强制匿名（cookie: \'\'）', /cookie:\s*''/.test(src) && confBlock, '避免登录后 token 被绑到身份上');

  console.log('\n=== 2) 动态：带着已登录的 auth 真连一次 ===');
  const auth = new BiliAuth();
  await new Promise((r) => setTimeout(r, 1200));
  console.log('  当前 B 站登录态：loggedIn=' + auth.loggedIn + '  uid=' + auth.selfUid + '  ' + (auth.selfName || ''));
  if (!auth.loggedIn) {
    console.log('  ⚠ 没有登录态，这一项就退化成「匿名也能连」的验证。');
  }

  const room = Number(process.argv[2] || 21452505);
  let authed = false;
  let frames = 0;
  let danmaku = 0;
  let connected = false;

  const client = new live.LiveDanmakuClient({
    roomId: room,
    auth, // 关键：传入带登录态的 auth
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  client.on('status', (s) => {
    if (s.state === 'connected') connected = true;
  });
  client.on('danmaku', () => {
    danmaku += 1;
  });

  // start() 是自动重连的无限循环，永远不 resolve —— 绝不能 await
  client.start().catch(() => {});

  // 通过内部状态观察鉴权结果
  const deadline = Date.now() + 22000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (client.handshakeDone) authed = true;
    const ws = client.ws;
    if (ws && typeof ws.closed === 'boolean') frames = Math.max(frames, authed ? 1 : 0);
    if (authed && Date.now() - (client._authAt || 0) > 1000 && client.stats && client.stats.danmaku > 0) break;
  }
  authed = Boolean(client.handshakeDone);
  if (client.stats) danmaku = client.stats.danmaku;

  try {
    client.stop();
  } catch {
    /* ignore */
  }

  ok('已连接到弹幕服务器', connected, '房间 ' + room);
  ok(
    '鉴权通过（收到 AUTH_REPLY）——登录态下也必须通过',
    authed,
    authed ? 'handshakeDone=true' : '没收到 AUTH_REPLY，说明被服务端掐断了'
  );
  console.log('   （本次收到弹幕 ' + danmaku + ' 条，仅作参考）');

  console.log('\n=== 3) 未开播的房间不得紧凑重连 ===');
  {
    // 老代码的问题：未开播房间「连上→秒断→2 秒后再连」，日志刷屏。
    // 现在应该直接判定未开播并跳过连接（退避到 reconnectMax）。
    // 这里动态找一个当前没开播的房间；找不到就跳过。
    let offlineRoom = 0;
    for (const id of [1934302095, 1017, 21452505]) {
      try {
        const r = await fetch('https://api.live.bilibili.com/room/v1/Room/get_info?room_id=' + id, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000),
        });
        const j = await r.json();
        if (j.data && j.data.live_status === 0) {
          offlineRoom = id;
          break;
        }
      } catch {
        /* ignore */
      }
    }

    if (!offlineRoom) {
      console.log('   （没有找到未开播的房间，跳过这项）');
    } else {
      const events = [];
      const c = new live.LiveDanmakuClient({
        roomId: offlineRoom,
        logger: { info: (m) => events.push(m), warn() {}, error() {}, debug() {} },
      });
      c.start().catch(() => {});
      await new Promise((r) => setTimeout(r, 20000));
      try {
        c.stop();
      } catch {
        /* ignore */
      }
      const reconnects = events.filter((m) => /重连|重试/.test(m)).length;
      ok(
        '未开播房间在 20 秒内不会反复重连',
        reconnects <= 1,
        '房间 ' + offlineRoom + ' 重连 ' + reconnects + ' 次（老代码每 2 秒一次，约 10 次）'
      );
      ok('会明确告知「未开播」', /未开播|offline/i.test(events.join(' ')) || Boolean(c.liveStatus === 0), 'liveStatus=' + c.liveStatus);
    }
  }

  const failed = results.filter((r) => !r.p);
  console.log('\n===== 登录态下弹幕自检：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.n).join('；'));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('自检异常：' + (e.stack || e.message));
  process.exit(1);
});
