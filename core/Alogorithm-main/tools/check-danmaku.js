/**
 * 弹幕链路自检工具：房间号解析 → WBI 签名 → getDanmuInfo → WebSocket 收包。
 * 用法：node Alogorithm-main/tools/check-danmaku.js <房间号> [监听秒数]
 */
const { BiliAuth, encWbi, getMixinKey } = require('../../Bullet-Screen-Capture/auth');
const { LiveDanmakuClient } = require('../../Bullet-Screen-Capture/live');
const logger = require('../core/logger').make('danmaku-check');

function assert(name, pass, detail) {
  console.log((pass ? '✅' : '❌') + ' ' + name + (detail ? '  → ' + detail : ''));
  return pass;
}

(async () => {
  // 1) WBI 算法自检（官方文档给出的向量）
  const mixin = getMixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
  assert('WBI mixin_key 算法正确', mixin === 'ea1db124af3c7062474693fa704f4ff8', mixin);

  const auth = new BiliAuth(logger);
  const roomId = Number(process.argv[2] || 1017);
  const seconds = Number(process.argv[3] || 25);

  console.log('--- 登录状态：' + (auth.loggedIn ? '已登录 uid=' + auth.selfUid : '未登录（昵称会被打码）'));

  const client = new LiveDanmakuClient({ roomId, auth, logger });

  // 2) 房间号解析
  try {
    const real = await client.resolveRoomId();
    assert('room_init 解析真实房间号', Boolean(real), roomId + ' → ' + real + '（开播状态 ' + client.liveStatus + '）');
  } catch (e) {
    assert('room_init 解析真实房间号', false, e.message);
    process.exit(1);
  }

  // 3) 取弹幕服务器（老接口 getConf 优先，回退 WBI 版 getDanmuInfo）
  try {
    const info = await client.getDanmuInfo();
    assert(
      '取到弹幕服务器 token 与节点',
      Boolean(info.token),
      '来源=' + (info.from || '?') +
        '，节点数 ' + (info.host_list || []).length +
        '，token 长度 ' + String(info.token).length
    );
  } catch (e) {
    assert('取到弹幕服务器 token 与节点', false, e.message);
    process.exit(1);
  }

  // 4) WebSocket 连接与收包
  let danmakuCount = 0;
  let otherCount = 0;
  let authenticated = false;
  client.on('danmaku', (dm) => {
    danmakuCount += 1;
    if (danmakuCount <= 5) {
      console.log('   [弹幕] ' + (dm.uname || '?') + '（uid ' + dm.uid + '）：' + dm.text);
    }
  });
  client.on('other', () => {
    otherCount += 1;
  });

  const origHandle = client.handlePacket.bind(client);
  client.handlePacket = function (op, proto, body) {
    if (op === 8) authenticated = true;
    return origHandle(op, proto, body);
  };

  client.start().catch(() => {});

  await new Promise((r) => setTimeout(r, seconds * 1000));
  client.stop();

  assert('WebSocket 认证成功', authenticated);
  console.log('--- ' + seconds + ' 秒内收到弹幕 ' + danmakuCount + ' 条，其它事件 ' + otherCount + ' 条');
  assert('能够收到弹幕数据', danmakuCount > 0 || otherCount > 0, danmakuCount > 0 ? '弹幕链路正常' : '仅收到其它事件（房间可能无人发言）');

  process.exit(0);
})().catch((e) => {
  console.error('自检异常：' + (e.stack || e.message));
  process.exit(1);
});
