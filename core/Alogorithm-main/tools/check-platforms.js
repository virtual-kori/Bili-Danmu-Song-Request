/**
 * 四平台逐一验证：只启用单一平台，确认能搜索到并能取得可播放直链。
 * 用法：node Alogorithm-main/tools/check-platforms.js [关键词] [歌手]
 */
const path = require('path');

const BASE = 'http://127.0.0.1:33000';

async function get(p) {
  return (await fetch(BASE + p)).json();
}

// 直接加载适配器（不经过主服务），保持每个平台独立验证
const { NeteaseAdapter } = require('../platforms/netease');
const { QQAdapter } = require('../platforms/qq');
const { KugouAdapter } = require('../platforms/kugou');
const { KuwoAdapter } = require('../platforms/kuwo');
const { probeUrl } = require('../platforms/http');

const PORTS = { netease: 33011, qq: 33012, kugou: 33013, kuwo: 33014 };
const getPlatform = (k) => ({ port: PORTS[k], cookie: '', token: '' });

(async () => {
  // 默认用《卡农》这类各平台都有正规版权的古典曲目来验证四平台。
  // 不要用「周杰伦」这种关键词：网易云没有周杰伦版权，会直接返回空/405，
  // 那样测出来的是版权状况，不是接口可用性。
  // 想指定关键词：node check-platforms.js "卡农 帕赫贝尔"
  const keyword = process.argv[2] || '卡农';
  const adapters = {
    netease: new NeteaseAdapter(() => getPlatform('netease')),
    qq: new QQAdapter(() => getPlatform('qq')),
    kugou: new KugouAdapter(() => getPlatform('kugou')),
    kuwo: new KuwoAdapter(() => getPlatform('kuwo')),
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 直接问本地服务，拿到原始 code（用来区分「限流」和「真的坏」） */
  async function rawCode(port, kw) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/search?keywords=' + encodeURIComponent(kw) + '&limit=5&type=1&timestamp=' + Date.now());
      const j = await res.json();
      return { code: j.code, message: j.message || j.msg || '', count: ((j.result && j.result.songs) || []).length };
    } catch (e) {
      return { code: -1, message: e.message, count: 0 };
    }
  }

  let pass = 0;
  let total = 0;
  let rateLimited = 0;

  for (const key of ['netease', 'qq', 'kugou', 'kuwo']) {
    const a = adapters[key];
    total += 1;
    let searchOk = false;
    let urlOk = false;
    let note = '';
    let list = [];

    // 搜索：失败时最多重试 3 次并逐步加大间隔（应对网易云 405「操作频繁」）
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        list = await a.search(keyword, 10);
      } catch (e) {
        list = [];
      }
      if (list.length) break;
      const raw = key === 'netease' ? await rawCode(33011, keyword) : null;
      if (raw && raw.code === 405) {
        note = '网易云限流中（405 操作频繁），等待 ' + attempt * 6 + ' 秒后重试…';
        console.log('   ⏳ ' + note);
        rateLimited += 1;
        await sleep(attempt * 6000);
      } else if (attempt < 3) {
        await sleep(attempt * 2500);
      } else {
        break;
      }
    }
    note = '搜索 ' + list.length + ' 首';

    if (list.length) {
      // 逐个候选尝试取直链，模拟引擎的「同平台下一候选」策略
      for (const cand of list.slice(0, 5)) {
        const res = await a.resolveUrl(cand);
        if (!res || !res.ok || !res.url) continue;
        const probe = await probeUrl(res.url, { timeoutMs: 12000 });
        if (probe.ok) {
          urlOk = true;
          note += '；命中《' + cand.name + ' - ' + cand.singer + '》[' + (res.qualityLabel || res.quality) + '] 地址可用';
          break;
        }
        note += '；地址不可用（' + (probe.reason || '') + '）';
      }
    } else if (key === 'netease') {
      const raw = await rawCode(33011, keyword);
      note = '搜索 0 首（服务返回 code=' + raw.code + (raw.message ? ' ' + raw.message : '') + '，多为限流，稍后重跑即可）';
    }

    const ok = searchOk || (list.length > 0 && urlOk);
    searchOk = list.length > 0;
    if (searchOk && urlOk) pass += 1;
    console.log((searchOk && urlOk ? '✅' : searchOk ? '⚠️ ' : '❌') + ' ' + key + '  → ' + note);
    await sleep(1200); // 平台之间留点间隔，减少被限流的概率
  }

  console.log('\n===== 四平台：' + pass + '/' + total + ' 平台可搜索且可播放 =====');
  if (rateLimited) console.log('提示：本次遇到 ' + rateLimited + ' 次网易云限流（405），属正常风控，与接口可用性无关。');
  process.exit(pass === total ? 0 : 1);
})().catch((e) => {
  console.error('验证脚本异常：' + (e.stack || e.message));
  process.exit(1);
});
