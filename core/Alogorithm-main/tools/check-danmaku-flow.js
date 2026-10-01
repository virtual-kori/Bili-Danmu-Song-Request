/**
 * 弹幕点歌链路验收：指令解析 → 黑名单/冷却/队列上限 → 四平台匹配 → 入队 → 回复文案。
 * 用法：node Alogorithm-main/tools/check-danmaku-flow.js
 */
const cfgMod = require('../core/config');
const logger = require('../core/logger');
const { Engine } = require('../core/engine');
const { NeteaseAdapter } = require('../platforms/netease');
const { QQAdapter } = require('../platforms/qq');
const { KugouAdapter } = require('../platforms/kugou');
const { KuwoAdapter } = require('../platforms/kuwo');
const { parseSongRequest, normalizeForCompare } = require('../../Bullet-Screen-Capture/parse');
const { rankCandidates } = require('../core/matcher');

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass });
  console.log((pass ? '✅' : '❌') + ' ' + name + (detail ? '  → ' + detail : ''));
}

(async () => {
  // ---------------- 第一部分：指令解析（纯逻辑） ----------------
  const cases = [
    ['点歌 夜曲', { name: '夜曲', singer: '' }],
    ['点歌 夜曲 周杰伦', { name: '夜曲', singer: '周杰伦' }],
    ['点歌：夜曲 周杰伦', { name: '夜曲', singer: '周杰伦' }],
    ['点歌，夜曲，周杰伦', { name: '夜曲', singer: '周杰伦' }],
    ['点歌　夜曲　周杰伦', { name: '夜曲', singer: '周杰伦' }],
    ['  点歌   晴天   周杰伦  ', { name: '晴天', singer: '周杰伦' }],
    ['点歌以父之名', { name: '以父之名', singer: '' }],
    ['点歌 告白气球》', { name: '告白气球', singer: '' }],
    ['点歌 起风了 买辣椒也用券', { name: '起风了', singer: '买辣椒也用券' }],
  ];
  let parsePass = 0;
  for (const [text, expect] of cases) {
    const r = parseSongRequest(text, { prefixes: ['点歌'] });
    const pass = r.ok && r.name === expect.name && (r.singer || '') === expect.singer;
    if (pass) parsePass += 1;
    else console.log('   ❌ 解析失败：' + JSON.stringify(text) + ' → ' + JSON.stringify(r));
  }
  ok('点歌指令解析（' + cases.length + ' 种写法）', parsePass === cases.length, parsePass + '/' + cases.length);

  const nonCommands = ['你好', '这首歌真好听', '点个歌', '', '   ', '点歌', '点歌：'];
  let rejectPass = 0;
  for (const t of nonCommands) {
    const r = parseSongRequest(t, { prefixes: ['点歌'] });
    if (!r.ok) rejectPass += 1;
    else console.log('   ❌ 不应被识别为点歌：' + JSON.stringify(t) + ' → ' + JSON.stringify(r));
  }
  ok('非点歌弹幕被正确忽略（' + nonCommands.length + ' 条）', rejectPass === nonCommands.length, rejectPass + '/' + nonCommands.length);

  const norm = normalizeForCompare('夜曲 (Live)【原唱】');
  ok('歌名清洗（去括号/后缀/大小写）', norm === '夜曲原唱' || norm.includes('夜曲'), '夜曲 (Live)【原唱】 → ' + norm);

  // ---------------- 第二部分：匹配打分 ----------------
  const req = { name: '夜曲', singer: '周杰伦' };
  const cands = [
    { platform: 'netease', name: '夜曲（Cover）', singer: '武钟旭' },
    { platform: 'qq', name: '夜曲', singer: '周杰伦' },
    { platform: 'kugou', name: '夜曲', singer: '周杰伦' },
    { platform: 'kuwo', name: '夜曲 (Live)', singer: '周杰伦' },
    { platform: 'netease', name: '夜曲', singer: '阿杰' },
    { platform: 'qq', name: '晴天', singer: '周杰伦' },
  ];
  const { ranked } = rankCandidates(req, cands, ['netease', 'qq', 'kugou', 'kuwo']);
  ok(
    '匹配优先「歌名+歌手完全一致」且按平台优先级取首',
    ranked[0].name === '夜曲' && ranked[0].singer === '周杰伦' && ranked[0].platform === 'qq' && ranked[0].tier === 1,
    ranked[0].platform + ' / ' + ranked[0].name + ' - ' + ranked[0].singer + ' [' + ranked[0].tierName + ']'
  );

  const { ranked: ranked2 } = rankCandidates({ name: '夜曲', singer: '' }, [
    { platform: 'netease', name: '夜曲', singer: '阿杰' },
    { platform: 'qq', name: '夜曲', singer: '周杰伦' },
  ], ['netease', 'qq']);
  ok('未给歌手时按平台优先级取完全同名', ranked2[0].platform === 'netease', ranked2[0].platform + ' / ' + ranked2[0].name);

  // ---------------- 第三部分：引擎全链路（真实搜索，仅测试不出声） ----------------
  const config = JSON.parse(JSON.stringify(cfgMod.config));
  const getPlatform = (k) => cfgMod.platforms[k] || {};
  const adapters = {
    netease: new NeteaseAdapter(() => getPlatform('netease')),
    qq: new QQAdapter(() => getPlatform('qq')),
    kugou: new KugouAdapter(() => getPlatform('kugou')),
    kuwo: new KuwoAdapter(() => getPlatform('kuwo')),
  };
  const engine = new Engine({ config, adapters, saveConfig: () => {} });
  engine.player.mpvPath = 'mpv-not-used.exe'; // 只测到「准备播放」为止，不真的起 mpv

  const replies = [];
  engine.setReplyHandler(async (text) => {
    replies.push(text);
  });
  // 阻止真正调用播放器
  engine.playItem = async (item) => {
    engine.phase = 'PLAYING';
    engine.current = item;
    engine.broadcast();
    return { ok: true };
  };

  const dm = (text, uname, uid) => engine.handleDanmaku({ text, uname: uname || '测试观众', uid: uid || 1001 });

  // 1. 正常点歌
  let r = await dm('点歌 夜曲 周杰伦', '小明', 1001);
  ok('弹幕点歌成功入队', r.ok === true, r.ok ? r.matched.name + ' - ' + r.matched.singer + '（' + r.matched.platformLabel + '，' + r.tierName + '）' : JSON.stringify(r));
  ok('回复「已加入点歌列表」', replies.some((t) => t.includes('已加入点歌列表')), replies[replies.length - 1]);

  // 2. 同用户冷却
  r = await dm('点歌 晴天 周杰伦', '小明', 1001);
  ok('同用户冷却生效并回复原因', r.ok === false && r.reason === 'cooldown', replies[replies.length - 1]);

  // 3. 换用户点另一首
  r = await dm('点歌 稻香 周杰伦', '小红', 1002);
  ok('不同用户可继续点歌', r.ok === true, r.ok ? r.matched.name : JSON.stringify(r));

  // 4. 关闭弹幕点歌开关
  engine.config.danmaku.enabled = false;
  r = await dm('点歌 青花瓷 周杰伦', '小刚', 1003);
  ok('关闭开关后弹幕点歌被拒绝', r.ok === false && r.reason === 'switch-off', replies[replies.length - 1]);
  engine.config.danmaku.enabled = true;

  // 5. 黑名单关键词
  engine.config.order.blacklistWords = ['测试禁词'];
  r = await dm('点歌 测试禁词 某人', '小刚', 1003);
  ok('关键词黑名单生效', r.ok === false && r.reason === 'blacklist-word', replies[replies.length - 1]);
  engine.config.order.blacklistWords = [];

  // 6. 用户黑名单
  engine.config.order.blacklistUsers = ['坏用户'];
  r = await dm('点歌 青花瓷', '坏用户', 1004);
  ok('用户黑名单生效', r.ok === false && r.reason === 'blacklist-user', replies[replies.length - 1]);
  engine.config.order.blacklistUsers = [];

  // 7. 队列上限
  const savedLimit = engine.config.order.queueLimit;
  engine.config.order.queueLimit = engine.queue.length;
  r = await dm('点歌 青花瓷 周杰伦', '小刚', 1003);
  ok('队列上限生效', r.ok === false && r.reason === 'queue-reject', replies[replies.length - 1]);
  engine.config.order.queueLimit = savedLimit;

  // 8. 重复歌曲策略（先把「晴天」放进队列，再用去重策略点同一首）
  engine.config.order.duplicateStrategy = 'reject';
  const dupRes = await dm('点歌 晴天 周杰伦', '铺垫用户', 2000);
  const dupRes2 = await dm('点歌 晴天 周杰伦', '新用户', 2001);
  ok(
    '重复歌曲去重策略生效',
    dupRes.ok === true && dupRes2.ok === false && dupRes2.reason === 'queue-reject',
    replies[replies.length - 1]
  );
  engine.config.order.duplicateStrategy = 'cooldown';
  engine.queue.remove(dupRes.item && dupRes.item.id);

  // 9. 未找到歌曲（关键词与任何搜索结果都不相似）
  r = await dm('点歌 qwzxplm 阿斯顿法国红酒', '小刚', 1003);
  ok('未找到歌曲时给出明确提示', r.ok === false, replies[replies.length - 1]);

  // 10. 只处理点歌弹幕
  const before = replies.length;
  r = await dm('主播好听', '路人', 3001);
  ok('普通弹幕不触发入队与回复', r.ok === false && r.reason === 'not-command' && replies.length === before, '队列长度 ' + engine.queue.length);

  // 11. 「点歌」后无内容时的提示
  r = await dm('点歌', '路人', 3002);
  ok('只说「点歌」时提示格式', r.ok === false && r.reason === 'no-keyword', replies[replies.length - 1]);

  // 队列最终状态
  console.log('\n队列内容：' + engine.queue.sorted().map((q) => q.name + '/' + q.singer + '(' + q.platformLabel + ')').join('，'));

  const failed = results.filter((x) => !x.pass);
  console.log('\n===== 弹幕链路：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('；'));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('验收异常：' + (e.stack || e.message));
  process.exit(1);
});
