/**
 * 弹幕服务器自动选点自检。
 *
 * 背景：原来选节点是 `sort(() => Math.random() - 0.5)` —— 纯随机。
 * 广州的机器因此经常连到 zj-cn（浙江）节点，绕路、延迟高、容易丢包。
 * 现在改成并发测 TCP 握手延迟，按快慢依次尝试。
 *
 * 用法：node core\Alogorithm-main\tools\check-danmaku-host.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const livePath = path.join(ROOT, 'core', 'Bullet-Screen-Capture', 'live.js');
const live = require(livePath);

const results = [];
const ok = (n, p, d) => {
  results.push({ n, p });
  console.log((p ? '✅ ' : '❌ ') + n + (d ? '  → ' + d : ''));
};

(async () => {
  console.log('=== 1) 源码：不能再有随机选点 ===');
  const src = fs.readFileSync(livePath, 'utf8');
  // 只看「代码行」，忽略注释里提到旧写法的情况
  const codeLines = src
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  ok(
    '没有 Math.random 打乱节点列表',
    !/sort\(\s*\(\s*\)\s*=>\s*Math\.random/.test(codeLines),
    '（注释里提到旧写法不算）'
  );
  ok('存在延迟探测函数', /function probeTcpLatency/.test(src), '');
  ok('存在按延迟排序函数', /async function rankHostsByLatency/.test(src), '');
  ok('连接前会先排序', /await rankHostsByLatency\(/.test(src), '');
  ok('日志会打印选中的节点', /选用弹幕节点/.test(src), '');
  ok('支持用环境变量固定节点', /BILI_DANMAKU_HOST/.test(src), '');

  console.log('\n=== 2) 延迟探测本身是否可用 ===');
  const t0 = Date.now();
  const ms = await live.probeTcpLatency('broadcastlv.chat.bilibili.com', 443, 5000);
  const usable = Number.isFinite(ms);
  ok('能测出真实延迟', usable, usable ? ms + 'ms（耗时 ' + (Date.now() - t0) + 'ms）' : '超时/失败');

  console.log('\n=== 3) 排序是否真的按快慢来 ===');
  {
    const hosts = [
      { host: 'broadcastlv.chat.bilibili.com', wss_port: 443 },
      // 一个一定连不上的地址，应当被**剔除**（rankHostsByLatency 会过滤掉不可达的）
      { host: 'this-host-does-not-exist-12345.invalid', wss_port: 443 },
    ];
    const ranked = await live.rankHostsByLatency(hosts, null, 5);
    const names = ranked.map((h) => h.host);
    ok('可达节点排第一', names[0] === 'broadcastlv.chat.bilibili.com', names.join(' → ') || '（空）');
    ok('不可达节点被剔除，不会拿去连', !names.some((h) => /invalid|example/i.test(h)), names.join(' → '));
  }

  console.log('\n=== 4) 真的连一次：选中的应当是可解析的真实节点 ===');
  {
    const room = Number(process.argv[2] || 21452505);
    let chosen = '';
    let danmaku = 0;
    const client = new live.LiveDanmakuClient({
      roomId: room,
      logger: { info: (m) => { if (/选用弹幕节点/.test(m)) chosen = m; }, warn() {}, error() {}, debug() {} },
    });
    client.on('danmaku', () => {
      danmaku += 1;
    });
    // 注意：start() 内部是「自动重连」的无限循环，**永远不会 resolve**，
    // 所以这里绝不能 await —— 否则自检会一直挂着（踩过这个坑）。
    client.start().catch(() => {});
    await new Promise((r) => setTimeout(r, 12000));
    try {
      client.stop();
    } catch {
      /* ignore */
    }
    const m = /选用弹幕节点 (\S+?)(?:（|$)/.exec(chosen);
    ok('确实选出了一个节点', Boolean(m), m ? m[1] : chosen || '（没打印）');
    if (m) {
      const host = m[1];
      const reachable = await live.probeTcpLatency(host, 443, 4000);
      ok('选中的节点是可达的真实主机', Number.isFinite(reachable), host + ' ' + (Number.isFinite(reachable) ? reachable + 'ms' : '不可达'));
      ok('不是被随机塞的无效域名', !/invalid|example/i.test(host), host);
    }
    console.log('   （12 秒内收到 ' + danmaku + ' 条弹幕，仅作参考，房间没人说话时为 0）');
  }

  const failed = results.filter((r) => !r.p);
  console.log('\n===== 弹幕选点自检：' + (results.length - failed.length) + '/' + results.length + ' 项通过 =====');
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.n).join('；'));
    process.exit(1);
  }
  // 显式退出：上面拉起的连接/定时器可能让事件循环一直有活干
  process.exit(0);
})().catch((e) => {
  console.error('自检异常：' + (e.stack || e.message));
  process.exit(1);
});
