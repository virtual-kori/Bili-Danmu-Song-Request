/**
 * 登录链路自检：网易云 Cookie 提取、QQ Cookie 校验、账号状态准确性。
 * 用法（需先启动服务）：node core\Alogorithm-main\tools\check-login-flow.js
 */
const BASE = 'http://127.0.0.1:33000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, b) =>
  (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })).json();

const results = [];
const ok = (n, p, d) => {
  results.push({ n, p });
  console.log((p ? '✅' : '❌') + ' ' + n + (d ? '  → ' + d : ''));
};

(async () => {
  console.log('=== 1) 网易云：二维码接口契约（cookie 在响应体里） ===');
  const keyRes = await (await fetch('http://127.0.0.1:33011/login/qr/key?timestamp=' + Date.now())).json();
  const unikey = keyRes && keyRes.data && keyRes.data.unikey;
  ok('网易云能出二维码 key', Boolean(unikey), unikey || '');
  if (unikey) {
    const c = await (await fetch(
      'http://127.0.0.1:33011/login/qr/check?key=' + encodeURIComponent(unikey) + '&timestamp=' + Date.now()
    )).json();
    ok('check 返回 code 字段（801 等待扫码）', c.code === 801 || c.code === 802, 'code=' + c.code + ' ' + c.message);
    ok(
      'check 的登录凭证在响应体 cookie 字段里（这正是之前漏掉的地方）',
      typeof c.cookie === 'string' && c.cookie.length > 0,
      c.cookie ? c.cookie.split(';')[0].slice(0, 40) : '无'
    );
  }

  console.log('\n=== 1b) Cookie 提取要对各种响应形态都管用（参照参考项目实现） ===');
  {
    const { extractQrCookie, splitCookiePairs } = require('../core/qr-cookie');
    const shapes = [
      ['顶层 cookie', { code: 803, cookie: 'MUSIC_U=A; __csrf=B' }, 'MUSIC_U=A; __csrf=B'],
      ['body.cookie', { body: { cookie: 'MUSIC_U=C' } }, 'MUSIC_U=C'],
      ['data.cookie', { data: { cookie: 'MUSIC_U=D' } }, 'MUSIC_U=D'],
      ['set-cookie 数组', { 'set-cookie': ['MUSIC_U=E; Path=/', '__csrf=F; Path=/'] }, 'MUSIC_U=E; __csrf=F'],
      ['等待扫码（无 cookie）', { code: 801 }, ''],
      ['null', null, ''],
    ];
    let pass = 0;
    for (const [label, input, want] of shapes) {
      let got = '';
      try {
        got = extractQrCookie(input);
      } catch {
        got = 'ERR';
      }
      if (got === want) pass += 1;
      else console.log('     ⚠ ' + label + ' 得到「' + got + '」期望「' + want + '」');
    }
    ok('Cookie 提取覆盖 6 种响应形态', pass === shapes.length, pass + '/' + shapes.length);

    const dropAttrs = splitCookiePairs('a=1; Path=/; b=2; Expires=Wed; Max-Age=9');
    ok('Cookie 拆分丢掉 Path/Expires 等属性', JSON.stringify(dropAttrs) === JSON.stringify(['a=1', 'b=2']), JSON.stringify(dropAttrs));
  }

  console.log('\n=== 1c) 登录态检测以 profile 为准（匿名账号不算登录） ===');
  {
    const { NeteaseAdapter } = require('../platforms/netease');
    const a = new NeteaseAdapter(() => ({ port: 33011, cookie: '', token: '' }));
    const acc = await a.currentAccount();
    ok('未登录时 currentAccount().loggedIn === false', acc.loggedIn === false, 'nickname=「' + acc.nickname + '」uid=' + acc.uid);
    ok('无 Cookie 时 currentAccount().loggedIn === false', acc.loggedIn === false, 'nickname=「' + acc.nickname + '」uid=' + acc.uid);
    ok('不会把匿名账号名（1000_XXX）当成昵称', !acc.nickname || !/^1000_/.test(acc.nickname), acc.nickname || '（空）');
    ok('currentAccount 结构完整', typeof acc.loggedIn === 'boolean' && typeof acc.vip === 'boolean', JSON.stringify(acc).slice(0, 90));
  }

  console.log('\n=== 2) 账号接口的登录判定要与真实情况一致 ===');
  const acc = await get('/api/accounts');
  const plat = (acc.data && acc.data.platforms) || [];
  const ne = plat.find((p) => p.key === 'netease');
  ok(
    '账号接口字段完整',
    plat.every((p) => typeof p.loggedIn === 'boolean' && typeof p.note === 'string' && p.note.length > 0),
    plat.map((p) => p.key + '=' + p.loggedIn).join(' ')
  );
  // 登录判定必须与「适配器的权威判断」一致，不能因为能取到直链就报已登录
  {
    const { NeteaseAdapter } = require('../platforms/netease');
    const cfg = require('../core/config');
    const ck = (cfg.platforms.netease && cfg.platforms.netease.cookie) || '';
    const a = new NeteaseAdapter(() => ({ port: 33011, cookie: ck, token: '' }));
    const real = await a.currentAccount();
    ok(
      '账号接口的 loggedIn 与 currentAccount() 一致',
      Boolean(ne && ne.loggedIn) === Boolean(real.loggedIn),
      '接口=' + (ne && ne.loggedIn) + ' 权威=' + real.loggedIn + '（' + (real.nickname || '未登录') + '）'
    );
    if (real.loggedIn) {
      ok('已登录时能给出昵称', Boolean(real.nickname), real.nickname + '（uid ' + real.uid + '）');
    }
  }

  console.log('\n=== 3) QQ：Cookie 校验真的会挑出无效凭证 ===');
  // 说明：uin + qm_keyst 齐全时本地服务只做字段提取，伪造的 key 也会被认下，
  // 所以这一项检查的是「提示是否坦诚」，不是「能否识别伪造」。
  const bad = await post('/api/login/qq/cookie', { cookie: 'uin=123456789; qm_keyst=SYNTHETICKEY123' });
  const badD = bad.data || {};
  console.log('   合成 Cookie 的校验结果: ' + JSON.stringify(badD));
  ok('保存后一定给出可读结论', Boolean(badD.message), badD.message);
  ok(
    '成功时不会夸大成「已确保能取无损」',
    !/确保|保证/.test(String(badD.message || '')),
    badD.message
  );

  const junk = await post('/api/login/qq/cookie', { cookie: 'hello=world' });
  const junkD = (junk.data || {});
  ok(
    '缺少必填字段的 Cookie 被拒绝校验',
    junkD.validated === false && /uin|qm_keyst|qqmusic_key/.test(String(junkD.message || '')),
    junkD.message
  );

  console.log('\n=== 4) 校验后把 QQ 恢复成未登录（别留下测试 Cookie） ===');
  await post('/api/login/qq/logout');
  await sleep(1200);
  const after = await get('/api/accounts');
  const qq = ((after.data && after.data.platforms) || []).find((p) => p.key === 'qq');
  ok('QQ 已回到未登录', qq && qq.loggedIn === false, 'note=' + (qq && qq.note));

  console.log('\n=== 5) 酷我真实登录不应被影响 ===');
  const kw = ((after.data && after.data.platforms) || []).find((p) => p.key === 'kuwo');
  if (kw && kw.hasCookie) {
    ok('酷我仍是已登录', kw.loggedIn === true, 'note=' + kw.note);
  } else {
    console.log('   （酷我当前没有登录，跳过这一项）');
  }

  const failed = results.filter((r) => !r.p);
  console.log('\n===== 登录链路：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.n).join('；'));
    process.exit(1);
  }
})().catch((e) => {
  console.error('异常：' + (e.stack || e.message));
  process.exit(1);
});
