// 验证 Web UI 登录中心：页面元素、静态资源、接口联动
// 用法：先双击 启动.bat，然后 node core\Alogorithm-main\tools\check-webui.js
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// 本文件在 core/Alogorithm-main/tools/，往上三层就是项目根目录
const dir = path.resolve(__dirname, '..', '..', '..');
const cfgMod = require('../core/config');
const BASE = 'http://127.0.0.1:' + ((cfgMod.config.server && cfgMod.config.server.port) || 33000);

function get(p) {
  const r = spawnSync('node', ['-e', `fetch('${BASE}${p}').then(async r=>{const t=await r.text();console.log(JSON.stringify({status:r.status,type:r.headers.get('content-type'),len:t.length,body:t.slice(0,400000)}))}).catch(e=>console.log(JSON.stringify({error:e.message})))`], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 20e6,
  });
  try {
    return JSON.parse((r.stdout || '').trim());
  } catch {
    return { error: 'parse-fail', raw: (r.stdout || '').slice(0, 200) };
  }
}

(async () => {
  const results = [];
  const ok = (n, p, d) => {
    results.push({ n, p });
    console.log((p ? '✅' : '❌') + ' ' + n + (d ? '  → ' + d : ''));
  };

  // 1. 静态资源
  for (const [label, p] of [['主页', '/'], ['前端脚本', '/app.js'], ['样式表', '/style.css'], ['OBS 页面', '/obs']]) {
    const r = get(p);
    ok(label + ' 可访问', r.status === 200 && r.len > 0, r.status + ' ' + r.len + ' 字节');
  }

  // 2. 页面里是否包含布局与设置中心的关键元素
  const html = (get('/').body || '');
  for (const [label, needle] of [
    ['顶栏登录中心按钮', 'id="btnAccounts"'],
    ['登录中心弹窗', 'id="accModal"'],
    ['设置中心标签栏', 'id="accTabs"'],
    ['账号标签页', 'data-pane="accounts"'],
    ['直播间弹幕标签页', 'data-pane="room"'],
    ['平台优先级标签页', 'data-pane="platforms"'],
    ['账号列表容器', 'id="accList"'],
    ['账号详情容器', 'id="accDetail"'],
    ['平台优先级列表', 'id="platformList"'],
    ['房间号输入框', 'id="inRoom"'],
    ['手动点歌输入框', 'id="inName"'],
    ['实时歌词容器', 'id="lyricsBody"'],
    ['未播放队列容器', 'id="queueList"'],
    ['歌词设置卡片', 'lyricset-card'],
    ['歌词模式选择', 'id="inLyricMode"'],
    ['左右对齐选择', 'id="inLyricHAlign"'],
    ['上下对齐选择', 'id="inLyricVAlign"'],
    ['OBS 歌词链接输入框', 'id="obsLyricUrl"'],
    ['复制 OBS 链接按钮', 'id="btnCopyObsLyric"'],
    ['OBS 自定义 CSS 输入', 'id="inObsCss"'],
    ['OBS 当前行字号', 'id="inObsSizeCur"'],
  ]) {
    ok(label + ' 已就位', html.includes(needle), needle);
  }

  // 2a. 独立的 OBS 歌词页
  const obsLyric = get('/obs-lyrics');
  ok('OBS 歌词页 可访问', obsLyric.status === 200, '200 ' + String((obsLyric.body || '').length) + ' 字节');
  const olHtml = obsLyric.body || '';
  for (const [label, needle] of [
    ['读取 URL 参数', 'URLSearchParams'],
    ['透明背景', 'background: transparent'],
    ['支持自定义颜色', '--cur'],
    ['支持自定义字号', '--size-cur'],
    ['支持歌词模式', "'single'"],
    ['支持左右对齐', 'halign'],
    ['支持上下对齐', 'valign'],
    ['支持自定义 CSS', "q.get('css')"],
    ['支持滚动模式', 'SCROLL_SPAN'],
  ]) {
    ok('OBS 歌词页 ' + label, olHtml.includes(needle), needle);
  }
  const alias = get('/obs/lyrics');
  ok('OBS 歌词页 /obs/lyrics 别名可用', alias.status === 200, String(alias.status));

  // 2b. 三个标签页必须都在设置中心弹窗内部（而不是散落在页面上）
  const modalStart = html.indexOf('id="accModal"');
  const modalHtml = modalStart >= 0 ? html.slice(modalStart) : '';
  for (const [label, needle] of [
    ['平台优先级列表在弹窗内', 'id="platformList"'],
    ['房间号输入框在弹窗内', 'id="inRoom"'],
    ['连接按钮在弹窗内', 'id="btnConnect"'],
  ]) {
    ok(label, modalHtml.includes(needle), needle);
  }

  // 2c. 页面不应再出现已删除的侧栏账号卡片
  ok('已移除旧侧栏账号卡片', !html.includes('accountsMini'), 'accountsMini');

  // 2d. 目录结构：登录脚本应统一收在 core/ 里
  const rootDir = path.resolve(__dirname, '..', '..', '..');
  // node/ 是旧版自带运行时位置（仍兼容）；标准位置已改到 core/node 与 core/python
  const rootFiles = fs.readdirSync(rootDir).filter((n) => !/^_/.test(n) && n !== 'node' && n !== 'runtime').sort();
  ok(
    '根目录只留启动/停止/重置与 config.json（+ 可选 node/、runtime/）',
    JSON.stringify(rootFiles) === JSON.stringify(['config.json', 'core', '停止.bat', '启动.bat', '重置.bat'].sort()),
    rootFiles.join(' , ')
  );
  const coreBats = fs.readdirSync(path.join(rootDir, 'core')).filter((n) => n.endsWith('.bat')).sort();
  ok(
    '登录脚本都收在 core/ 里',
    JSON.stringify(coreBats) === JSON.stringify(['登录.bat', '登录QQ音乐.bat', '登录网易云.bat', '登录酷我.bat', '登录酷狗.bat'].sort()),
    coreBats.join(' , ')
  );

  // 3. 前端脚本里是否有登录中心逻辑
  const js = (get('/app.js').body || '');
  for (const [label, needle] of [
    ['账号状态拉取', '/api/accounts'],
    ['扫码逻辑', 'startAccQr'],
    ['轮询逻辑', 'pollAccQr'],
    ['Cookie 保存', 'saveAccCookie'],
    ['退出登录', 'logoutAcc'],
  ]) {
    ok(label + ' 已实现', js.includes(needle), needle);
  }

  // 4. 样式是否包含登录中心
  const css = (get('/style.css').body || '');
  ok('登录中心样式已加入', css.includes('.acc-layout') && css.includes('.acc-qr'), '.acc-layout / .acc-qr');

  // 5. 接口联动：五处账号都能拿到结构化状态
  const r = spawnSync('node', ['-e', `fetch('${BASE}/api/accounts').then(r=>r.json()).then(j=>console.log(JSON.stringify({ok:j.ok,bili:!!j.data.bilibili,plats:(j.data.platforms||[]).map(p=>p.key)})))`], { encoding: 'utf8', windowsHide: true, timeout: 90000 });
  let acc = {};
  try { acc = JSON.parse((r.stdout || '').trim()); } catch {}
  ok('账号接口返回 B 站 + 四平台', acc.ok === true && acc.bili === true && (acc.plats || []).length === 4, JSON.stringify(acc.plats));

  // 6. 扫码接口对每个支持扫码的平台都能出图
  for (const key of ['netease', 'kugou', 'qq']) {
    const rr = spawnSync('node', ['-e', `fetch('${BASE}/api/login/${key}/qr',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()).then(j=>console.log(JSON.stringify({ok:j.ok,hasKey:!!(j.data&&j.data.key),imgLen:String((j.data&&j.data.base64)||'').length})))`], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    let d = {};
    try { d = JSON.parse((rr.stdout || '').trim()); } catch {}
    ok(key + ' 扫码接口可出二维码', d.ok === true && d.imgLen > 500, 'key=' + d.hasKey + ' 图片 ' + d.imgLen + ' 字符');
  }

  // 7. B 站扫码接口
  const rb = spawnSync('node', ['-e', `fetch('${BASE}/api/bili/qr',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()).then(j=>console.log(JSON.stringify({ok:j.ok,hasKey:!!(j.data&&j.data.key),imgLen:String((j.data&&j.data.base64)||'').length})))`], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  let db = {};
  try { db = JSON.parse((rb.stdout || '').trim()); } catch {}
  ok('B 站扫码接口可出二维码', db.ok === true && db.imgLen > 500, '图片 ' + db.imgLen + ' 字符');

  const failed = results.filter((x) => !x.p);
  console.log('\n===== Web UI 登录中心：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.n).join('；'));
    process.exit(1);
  }
})();
