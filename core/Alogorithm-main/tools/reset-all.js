/**
 * 一键重置：清掉所有用户信息，回到「刚解压」的状态。
 *
 * 清什么：
 *   · 四个平台的登录 Cookie（含酷我/QQ 各自服务里的存档）
 *   · B 站登录态
 *   · 直播间房间号
 *   · 用户改过的规则/开关/播放器路径
 *   · 运行日志与网易云临时缓存
 *
 * 不动什么：程序本体、node_modules、mpv、自带 Node/Python。
 *
 * 「重新获取 Cookie」「重新选弹幕服务器」不需要额外操作：
 *   · Cookie —— 重置后打开 Web UI，扫码或粘贴即可；
 *   · 弹幕服务器 —— 每次连接都会重新实测各节点延迟并自动挑最快的，
 *     所以重置后下次连接就是重新选择。
 *
 * 用法：node core\Alogorithm-main\tools\reset-all.js [--yes]
 *   --yes  跳过确认（给 .bat 用）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const AUTO_YES = process.argv.includes('--yes');

const log = (m) => console.log(m);
const hr = () => log('-'.repeat(62));

/** 需要「重置为初始值」的 JSON 文件 */
const RESET_FILES = [
  {
    rel: 'config.json',
    label: '主配置',
    build: () => ({
      server: { host: '127.0.0.1', port: 33000, openBrowser: true },
      danmaku: {
        enabled: false,
        roomId: 0,
        replyEnabled: true,
        replyPrefix: '【点歌机】',
        replyCooldownMs: 5000,
        reconnectBaseMs: 2000,
        reconnectMaxMs: 60000,
      },
      play: {
        mpvPath: '',
        volume: 80,
        audioDevice: '',
        extraArgs: [],
        streamTimeoutMs: 30000,
        wallClockSlackMs: 30000,
        unknownDurationTimeoutMs: 600000,
      },
      order: {
        prefixes: ['点歌'],
        allowStringPrefixMatch: true,
        userCooldownMs: 60000,
        queueLimit: 50,
        sameSongMaxTimes: 2,
        duplicateStrategy: 'cooldown',
        blacklistUsers: [],
        blacklistWords: [],
        requireDanmakuSwitch: true,
      },
      idle: { enabled: false, source: 'platform', playlistId: '', recommendCount: 20, maxTry: 6 },
      platforms: {
        priority: ['netease', 'qq', 'kugou', 'kuwo'],
        enabled: { netease: true, qq: true, kugou: true, kuwo: true },
      },
      log: { danmaku: true, level: 'info', keepDays: 7 },
    }),
  },
  {
    rel: 'core/platform-ports.json',
    label: '四平台 Cookie',
    build: () => ({
      netease: { label: '网易云音乐', port: 33011, cookie: '', loggedInUser: '' },
      qq: { label: 'QQ音乐', port: 33012, cookie: '', loggedInUser: '' },
      kugou: { label: '酷狗音乐', port: 33013, cookie: '', loggedInUser: '' },
      kuwo: { label: '酷我音乐', port: 33014, cookie: '', token: '', loggedInUser: '' },
    }),
  },
  {
    rel: 'core/Bullet-Screen-Capture/bili-auth.json',
    label: 'B 站登录态',
    build: () => ({ sessdata: '', biliJct: '', buvid3: '', dedeUserId: '', updatedAt: 0 }),
  },
  {
    rel: 'core/kuwoMusicApi/live/data/cookie.json',
    label: '酷我服务端存档',
    build: () => ({ cookie: '', token: '', tokenAt: 0 }),
  },
  {
    rel: 'core/QQMusicApi/live/data/cookie.json',
    label: 'QQ 服务端存档',
    build: () => ({ cookie: '', at: 0 }),
  },
];

/** 直接删掉的目录（运行缓存） */
const PURGE_DIRS = ['core/Alogorithm-main/logs', 'core/tmp'];

function countSecrets() {
  let n = 0;
  for (const f of RESET_FILES) {
    const p = path.join(ROOT, f.rel);
    if (!fs.existsSync(p)) continue;
    let text = '';
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    // 粗略统计「有值」的凭据字段
    const m = text.match(/"(cookie|sessdata|biliJct|musickey|token)"\s*:\s*"[^"]{4,}"/gi) || [];
    n += m.length;
    const room = /"roomId"\s*:\s*(\d+)/.exec(text);
    if (room && Number(room[1]) > 0) n += 1;
  }
  return n;
}

(async () => {
  log('='.repeat(62));
  log('  重置：清除所有用户信息');
  log('='.repeat(62));
  log('目录：' + ROOT);
  log('');

  const before = countSecrets();

  if (!AUTO_YES) {
    log('将要清除：');
    for (const f of RESET_FILES) log('  · ' + f.label + '  (' + f.rel + ')');
    for (const d of PURGE_DIRS) log('  · ' + d + '/  （整个目录）');
    log('');
    log('这会把所有平台登录、房间号、你改过的规则全部清掉，且无法撤销。');
    process.stdout.write('确认继续请输入 yes 回车：');
    const ans = await new Promise((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => {
        buf += c;
        if (buf.includes('\n')) resolve(buf.trim());
      });
      process.stdin.on('end', () => resolve(buf.trim()));
    });
    if (ans.toLowerCase() !== 'yes' && ans.toLowerCase() !== 'y') {
      log('已取消。');
      process.exit(0);
    }
  }

  // 1) 先停掉正在跑的服务，免得它把改动覆盖回去
  log('\n[1/3] 停止正在运行的服务…');
  const stopper = path.join(ROOT, 'core', 'Alogorithm-main', 'tools', 'stop-all.js');
  if (fs.existsSync(stopper)) {
    const r = spawnSync(process.execPath, [stopper], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    const out = ((r.stdout || '') + (r.stderr || '')).trim().split(/\r?\n/).filter(Boolean);
    log('  ' + (out[out.length - 1] || '已完成'));
  } else {
    log('  （找不到 stop-all.js，跳过）');
  }

  // 2) 重置各数据文件
  log('\n[2/3] 清除用户数据…');
  for (const f of RESET_FILES) {
    const p = path.join(ROOT, f.rel);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(f.build(), null, 2) + '\n', 'utf8');
      log('  ✓ ' + f.label);
    } catch (e) {
      log('  ✗ ' + f.label + ' —— ' + e.message);
    }
  }

  // 3) 清运行缓存
  log('\n[3/3] 清除运行缓存…');
  for (const d of PURGE_DIRS) {
    const p = path.join(ROOT, d);
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        log('  ✓ 已删除 ' + d);
      } else {
        log('  · ' + d + ' 本来就没有');
      }
    } catch (e) {
      log('  ✗ ' + d + ' —— ' + e.message);
    }
  }

  const after = countSecrets();

  hr();
  log('  重置完成');
  log('  清除的凭据/房间号字段：' + before + ' → ' + after);
  log('');
  log('  接下来这样做：');
  log('    1. 双击 启动.bat');
  log('    2. 浏览器打开 Web UI → 顶栏「账号登录」→ 重新扫码/粘贴各平台 Cookie');
  log('    3. 右侧「直播间弹幕」重新填房间号 → 点「连接」');
  log('       （连接时会自动重新实测各节点延迟，挑最快的弹幕服务器）');
  hr();

  if (after > 0) {
    log('⚠ 仍有 ' + after + ' 个字段看起来有值，请检查上面的文件。');
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('重置异常：' + (e.stack || e.message));
  process.exit(1);
});
