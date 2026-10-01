// 主服务弹幕链路验证：连直播间 → 收弹幕 → 弹幕点歌全链路
const BASE = 'http://127.0.0.1:33000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, b) =>
  (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })).json();

(async () => {
  const roomId = Number(process.argv[2] || 21452505);
  const results = [];
  const ok = (n, p, d) => {
    results.push({ n, p });
    console.log((p ? '✅' : '❌') + ' ' + n + (d ? '  → ' + d : ''));
  };

  // 先断开再连，确保是全新连接
  await post('/api/danmaku/disconnect');
  await sleep(1200);

  console.log('连接直播间 ' + roomId + ' …');
  const conn = await post('/api/danmaku/connect', { roomId });
  ok('通过 Web UI/API 连接直播间成功', conn.ok === true, JSON.stringify(conn.data || conn.error || '').slice(0, 120));

  // 观察 30 秒，看弹幕是否进来
  let st = null;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    st = (await get('/api/state')).data;
    const n = (st.danmaku && st.danmaku.stats && st.danmaku.stats.danmaku) || 0;
    if (n > 0) break;
  }
  st = (await get('/api/state')).data;
  const dm = st.danmaku || {};
  const stats = dm.stats || {};
  ok('服务端状态显示已连接', dm.state === 'connected', 'state=' + dm.state + '，房间=' + dm.roomId);
  ok('确实收到了直播弹幕', (stats.danmaku || 0) > 0, '收到弹幕 ' + (stats.danmaku || 0) + ' 条，礼物 ' + (stats.gift || 0) + '，SC ' + (stats.superchat || 0));

  const recent = st.recentDanmaku || [];
  ok('弹幕进入「最近弹幕」列表', recent.length > 0, '共 ' + recent.length + ' 条');
  console.log('   最近几条：');
  recent.slice(0, 6).forEach((c) => console.log('     [' + c.kind + '] ' + c.uname + '：' + c.text));

  // 弹幕来源（解析结果）确认 uid/uname 是否可用
  const withUid = recent.filter((c) => c.uid && c.uid !== 0).length;
  console.log('   其中带真实 uid 的：' + withUid + '/' + recent.length + '（未登录 B 站时 B 站会把 uid 置 0、昵称打码）');

  // 断开
  await post('/api/danmaku/disconnect');
  await sleep(1200);
  st = (await get('/api/state')).data;
  ok('断开后状态正确', (st.danmaku || {}).state !== 'connected', 'state=' + (st.danmaku || {}).state);

  const failed = results.filter((r) => !r.p);
  console.log('\n===== 弹幕捕捉：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
  if (failed.length) process.exit(1);
})().catch((e) => {
  console.error('异常：' + e.stack);
  process.exit(1);
});
