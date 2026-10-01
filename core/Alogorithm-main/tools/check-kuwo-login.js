// 酷我微信扫码链路自检：申请二维码 → 轮询 → （可选）真实扫码换 Cookie
const BASE = 'http://127.0.0.1:33000';
const KUWO = 'http://127.0.0.1:33014';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const ok = (n, p, d) => {
  results.push({ n, p });
  console.log((p ? '✅' : '❌') + ' ' + n + (d ? '  → ' + d : ''));
};

async function getJson(url) {
  const r = await fetch(url);
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

(async () => {
  console.log('=== 1) 酷我登录态查询 ===');
  const st = await getJson(KUWO + '/login/status');
  ok('酷我 /login/status 正常', st.json && st.json.code === 200,
    'loggedIn=' + (st.json && st.json.loggedIn) + ' 音质=' + (st.json && st.json.quality));

  console.log('\n=== 2) 申请微信二维码（走主服务，和 Web UI 同一条路）===');
  const qr = await postJson(BASE + '/api/login/kuwo/qr');
  const d = (qr.json && qr.json.data) || {};
  ok('主服务能出酷我微信二维码', qr.json && qr.json.ok === true && String(d.base64 || '').length > 500,
    'kind=' + d.qrKind + ' 图片 ' + String(d.base64 || '').length + ' 字符');
  ok('二维码是 JPEG dataURL', String(d.base64 || '').startsWith('data:image/jpeg;base64,'), String(d.base64 || '').slice(0, 30));
  ok('返回了会话 key', Boolean(d.key), d.key);

  console.log('\n=== 3) 轮询扫码状态（未扫码，应等待约 15 秒后报「等待扫码」）===');
  const t0 = Date.now();
  const chk = await getJson(BASE + '/api/login/kuwo/qr-check?key=' + encodeURIComponent(d.key));
  const cd = (chk.json && chk.json.data) || {};
  console.log('   耗时 ' + (Date.now() - t0) + 'ms');
  ok('轮询返回未登录 + 明确的等待提示', cd.loggedIn === false && Boolean(cd.message),
    'status=' + cd.status + ' message=' + cd.message);
  ok('未扫码时不应被误判为已登录', cd.loggedIn === false, 'loggedIn=' + cd.loggedIn);

  console.log('\n=== 4) 无效 key 的容错 ===');
  const bad = await getJson(BASE + '/api/login/kuwo/qr-check?key=deadbeef');
  const bd = (bad.json && bad.json.data) || {};
  ok('无效会话给出可读提示而不是崩溃', Boolean(bd.message), bd.message);

  console.log('\n=== 5) 为「扫码后换 Cookie」这一步做预演（用假 code，验证链路形状）===');
  const probe = await getJson(KUWO + '/login/qr-check?key=deadbeef');
  ok('本地服务对无效会话容错', probe.json && Boolean(probe.json.message || probe.json.data), JSON.stringify(probe.json).slice(0, 120));

  const failed = results.filter((r) => !r.p);
  console.log('\n===== 酷我微信登录：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
  if (failed.length) process.exit(1);
})().catch((e) => {
  console.error('异常：' + e.stack);
  process.exit(1);
});
