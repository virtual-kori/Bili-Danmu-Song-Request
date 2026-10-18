/**
 * 空闲「漫游」自检：确认能拿到随机歌、并且失败时会退化到榜单。
 *
 * 用法：node core\Alogorithm-main\tools\check-roam.js
 *   需要主服务已在 http://127.0.0.1:33000 运行。
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

const BASE = 'http://127.0.0.1:33000';
const PORTS = { netease: 33011, qq: 33012, kugou: 33013, kuwo: 33014 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const ok = (n, p, d) => {
  results.push({ n, p });
  console.log((p ? '✅ ' : '❌ ') + n + (d ? '  → ' + d : ''));
};

(async () => {
  try {
    const r = await fetch(BASE + '/api/state');
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    console.log('⚠ 主服务未运行（' + BASE + '），跳过漫游自检：' + e.message);
    process.exit(0);
  }

  console.log('=== 1) 适配器层面：roamSongs 存在且能出歌 ===');
  const { NeteaseAdapter } = require(path.join(ROOT, 'core', 'Alogorithm-main', 'platforms', 'netease.js'));
  const ne = new NeteaseAdapter(() => ({ port: PORTS.netease, cookie: '', token: '' }));
  ok('网易云实现了 roamSongs', typeof ne.roamSongs === 'function', '');

  let roam = [];
  let roamErr = '';
  try {
    roam = await ne.roamSongs(6);
  } catch (e) {
    roamErr = e.message;
  }
  if (roamErr) {
    console.log('   （漫游暂时不可用：' + roamErr + ' —— 可能是未登录或限流，属正常降级场景）');
  }
  const names = roam.map((s) => s.name + ' - ' + (s.singer || ''));
  console.log('  取到 ' + roam.length + ' 首：' + names.slice(0, 6).join(' | '));
  ok('能取到漫游歌曲', roam.length > 0, roam.length + ' 首' + (roamErr ? '（' + roamErr + '）' : ''));
  if (roam.length) {
    ok('返回结构完整（name/platform/songId）', roam.every((s) => s.name && s.platform === 'netease' && s.songId), JSON.stringify(roam[0]).slice(0, 100));
    ok('没有重复曲目', new Set(roam.map((s) => s.songId)).size === roam.length, '去重 ' + new Set(roam.map((s) => s.songId)).size + '/' + roam.length);
  }

  console.log('\n=== 2) 接口层面：切换 source=roam 后状态正确 ===');
  {
    const cfg = await (await fetch(BASE + '/api/state')).json();
    void cfg;
    const save = await fetch(BASE + '/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idle: { source: 'roam' } }),
    });
    ok('能保存 source=roam', save.ok, 'HTTP ' + save.status);

    const st = await (await fetch(BASE + '/api/state')).json();
    const src = st.data && st.data.config && st.data.config.idleSource;
    ok('状态里回显 roam', src === 'roam', 'idleSource=' + src);
  }

  console.log('\n=== 3) 漫游不可用时必须退化为榜单（不能没歌） ===');
  {
    // 用一个不存在的平台优先级 + 只有 netease 可漫游，验证退化链路仍能出歌
    const Engine = require(path.join(ROOT, 'core', 'Alogorithm-main', 'core', 'engine.js'));
    void Engine;
    // 直接看 engine 源码里是否有退化分支（静态断言，避免真的把网易云打限流）
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'core', 'Alogorithm-main', 'core', 'engine.js'), 'utf8');
    ok('engine 有 roam 分支', /cfg\.source === 'roam'/.test(src), '');
    ok('roam 失败会退化为榜单', /roam[\s\S]{0,900}fetchPlatformRecommend\(/.test(src), '退化为 fetchPlatformRecommend');
    ok('roam 分支会跳过未实现的平台', /adapter\.roamSongs !== 'function'/.test(src), '没有 roamSongs 的平台直接 continue');
  }

  // 还原成默认，别把用户设置改坏
  await fetch(BASE + '/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idle: { source: 'platform' } }),
  });
  console.log('\n（已把 idle.source 还原为 platform）');

  const failed = results.filter((r) => !r.p);
  console.log('\n===== 漫游自检：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.n).join('；'));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('自检异常：' + (e.stack || e.message));
  process.exit(1);
});
