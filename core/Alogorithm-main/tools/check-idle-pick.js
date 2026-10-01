/**
 * 空闲选曲自检：榜单可用性 / 开播即出队 / 空闲随机与跨平台跳过最近播放。
 *
 * 用法（需先启动服务）：node core\Alogorithm-main\tools\check-idle-pick.js
 */
const BASE = 'http://127.0.0.1:33000';
const PORTS = { netease: 33011, qq: 33012, kugou: 33013, kuwo: 33014 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, b) =>
  (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })).json();

const results = [];
const ok = (n, p, d) => {
  results.push({ n, p });
  console.log((p ? '✅' : '❌') + ' ' + n + (d ? '  → ' + d : ''));
};

async function cleanup() {
  await post('/api/switches', { idleAutoPlay: false });
  await post('/api/play/stop');
  await sleep(2500);
  await post('/api/queue/clear');
  await sleep(800);
}

(async () => {
  console.log('=== 1) 四平台榜单接口 ===');
  const { NeteaseAdapter } = require('../platforms/netease');
  const { QQAdapter } = require('../platforms/qq');
  const { KugouAdapter } = require('../platforms/kugou');
  const { KuwoAdapter } = require('../platforms/kuwo');
  const gp = (k) => ({ port: PORTS[k], cookie: '', token: '' });
  const adapters = {
    netease: new NeteaseAdapter(() => gp('netease')),
    qq: new QQAdapter(() => gp('qq')),
    kugou: new KugouAdapter(() => gp('kugou')),
    kuwo: new KuwoAdapter(() => gp('kuwo')),
  };
  for (const key of ['netease', 'qq', 'kugou', 'kuwo']) {
    const a = adapters[key];
    let list = [];
    try {
      list = await a.recommendSongs(10);
    } catch {
      list = [];
    }
    const sample = list[0] ? list[0].name + ' - ' + list[0].singer : '';
    ok(key + ' 榜单可用', list.length > 0, list.length + ' 首' + (sample ? '（如 ' + sample + '）' : ''));
    if (list.length) {
      const r = await a.resolveUrl(list[0]);
      ok(key + ' 榜单首曲可播放', Boolean(r && r.ok), (r && (r.qualityLabel || r.error)) || '');
    }
  }

  console.log('\n=== 2) 开始播放即从未播放队列出队 ===');
  await cleanup();
  const r1 = await post('/api/order', { name: '天空之城' });
  ok('点歌成功', r1.ok === true, r1.matched ? r1.matched.name : '');
  await sleep(900);
  let st = (await get('/api/state')).data;
  ok(
    '开始播放后队列里不再有它',
    st.queue.length === 0 && Boolean(st.current),
    '队列 ' + st.queue.length + ' 首，正在播 ' + (st.current ? st.current.name : '无')
  );
  ok('「正在播放」仍然显示它', Boolean(st.current) && st.current.name === (r1.matched ? r1.matched.name : ''), st.current ? st.current.name : '无');

  const r2 = await post('/api/order', { name: '致爱丽丝' });
  await sleep(1200);
  st = (await get('/api/state')).data;
  ok('后点的歌留在未播放队列里', st.queue.length === 1, '队列 ' + st.queue.map((q) => q.name).join(', '));
  const curName = st.current ? st.current.name : '';
  ok('当前播放项不占队列位', st.queue.every((q) => q.name !== curName), '当前=' + curName);

  console.log('\n=== 3) 空闲随机 + 跳过最近播放（跨平台） ===');
  await cleanup();
  await post('/api/switches', { idleAutoPlay: true });

  const played = [];
  for (let i = 0; i < 8; i++) {
    let cur = null;
    for (let w = 0; w < 25; w++) {
      await sleep(1000);
      const s = (await get('/api/state')).data;
      if (s.current && s.phase === 'PLAYING') {
        cur = s.current;
        break;
      }
    }
    if (!cur) break;
    played.push({ name: cur.name, singer: cur.singer, platform: cur.platformLabel });
    console.log('   ' + (i + 1) + '. ' + cur.name + ' - ' + cur.singer + ' [' + cur.platformLabel + ']');
    await post('/api/play/next');
    await sleep(1500);
  }

  const names = played.map((p) => p.name);
  ok('空闲能连续补歌（≥6 首）', played.length >= 6, played.length + ' 首');
  ok(
    '连续多首不重复（含跨平台同一首歌）',
    new Set(names).size === names.length,
    '去重 ' + new Set(names).size + ' / 共 ' + names.length
  );
  const platforms = [...new Set(played.map((p) => p.platform))];
  ok('多个平台的榜单都被用到', platforms.length >= 2, platforms.join(', '));

  await cleanup();

  const failed = results.filter((r) => !r.p);
  console.log('\n===== 空闲选曲：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.n).join('；'));
    process.exit(1);
  }
})().catch((e) => {
  console.error('异常：' + (e.stack || e.message));
  process.exit(1);
});
