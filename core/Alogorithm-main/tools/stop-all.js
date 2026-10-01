/**
 * 停止点歌机及其全部子进程（四个平台 API、MPV）。
 * 通过端口定位进程，避免误杀其它 node 进程。
 */
const { execFile } = require('child_process');

const PORTS = [33000, 33011, 33012, 33013, 33014];

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1e7 }, (err, stdout) => resolve({ err, stdout: stdout || '' }));
  });
}

async function pidsOnPort(port) {
  const { stdout } = await run('netstat', ['-ano']);
  const pids = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes(':' + port + ' ')) continue;
    if (!/LISTENING/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
  }
  return [...pids];
}

(async () => {
  let killed = 0;
  // 先按端口结束四个平台服务和主服务
  for (const port of PORTS) {
    const pids = await pidsOnPort(port);
    for (const pid of pids) {
      const r = await run('taskkill', ['/PID', pid, '/T', '/F']);
      console.log('端口 ' + port + ' → 结束进程 ' + pid + (r.err ? '（' + r.err.message + '）' : ' 成功'));
      killed += 1;
    }
  }

  // 兜底：结束时可能残留的 mpv（正常退出时不会有）
  const r1 = await run('taskkill', ['/IM', 'mpv.exe', '/F']);
  if (!r1.err) {
    console.log('已结束残留的 mpv 进程');
    killed += 1;
  }

  // 再兜底：任何仍在监听主端口的点歌机进程（可能已被上面的 /T 处理）
  await new Promise((r) => setTimeout(r, 800));
  for (const port of PORTS) {
    for (const pid of await pidsOnPort(port)) {
      await run('taskkill', ['/PID', pid, '/T', '/F']);
      console.log('二次清理：端口 ' + port + ' → 结束进程 ' + pid);
      killed += 1;
    }
  }

  if (killed === 0) console.log('未发现正在运行的点歌机服务（端口 ' + PORTS.join('/') + ' 均无监听）');
  else console.log('停止完成');
})().catch((e) => {
  console.error('停止失败：' + e.message);
  process.exit(1);
});
