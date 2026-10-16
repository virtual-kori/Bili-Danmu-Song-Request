// 验证 /obs-lytric 短链接：默认样式、参数覆盖、旧链接兼容
const BASE = 'http://127.0.0.1:33000';
const results = [];
const ok = (n, p, d) => { results.push({ n, p }); console.log((p ? '✅ ' : '❌ ') + n + (d ? '  → ' + d : '')); };

function injected(html) {
  const i = html.indexOf('var d=');
  if (i < 0) return null;
  const s = html.slice(i + 6, html.indexOf(';', i));
  try { return new URLSearchParams(JSON.parse(s)); } catch { return null; }
}

(async () => {
  console.log('=== 1) /obs-lytric 默认参数 ===');
  const r1 = await fetch(BASE + '/obs-lytric');
  const h1 = await r1.text();
  ok('短链接可访问', r1.status === 200, 'HTTP ' + r1.status + ' ' + h1.length + ' 字节');
  const q1 = injected(h1);
  ok('注入了默认参数', Boolean(q1), q1 ? q1.toString() : '无');
  if (q1) {
    const want = { cur: 'ff8fb1', other: 'c9a7ff', sizeCur: '4', sizeOther: '2', mode: 'two', halign: 'center', valign: 'middle', glow: '1', song: '1', showMeta: '1', waiting: '1' };
    const bad = Object.entries(want).filter(([k, v]) => q1.get(k) !== v);
    ok('默认值与原来那条长链接一致', bad.length === 0, bad.length ? bad.map(([k, v]) => k + '=' + q1.get(k) + '≠' + v).join(', ') : '11 项全部一致');
  }
  // 页面本体没被破坏
  ok('页面含歌词层结构', h1.includes('id="cur"') && h1.includes('--size-cur'), '');
  ok('注入脚本在 <head> 最前面（先于样式脚本执行）',
    h1.indexOf('var d=') < h1.indexOf('--size-cur'),
    '注入位置 ' + h1.indexOf('var d=') + ' < 样式脚本 ' + h1.indexOf('--size-cur'));

  console.log('\n=== 2) 仍然可以用参数覆盖 ===');
  const r2 = await fetch(BASE + '/obs-lytric?sizeCur=9&mode=single&halign=left');
  const q2 = injected(await r2.text());
  ok('覆盖字号生效', q2 && q2.get('sizeCur') === '9', q2 ? 'sizeCur=' + q2.get('sizeCur') : '无');
  ok('覆盖模式生效', q2 && q2.get('mode') === 'single', q2 ? 'mode=' + q2.get('mode') : '无');
  ok('覆盖对齐生效', q2 && q2.get('halign') === 'left', q2 ? 'halign=' + q2.get('halign') : '无');
  ok('没覆盖的项仍用默认', q2 && q2.get('cur') === 'ff8fb1' && q2.get('valign') === 'middle', q2 ? 'cur=' + q2.get('cur') + ' valign=' + q2.get('valign') : '无');
  ok('自定义 css 能透传', (await (async () => {
    const r = await fetch(BASE + '/obs-lytric?css=' + encodeURIComponent('body{opacity:.9}'));
    const q = injected(await r.text());
    return q && q.get('css') === 'body{opacity:.9}';
  })()), '');

  console.log('\n=== 3) 旧链接仍然可用（已填进 OBS 的不会失效） ===');
  for (const p of ['/obs-lyrics', '/obs/lyrics']) {
    const r = await fetch(BASE + p);
    const t = await r.text();
    ok(p + ' 仍可访问', r.status === 200 && t.includes('id="cur"'), 'HTTP ' + r.status + ' ' + t.length + ' 字节');
  }

  console.log('\n=== 4) 前端复制出来的链接是短链 ===');
  {
    const app = await (await fetch(BASE + '/app.js')).text();
    ok('app.js 生成 /obs-lytric', /location\.origin \+ '\/obs-lytric'/.test(app), '');
    ok('app.js 不再拼长参数', !/obs-lyrics\?' \+ q\.toString\(\)/.test(app), '');
    const html = await (await fetch(BASE + '/')).text();
    ok('预览按钮指向 /obs-lytric', /id="btnOpenObsLyric"[^>]*href="\/obs-lytric"/.test(html), '');
  }

  const failed = results.filter((x) => !x.p);
  console.log('\n===== OBS 歌词短链接：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.n).join('；'));
    process.exit(1);
  }
})().catch((e) => { console.error('异常：' + (e.stack || e.message)); process.exit(1); });
