// 端到端验收脚本：队列、暂停、切歌、置顶、MPV 不残留
const { execFileSync } = require('child_process');

const BASE = 'http://127.0.0.1:33000';

async function get(p) {
  return (await fetch(BASE + p)).json();
}
async function post(p, b) {
  return (
    await fetch(BASE + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b || {}),
    })
  ).json();
}
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

function mpvCount() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq mpv.exe', '/NH'], { windowsHide: true }).toString();
    return out.split(/\r?\n/).filter((l) => /mpv\.exe/i.test(l)).length;
  } catch {
    return -1;
  }
}

(async () => {
  const results = [];
  const ok = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log((pass ? '✅' : '❌') + ' ' + name + (detail ? '  → ' + detail : ''));
  };

  // 0. 停止播放并清空队列，确保从干净状态开始
  await post('/api/play/stop');
  await sleep(2500);
  await post('/api/queue/clear');
  await sleep(800);

  // 1. 点歌：歌名 + 歌手
  const o1 = await post('/api/order', { name: '晴天', singer: '周杰伦' });
  ok('点歌 歌名+歌手 能匹配并考虑平台优先级', o1.ok === true, o1.ok ? o1.matched.platformLabel + ' / ' + o1.matched.name + ' - ' + o1.matched.singer + ' [' + o1.tierName + ']' : JSON.stringify(o1));

  const o2 = await post('/api/order', { name: '告白气球', singer: '周杰伦' });
  ok('点歌 第二首', o2.ok === true, o2.ok ? o2.matched.name : JSON.stringify(o2));

  const o3 = await post('/api/order', { name: '稻香', singer: '周杰伦' });
  ok('点歌 第三首', o3.ok === true, o3.ok ? o3.matched.name : JSON.stringify(o3));

  await sleep(3500);
  let st = (await get('/api/state')).data;
  ok('点歌后只入队不插队播放（当前播放为第一首）', st.current && st.current.name === '晴天', '当前=' + (st.current && st.current.name) + '，队列=' + st.queue.map((q) => q.name).join('/'));
  ok(
    '开始播放的那首已从未播放队列出队',
    st.current && st.queue.every((q) => q.name !== st.current.name) && st.queue.length === 2,
    '队列 ' + st.queue.map((q) => q.name).join('/') + '（应为后点的两首）'
  );
  ok('MPV 进程唯一（不残留）', mpvCount() === 1, 'mpv 进程数=' + mpvCount());

  // 2. 置顶：把队列最后一首置顶，切歌后应播放它
  const last = st.queue[st.queue.length - 1];
  const pin = await post('/api/queue/pin', { id: last.id, pinned: true });
  ok('置顶操作成功', pin.ok === true && pin.item.pinned === true, last.name);
  await sleep(500);
  st = (await get('/api/state')).data;
  ok('置顶后排到队首', st.queue[0].id === last.id, '队首=' + st.queue[0].name);

  // 3. 切歌 → 应播放置顶曲，且旧 mpv 被关闭
  await post('/api/play/next');
  await sleep(4000);
  st = (await get('/api/state')).data;
  ok('切歌后播放置顶曲', st.current && st.current.name === last.name, '当前=' + (st.current && st.current.name));
  ok('切歌后 MPV 仍只有一个进程', mpvCount() === 1, 'mpv 进程数=' + mpvCount());

  // 4. 暂停/继续
  await post('/api/play/pause');
  await sleep(700);
  st = (await get('/api/state')).data;
  const paused = st.current && st.current.paused;
  await post('/api/play/pause');
  await sleep(700);
  st = (await get('/api/state')).data;
  ok('暂停与继续可用', paused === true && st.current && st.current.paused === false, 'pause=' + paused + ' → ' + (st.current && st.current.paused));

  // 5. 停止播放 → mpv 应被回收
  await post('/api/play/stop');
  await sleep(2500);
  st = (await get('/api/state')).data;
  ok('停止播放后 MPV 进程被关闭', mpvCount() === 0, 'mpv 进程数=' + mpvCount());
  ok('停止后状态回到空闲', st.phase === 'IDLE' || st.phase === 'CLOSED', 'phase=' + st.phase);

  // 6. 开关：关闭弹幕点歌
  await post('/api/switches', { danmakuOrder: false });
  await sleep(400);
  const dm = await get('/api/state');
  ok('关闭「允许弹幕点歌」生效', dm.data.switches.danmakuOrder === false, '');
  await post('/api/switches', { danmakuOrder: true });

  // 7. 队列删除 / 清空
  st = (await get('/api/state')).data;
  if (st.queue.length) {
    const r = await post('/api/queue/remove', { id: st.queue[0].id });
    ok('删除队列项可用', r.ok === true, '');
  }
  const c = await post('/api/queue/clear');
  ok('清空队列可用', c.ok === true, '移除 ' + c.removed + ' 首');

  // 8. 空闲自动播放：开启后队列空应能自动补齐并开始播放
  await post('/api/order', { name: '青花瓷', singer: '周杰伦' });
  await sleep(3500);
  await post('/api/play/stop');
  await sleep(2500);
  await post('/api/queue/clear');
  await post('/api/switches', { idleAutoPlay: true });
  await sleep(12000);
  st = (await get('/api/state')).data;
  const idlePlaying = (st.phase === 'PLAYING' && st.current) || st.queue.length > 0;
  ok(
    '开启「空闲自动播放」后队列空能自动续播',
    Boolean(idlePlaying),
    (st.current ? '正在播放 ' + st.current.name + '（推荐）' : '') + (st.queue.length ? ' 已补 ' + st.queue.length + ' 首' : '') + ' | phase=' + st.phase
  );
  // 先关开关再停止，避免停止的瞬间空闲推荐又把队列填满（时序竞争会导致误判）
  await post('/api/switches', { idleAutoPlay: false });
  await sleep(500);
  await post('/api/play/stop');
  await sleep(2500);
  await post('/api/queue/clear');
  await sleep(3000);
  st = (await get('/api/state')).data;
  if (st.current || st.queue.length) {
    // 兜底：再清一次，确保断言针对的是「开关已关」的稳定状态
    await post('/api/play/stop');
    await post('/api/queue/clear');
    await sleep(3000);
    st = (await get('/api/state')).data;
  }
  ok('关闭「空闲自动播放」后保持空闲', st.phase === 'IDLE' && !st.current, 'phase=' + st.phase + '，队列 ' + st.queue.length + ' 首');
  ok('空闲播放结束后 MPV 进程无残留', mpvCount() === 0, 'mpv 进程数=' + mpvCount());

  const failed = results.filter((r) => !r.pass);
  console.log('\n===== 汇总：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('；'));
    process.exit(1);
  }
})().catch((e) => {
  console.error('验收脚本异常：' + e.stack);
  process.exit(1);
});
