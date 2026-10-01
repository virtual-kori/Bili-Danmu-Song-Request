/**
 * QQ 音乐「微信扫码」诊断工具。
 *
 * 用途：扫码后拿不到 Cookie 时，用它跑一遍并查看服务端的原始返回，
 *      就能判断是「没绑定」/「被风控」/「参数不对」还是「时序问题」。
 *
 * 用法：node core\Alogorithm-main\tools\debug-qq-wx.js
 *   1) 终端会打印二维码（同时存 PNG 并弹窗）
 *   2) 用手机微信扫码并在手机上点确认
 *   3) 本脚本会把每一步的原始返回打印出来
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const QQ_LIVE = path.join(ROOT, 'core', 'QQMusicApi', 'live');
const wx = require(path.join(QQ_LIVE, 'wechat-login'));
const qrUtil = require('./qr-util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT_SEC = Number(process.argv[2] || 180);

function line() {
  return '='.repeat(62);
}

(async () => {
  console.log('\n' + line());
  console.log('  QQ 音乐 · 微信扫码 诊断');
  console.log(line());

  console.log('\n[1/4] 申请二维码…');
  let sess;
  try {
    sess = await wx.createWxQr();
  } catch (e) {
    console.error('  ✗ 申请失败：' + e.message);
    process.exit(1);
  }
  console.log('  ✓ uuid = ' + sess.uuid);
  console.log('  二维码页面：' + sess.pageUrl.slice(0, 100) + '…');
  console.log('  二维码图片：' + (sess.qrBase64 ? sess.qrBase64.length + ' 字符（base64 JPEG）' : '未取到'));

  // 终端里画一张
  try {
    await qrUtil.printTerminal('https://open.weixin.qq.com/connect/qrcode/' + sess.uuid);
  } catch {
    /* 终端画不出就算了 */
  }
  // 存图并弹出来
  if (sess.qrBase64) {
    try {
      const file = path.join(ROOT, 'core', 'Alogorithm-main', 'logs', 'qq-wx-login.png');
      const base64 = sess.qrBase64.split(',')[1];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(base64, 'base64'));
      console.log('  二维码图片已保存：' + file);
      qrUtil.openImage(file);
    } catch (e) {
      console.log('  （存图失败：' + e.message + '）');
    }
  }

  console.log('\n[2/4] 请用【手机微信 → 扫一扫】扫描二维码，并在手机上点「确认登录」');
  console.log('      等待中（最多 ' + TIMEOUT_SEC + ' 秒）…');

  const deadline = Date.now() + TIMEOUT_SEC * 1000;
  let code = '';
  let last = null;
  while (Date.now() < deadline) {
    let st;
    try {
      st = await wx.pollWxQr(sess.uuid);
    } catch (e) {
      console.log('  ! 轮询出错：' + e.message);
      await sleep(2000);
      continue;
    }
    if (st.status !== last) {
      console.log('  状态 ' + st.status + ' → ' + st.message);
      last = st.status;
    }
    if (st.status === 405) {
      code = st.code;
      break;
    }
    if (st.terminal && st.status !== 405) {
      console.error('\n  ✗ 流程终止：' + st.message);
      process.exit(1);
    }
  }

  if (!code) {
    console.error('\n  ✗ 等待超时，没有拿到微信授权码');
    process.exit(1);
  }

  console.log('\n[3/4] ✓ 拿到微信授权码（' + code.length + ' 字符）');
  console.log('      正在向 QQ 音乐换取登录凭证…');

  const ex = await wx.exchangeWxCode(code);

  console.log('\n[4/4] 换取结果');
  console.log('  成功与否：' + (ex.ok ? '✓ 成功' : '✗ 失败'));
  console.log('  说明    ：' + (ex.error || '（无）'));
  console.log('  步骤    ：' + (ex.steps || []).join('  →  '));
  console.log('  音乐号  ：' + (ex.musicid || '（无）'));
  if (ex.cookie) {
    console.log('  Cookie  ：' + ex.cookie.slice(0, 120) + (ex.cookie.length > 120 ? '…' : ''));
  }
  console.log('\n  服务端原始返回：');
  console.log('  ' + (ex.raw || '（空）'));

  console.log('\n' + line());
  if (ex.ok) {
    console.log('  结论：成功。把上面的 Cookie 粘到 Web UI 的「粘贴 Cookie」里即可。');
  } else {
    console.log('  结论：失败。请把「服务端原始返回」这段发给开发者定位。');
    console.log('  常见原因：');
    console.log('    · 20274 账号绑定缺失 —— 这个微信号没绑定过 QQ 音乐');
    console.log('    · 1000 / 104401 登录态已失效 —— 授权码被用过或已过期，重跑一次');
    console.log('    · 104604 频率限制 —— 等几分钟再试');
    console.log('    · 20279 设备数超限 —— 去 QQ 音乐里踢掉一些登录设备');
  }
  console.log(line() + '\n');
  process.exit(ex.ok ? 0 : 1);
})().catch((e) => {
  console.error('诊断脚本异常：' + (e.stack || e.message));
  process.exit(1);
});
