/**
 * MPV 播放器控制器。
 *
 * 设计要点（对应需求 5「不常驻播放进程」）：
 *  - 每首歌启动一个独立的 mpv 进程，播放结束或切歌后必定关闭并回收；
 *  - 通过命名管道（Windows）使用 mpv 的 JSON IPC 协议控制与监听；
 *  - 每次启动使用唯一管道名，避免快速重启时的管道冲突；
 *  - 「播放结束」以 end-file reason=eof 为主判据，另有 idle-active / eof-reached
 *    与墙钟超时三层兜底，确保不会永久挂起。
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const logger = require('./logger').make('mpv');

const PIPE_PREFIX = 'diankeji-mpv-';

/**
 * 在若干候选位置里找到 mpv.exe。
 *
 * 全部用相对路径推导，不写死任何机器上的绝对路径，方便整个文件夹随便挪：
 *   1. config.json 里显式指定的路径
 *   2. core/mpv.exe（本项目自带的便携版，首选）
 *   3. 点歌机/mpv.exe（根目录放一份也行）
 *   4. Alogorithm-main/mpv.exe
 *   5. 环境变量 MPV_PATH 指向的可执行文件
 *   6. 交给系统 PATH（直接写 mpv.exe）
 */
function resolveMpvPath(configured) {
  const coreDir = path.resolve(__dirname, '..', '..'); // 点歌机/core
  const rootDir = path.resolve(coreDir, '..'); // 点歌机/
  const candidates = [];
  if (configured) candidates.push(configured);
  candidates.push(path.join(coreDir, 'mpv.exe'));
  candidates.push(path.join(rootDir, 'mpv.exe'));
  candidates.push(path.resolve(__dirname, '..', 'mpv.exe'));
  if (process.env.MPV_PATH) candidates.push(process.env.MPV_PATH);
  candidates.push('mpv.exe');
  for (const c of candidates) {
    try {
      if (c === 'mpv.exe') return c; // 交给 PATH
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return 'mpv.exe';
}

class MpvPlayer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.mpvPath = resolveMpvPath(options.mpvPath);
    this.volume = options.volume == null ? 80 : options.volume;
    this.audioDevice = options.audioDevice || '';
    this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    this.streamTimeoutMs = options.streamTimeoutMs || 30000;
    this.wallClockSlackMs = options.wallClockSlackMs || 30000;
    this.unknownDurationTimeoutMs = options.unknownDurationTimeoutMs || 600000;

    this.child = null;
    this.socket = null;
    this.pipePath = '';
    this.buffer = '';
    this.reqId = 1;
    this.pending = new Map();

    this.state = 'closed'; // closed | starting | playing | paused | stopping
    this.current = null; // 当前歌曲队列项
    this.position = 0;
    this.duration = 0;
    this.eofTimer = null;
    this.wallTimer = null;
    this.loadTimer = null;
    this.sawEof = false;
    this.stopReason = null;
  }

  isRunning() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(150, Number(v) || 0));
    if (this.socket && !this.socket.destroyed) this.send(['set_property', 'volume', this.volume]);
  }

  /**
   * 播放一首歌。会先确保上一次的进程已完全退出。
   * @param {object} item 队列项，必须含 url
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async play(item) {
    await this.stop('switch');
    if (!item || !item.url) return { ok: false, error: '缺少播放地址' };

    this.current = item;
    this.position = 0;
    this.duration = item.duration ? item.duration / 1000 : 0;
    this.sawEof = false;
    this.stopReason = null;
    this.state = 'starting';
    this.emit('state', this.snapshot());

    const pipeName = PIPE_PREFIX + process.pid + '-' + crypto.randomBytes(6).toString('hex');
    this.pipePath = '\\\\.\\pipe\\' + pipeName;

    const args = [
      '--input-ipc-server=' + this.pipePath,
      '--no-config',
      '--idle=yes',
      '--no-video',
      '--force-window=no',
      '--no-terminal',
      '--really-quiet',
      '--audio-display=no',
      '--no-resume-playback',
      '--no-save-position-on-quit',
      '--keep-open=no',
      '--volume=' + this.volume,
    ];
    if (this.audioDevice) args.push('--audio-device=' + this.audioDevice);
    args.push(...this.extraArgs);

    logger.info('启动 mpv: ' + this.mpvPath + ' (' + item.name + ' - ' + item.singer + ')');
    try {
      this.child = spawn(this.mpvPath, args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } catch (e) {
      this.state = 'closed';
      this.current = null;
      this.emit('state', this.snapshot());
      return { ok: false, error: '无法启动 mpv：' + e.message };
    }

    let spawnError = null;
    this.child.on('error', (e) => {
      spawnError = e;
      logger.error('mpv 进程错误: ' + e.message);
      this.handleExit('spawn-error');
    });
    this.child.on('exit', (code) => {
      logger.info('mpv 进程退出，code=' + code);
      this.handleExit('exit');
    });

    // 连接 IPC（重试，等待 mpv 把管道建出来）
    let socket;
    try {
      socket = await this.connectWithRetry(this.pipePath, 8000);
    } catch (e) {
      const msg = spawnError ? spawnError.message : e.message;
      await this.stop('connect-failed');
      return { ok: false, error: '连接 mpv 控制管道失败：' + msg + '（请确认 mpvPath 指向有效的 mpv.exe）' };
    }
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (e) => {
      if (this.state !== 'closed' && this.state !== 'stopping') logger.warn('mpv socket 错误: ' + e.message);
    });
    socket.on('close', () => {
      /* 退出流程由 child exit 统一处理 */
    });

    // 注册属性监听
    const props = ['time-pos', 'duration', 'pause', 'media-title', 'eof-reached', 'idle-active'];
    props.forEach((p, i) => this.send(['observe_property', i + 1, p]));

    // 加载播放地址（必须 percent-encode）
    this.send(['loadfile', encodeURI(item.url), 'replace']);

    this.loadTimer = setTimeout(async () => {
      if (this.state === 'starting') {
        logger.warn('播放地址加载超时（' + this.streamTimeoutMs + 'ms），按失败处理');
        await this.stop('load-timeout');
        this.emit('finished', { item, reason: 'load-timeout' });
      }
    }, this.streamTimeoutMs);

    this.wallTimer = setTimeout(async () => {
      if (this.state === 'playing' || this.state === 'paused' || this.state === 'starting') {
        logger.warn('墙钟超时，强制结束当前播放');
        await this.stop('wall-timeout');
        this.emit('finished', { item, reason: 'wall-timeout' });
      }
    }, this.computeWallTimeout());

    return { ok: true };
  }

  computeWallTimeout() {
    const dur = this.duration > 0 ? this.duration * 1000 : this.unknownDurationTimeoutMs;
    return Math.max(this.streamTimeoutMs, dur + this.wallClockSlackMs);
  }

  connectWithRetry(pipePath, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const socket = net.connect({ path: pipePath });
        const onError = (e) => {
          socket.removeListener('connect', onConnect);
          socket.destroy();
          if (Date.now() > deadline) return reject(e);
          setTimeout(attempt, 80);
        };
        const onConnect = () => {
          socket.removeListener('error', onError);
          resolve(socket);
        };
        socket.once('error', onError);
        socket.once('connect', onConnect);
      };
      attempt();
    });
  }

  send(command) {
    if (!this.socket || this.socket.destroyed) return -1;
    const id = this.reqId++;
    try {
      this.socket.write(JSON.stringify({ command, request_id: id }) + '\n');
    } catch (e) {
      logger.warn('发送 IPC 命令失败: ' + e.message);
      return -1;
    }
    return id;
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.handleMessage(msg);
    }
  }

  handleMessage(msg) {
    if (msg.event === 'property-change') {
      switch (msg.name) {
        case 'time-pos':
          if (typeof msg.data === 'number') {
            this.position = msg.data;
            this.emit('progress', { position: this.position, duration: this.duration });
          }
          break;
        case 'duration':
          if (typeof msg.data === 'number' && msg.data > 0) {
            this.duration = msg.data;
            clearTimeout(this.wallTimer);
            this.wallTimer = setTimeout(async () => {
              if (this.state === 'playing' || this.state === 'paused') {
                logger.warn('墙钟超时（按已知时长），强制结束');
                const item = this.current;
                await this.stop('wall-timeout');
                this.emit('finished', { item, reason: 'wall-timeout' });
              }
            }, this.computeWallTimeout());
            this.emit('progress', { position: this.position, duration: this.duration });
          }
          break;
        case 'pause':
          if (typeof msg.data === 'boolean') {
            this.state = msg.data ? 'paused' : 'playing';
            this.emit('state', this.snapshot());
          }
          break;
        case 'idle-active':
          if (msg.data === true && this.sawEof && this.state !== 'stopping' && this.state !== 'closed') {
            this.finish('eof');
          }
          break;
        case 'eof-reached':
          if (msg.data === true) {
            this.sawEof = true;
            clearTimeout(this.eofTimer);
            this.eofTimer = setTimeout(() => {
              if (this.state !== 'stopping' && this.state !== 'closed') this.finish('eof');
            }, 1500);
          }
          break;
        case 'media-title':
          if (msg.data) this.emit('title', msg.data);
          break;
        default:
          break;
      }
      return;
    }

    if (msg.event === 'file-loaded') {
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
      if (this.state === 'starting') this.state = 'playing';
      this.emit('state', this.snapshot());
      this.emit('loaded', this.snapshot());
      return;
    }

    if (msg.event === 'end-file') {
      const err = msg.file_error || msg.error || null;
      const reason = msg.reason || 'unknown';
      logger.info('end-file reason=' + reason + (err ? ' error=' + err : ''));
      if (reason === 'eof') {
        this.finish('eof');
      } else if (reason === 'error') {
        this.sawEof = false;
        this.finish('error', err);
      } else if (reason === 'stop' || reason === 'quit') {
        // 我方主动停止，由 stop() 负责收尾
      } else {
        this.finish('unknown:' + reason);
      }
      return;
    }

    if (msg.event === 'shutdown') {
      return;
    }
  }

  /** 正常结束一首歌 */
  finish(reason, error) {
    if (this.state === 'stopping' || this.state === 'closed') return;
    const item = this.current;
    clearTimeout(this.eofTimer);
    clearTimeout(this.wallTimer);
    clearTimeout(this.loadTimer);
    this.emit('finished', { item, reason, error: error || null });
  }

  handleExit(why) {
    const wasPlaying = this.state === 'playing' || this.state === 'paused' || this.state === 'starting';
    clearTimeout(this.eofTimer);
    clearTimeout(this.wallTimer);
    clearTimeout(this.loadTimer);
    this.eofTimer = this.wallTimer = this.loadTimer = null;
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.socket = null;
    this.child = null;
    const prevState = this.state;
    this.state = 'closed';
    this.emit('state', this.snapshot());
    if (wasPlaying && prevState !== 'stopping' && this.stopReason !== 'switch') {
      logger.warn('mpv 意外退出（' + why + '）');
      this.emit('finished', { item: this.current, reason: 'closed' });
    }
  }

  /**
   * 停止并关闭 mpv 进程。任何情况下都会保证进程被回收。
   * @param {string} reason switch | user | finished | shutdown
   */
  async stop(reason = 'user') {
    const hadChild = this.isRunning();
    this.stopReason = reason;
    if (!hadChild && !this.socket) {
      clearTimeout(this.eofTimer);
      clearTimeout(this.wallTimer);
      clearTimeout(this.loadTimer);
      this.eofTimer = this.wallTimer = this.loadTimer = null;
      this.state = 'closed';
      return;
    }

    this.state = 'stopping';
    this.emit('state', this.snapshot());

    clearTimeout(this.eofTimer);
    clearTimeout(this.wallTimer);
    clearTimeout(this.loadTimer);
    this.eofTimer = this.wallTimer = this.loadTimer = null;

    const child = this.child;
    if (this.socket && !this.socket.destroyed) {
      try {
        this.socket.write(JSON.stringify({ command: ['quit'] }) + '\n');
      } catch {
        /* ignore */
      }
    }

    const exited = await new Promise((resolve) => {
      if (!child || child.exitCode !== null) return resolve(true);
      const timer = setTimeout(() => resolve(false), 1500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    if (!exited && child && child.pid) {
      logger.warn('mpv 未在 1.5s 内退出，强制结束 PID ' + child.pid);
      await new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      });
    }

    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
    }
    this.socket = null;
    this.child = null;
    this.state = 'closed';
    this.current = null;
    this.position = 0;
    this.duration = 0;
    this.emit('state', this.snapshot());
  }

  pause() {
    this.send(['set_property', 'pause', true]);
  }

  resume() {
    this.send(['set_property', 'pause', false]);
  }

  togglePause() {
    this.send(['cycle', 'pause']);
  }

  seek(seconds) {
    this.send(['seek', Number(seconds), 'absolute+exact']);
  }

  snapshot() {
    return {
      state: this.state,
      mpvPath: this.mpvPath,
      position: this.position,
      duration: this.duration,
    };
  }
}

module.exports = { MpvPlayer, resolveMpvPath };
