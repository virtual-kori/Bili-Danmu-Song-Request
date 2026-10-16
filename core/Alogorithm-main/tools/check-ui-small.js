/**
 * 小窗（窄屏）UI 体检。
 *
 * 背景：`.columns` 在桌面端有固定高度 `min(680px, calc(100vh - 190px))`，
 * 三列并排时正好撑满一屏。但 ≤1180px 会堆成一列，这个固定高度仍然生效，
 * 于是「一个固定高的网格塞三张卡片」→ 行高被压缩 → 卡片溢出自己的行
 * → 歌词卡和弹幕卡叠在一起、按钮压按钮。
 *
 * 这个脚本用真实浏览器在多个宽度下量几何，确保不会再退化：
 *   · 页面不能出现横向溢出
 *   · 同级卡片不能互相重叠
 *   · 按钮之间必须有正的垂直间距（不能叠）
 *   · 不能有元素被挤出视口左右边界
 *
 * 用法：node core\Alogorithm-main\tools\check-ui-small.js [--keep-shots]
 *   需要主服务已在 http://127.0.0.1:33000 运行。
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const URL_BASE = 'http://127.0.0.1:33000/';
const PORT = 9280;
const SHOTS = path.join(__dirname, '_ui-small-shots');
const KEEP = process.argv.includes('--keep-shots');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const WIDTHS = [1440, 1180, 1000, 900, 800, 760, 700, 600, 560, 520, 480, 420, 360, 320];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpJson(u) {
  return new Promise((res, rej) => {
    http.get(u, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => {
        try {
          res(JSON.parse(d));
        } catch (e) {
          rej(e);
        }
      });
    }).on('error', rej);
  });
}

const results = [];
const ok = (n, p, d) => {
  results.push({ n, p });
  console.log((p ? '✅ ' : '❌ ') + n + (d ? '  → ' + d : ''));
};

/** 页面内探针：只挑可见的「叶子卡片」，排除父子包含关系 */
const PROBE = `(function(){
  var out = { vw: innerWidth, sw: document.documentElement.scrollWidth, issues: [] };
  var CARD = '.card, .switch, .now, .mini, .modal-card, .cand-col, .acc-section, .btn, .pill, .field';
  function visible(e){
    var cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    var r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function rect(e){ var r = e.getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height, bottom:r.bottom }; }
  function nm(e){
    var cls = (e.className||'').toString().trim().split(/\\s+/).slice(0,2).join('.');
    return e.tagName.toLowerCase() + (cls?'.'+cls:'') + (e.id?'#'+e.id:'');
  }
  var all = Array.prototype.slice.call(document.querySelectorAll(CARD));
  var leaves = all.filter(function(e){ return !e.querySelector(CARD) && visible(e); });

  if (out.sw > out.vw + 1) out.issues.push('页面横向溢出 scrollWidth=' + out.sw + ' > ' + out.vw);

  for (var i=0;i<leaves.length;i++){
    for (var j=i+1;j<leaves.length;j++){
      var A=leaves[i], B=leaves[j];
      if (A.contains(B) || B.contains(A)) continue;
      var a=rect(A), b=rect(B);
      var ox = Math.max(0, Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x, b.x));
      var oy = Math.max(0, Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y));
      var ov = ox*oy, minA = Math.min(a.w*a.h, b.w*b.h);
      if (minA>0 && ov/minA > 0.12) out.issues.push('卡片重叠 ' + nm(A) + ' × ' + nm(B) + ' ' + Math.round(ov/minA*100) + '%');
    }
  }

  leaves.forEach(function(e){
    var r = rect(e), n = nm(e);
    if (r.x < -1) out.issues.push(n + ' 左越界 x=' + Math.round(r.x));
    if (r.x + r.w > out.vw + 1) out.issues.push(n + ' 右越界 ' + Math.round(r.x+r.w) + ' > ' + out.vw);
  });

  // 关键按钮之间的垂直间距（负值 = 叠在一起）
  // 注意：只有两个按钮**水平位置重叠**时，比较垂直间距才有意义。
  // 宽屏下它们分属左右两栏，垂直坐标天然不同，不能当成重叠。
  var pairs = [
    ['btnChatClear','btnLyricToggle'],
    ['btnClearChat','btnLyricExpand']
  ];
  pairs.forEach(function(p){
    var a = document.getElementById(p[0]), b = document.getElementById(p[1]);
    if (!a || !b) return;
    if (!visible(a) || !visible(b)) return;
    var ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    var hOverlap = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
    if (hOverlap < Math.min(ra.width, rb.width) * 0.5) return; // 不在同一竖列，跳过
    var gap = rb.top - ra.bottom;
    if (gap < -1) out.issues.push('按钮重叠 ' + p[0] + ' 与 ' + p[1] + '（间距 ' + Math.round(gap) + 'px）');
  });

  // 卡片不能溢出自己的网格行（这是本次 bug 的直接症状）
  var cols = document.querySelector('.columns');
  if (cols) {
    var colBox = cols.getBoundingClientRect();
    Array.prototype.forEach.call(cols.children, function(ch){
      var r = ch.getBoundingClientRect();
      if (r.height > colBox.height + 2 && r.bottom > colBox.bottom + 2) {
        out.issues.push('列内容溢出 .columns 容器（' + nm(ch) + ' 底 ' + Math.round(r.bottom) + ' > 容器底 ' + Math.round(colBox.bottom) + '）');
      }
    });
  }
  return JSON.stringify(out);
})()`;

(async () => {
  const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!edge) {
    console.log('⚠ 找不到 Edge/Chrome，跳过小窗 UI 体检');
    process.exit(0);
  }

  // 主服务必须先起来
  try {
    const r = await fetch(URL_BASE + 'style.css');
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    console.log('⚠ 主服务未运行（' + URL_BASE + '），跳过小窗 UI 体检：' + e.message);
    process.exit(0);
  }

  if (KEEP) fs.mkdirSync(SHOTS, { recursive: true });
  const profile = path.join(process.env.TEMP || __dirname, 'dgj-ui-small');
  fs.rmSync(profile, { recursive: true, force: true });
  const child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`, '--window-size=1440,1000', URL_BASE], { stdio: 'ignore', windowsHide: true });

  try {
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      await sleep(500);
      try {
        const l = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
        page = (l || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch {
        /* 还没起来 */
      }
    }
    if (!page) throw new Error('无法连接浏览器调试端口');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    let id = 0;
    const pending = new Map();
    const errs = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errs.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
    });
    const send = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (x) => {
      const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
      return r.result && r.result.result && r.result.result.value;
    };
    await send('Runtime.enable', {});
    await send('Page.enable', {});
    await sleep(9000);

    let bad = 0;
    for (const w of WIDTHS) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(700);
      const info = JSON.parse(await ev(PROBE));
      if (info.issues.length) {
        bad += 1;
        ok(w + 'px 无布局问题', false, info.issues.slice(0, 3).join(' ； '));
      } else {
        ok(w + 'px 无布局问题', true, 'scrollW=' + info.sw);
      }
      if (KEEP && [1440, 1180, 760, 520, 360].includes(w)) {
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(SHOTS, 'w' + w + '.png'), Buffer.from(shot.result.data, 'base64'));
      }
    }
    ok('窄屏下无 JS 异常', errs.length === 0, errs.length ? errs.slice(0, 2).join(' | ') : '0 个');
    ws.close();
  } finally {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    // 浏览器进程可能还没退干净，删 profile 失败不算错
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.p);
  console.log('\n===== 小窗 UI 体检：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.n).join('；'));
    process.exit(1);
  }
})().catch((e) => {
  console.error('小窗 UI 体检异常：' + (e.stack || e.message));
  process.exit(1);
});
