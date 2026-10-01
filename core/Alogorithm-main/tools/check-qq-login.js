/**
 * QQ 音乐双扫码（微信 / QQ）+ 各平台登录入口自检。
 * 用法（需先启动服务）：node core\Alogorithm-main\tools\check-qq-login.js
 */
const BASE = 'http://127.0.0.1:33000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b) =>
  (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
const get = async (p) => (await fetch(BASE + p)).json();

const results = [];
const ok = (n, p, d) => {
  results.push({ n, p });
  console.log((p ? '✅' : '❌') + ' ' + n + (d ? '  → ' + d : ''));
};

(async () => {
  console.log('=== 1) 账号接口里 QQ 的扫码方式 ===');
  const acc = await get('/api/accounts');
  const qq = ((acc.data && acc.data.platforms) || []).find((p) => p.key === 'qq');
  ok('QQ 音乐已开启扫码入口', qq && qq.qr === true, 'qr=' + (qq && qq.qr));
  ok('QQ 默认走微信扫码', qq && qq.qrKind === 'wechat', 'qrKind=' + (qq && qq.qrKind));

  console.log('\n=== 2) 微信扫码（推荐路径） ===');
  const wx = await post('/api/login/qq/qr?kind=wx');
  const wd = wx.data || {};
  ok('能出微信二维码', wx.ok === true && String(wd.base64 || '').length > 500, 'kind=' + wd.qrKind + ' ' + String(wd.base64 || '').length + ' 字符');
  ok('二维码是微信来源（JPEG）', String(wd.base64 || '').startsWith('data:image/jpeg;base64,'), String(wd.base64 || '').slice(0, 30));
  ok('返回会话 key', Boolean(wd.key), wd.key);
  if (wd.key) {
    const c = await get('/api/login/qq/qr-check?kind=wx&key=' + encodeURIComponent(wd.key));
    const cd = c.data || {};
    ok(
      '未扫码时报「等待扫码」且未误判登录',
      cd.loggedIn === false && /等待|扫码/.test(String(cd.message || '')),
      'status=' + cd.status + ' ' + cd.message
    );
  }

  console.log('\n=== 3) QQ 扫码（受腾讯限制，应给出提示而不是假装正常） ===');
  const qr = await post('/api/login/qq/qr');
  const qd = qr.data || {};
  ok('QQ 扫码仍能出图', qr.ok === true && String(qd.base64 || '').length > 200, String(qd.base64 || '').length + ' 字符');
  ok(
    'QQ 扫码不可用时带明确提示',
    qd.loginReachable === false ? Boolean(qd.tip) : true,
    qd.loginReachable === false ? String(qd.tip).slice(0, 60) : '（本次可用，无需提示）'
  );

  console.log('\n=== 4) 无效会话容错 ===');
  for (const kind of ['', '&kind=wx']) {
    const r = await get('/api/login/qq/qr-check?key=deadbeef' + kind);
    ok('无效 ' + (kind ? '微信' : 'QQ') + ' 会话给出可读提示', Boolean((r.data || {}).message), (r.data || {}).message);
  }

  console.log('\n=== 5) 其他平台扫码入口未被影响 ===');
  for (const [key, expectKind] of [['netease', 'platform'], ['kugou', 'platform'], ['kuwo', 'wechat']]) {
    const r = await post('/api/login/' + key + '/qr');
    const d = r.data || {};
    ok(key + ' 扫码正常', r.ok === true && String(d.base64 || '').length > 200, 'kind=' + (d.qrKind || 'platform') + ' ' + String(d.base64 || '').length + ' 字符');
    void expectKind;
  }

  const failed = results.filter((r) => !r.p);
  console.log('\n===== QQ 双扫码登录：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.n).join('；'));
    process.exit(1);
  }
})().catch((e) => {
  console.error('异常：' + (e.stack || e.message));
  process.exit(1);
});
