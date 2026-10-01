/**
 * 四个音乐平台本地 API 服务的进程管理。
 *
 *  - netease：直接 require Netease-Api/node_modules 里已安装的包，同进程起 HTTP 服务
 *  - qq     ：子进程运行 QQMusicApi/live/server.js
 *  - kugou  ：子进程运行 KuGouMusicApi/app.js
 *  - kuwo   ：子进程运行 kuwoMusicApi/live/server.js（若存在）
 *
 * 每个服务启动后会做健康检查，健康状态会推送到 Web UI。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('./logger').make('platforms');

/** 二级文件夹 core/ —— 四个平台 API 与 mpv 都放在这一层 */
const ROOT = path.resolve(__dirname, '..', '..');

class PlatformSupervisor {
  /**
   * @param {object} platforms platform-ports.json 内容
   * @param {object} config 主配置
   */
  constructor(platforms, config) {
    this.platforms = platforms;
    this.config = config;
    this.children = {};
    this.status = {};
    this.logs = {};
  }

  /** 同步启动网易云（同进程，避免额外子进程与端口等待） */
  async startNetease() {
    const key = 'netease';
    const port = this.platforms.netease.port || 33011;
    this.status[key] = { state: 'starting', port };
    const servePath = path.join(ROOT, 'Netease-Api', 'serve.js');
    if (!fs.existsSync(servePath)) {
      this.status[key] = { state: 'missing', port, error: '未找到 Netease-Api/serve.js' };
      return;
    }
    try {
      process.env.PORT = String(port);
      // serve.js 直接监听端口，不阻塞主流程
      require(servePath);
      this.status[key] = { state: 'running', port, mode: 'in-process' };
      logger.info('网易云 API 以同进程方式启动，端口 ' + port);
    } catch (e) {
      this.status[key] = { state: 'error', port, error: e.message };
      logger.error('网易云 API 启动失败：' + e.message);
    }
  }

  /** 启动一个子进程服务 */
  startChild(key, options) {
    const port = options.port;
    if (this.children[key]) return;
    if (!fs.existsSync(options.script)) {
      this.status[key] = { state: 'missing', port, error: '未找到 ' + path.relative(ROOT, options.script) };
      logger.warn(key + '：未找到启动脚本 ' + options.script);
      return;
    }
    this.status[key] = { state: 'starting', port };

    const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...(options.env || {}) };
    const child = spawn(process.execPath, [options.script], {
      cwd: options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.children[key] = child;
    this.logs[key] = [];

    const collect = (stream) => {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const lines = String(chunk).split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          this.logs[key].push(line);
          if (this.logs[key].length > 200) this.logs[key].shift();
        }
      });
    };
    collect(child.stdout);
    collect(child.stderr);

    child.on('exit', (code) => {
      logger.warn(key + ' 子进程退出，code=' + code);
      this.status[key] = { state: 'exited', port, code };
      delete this.children[key];
    });
    child.on('error', (e) => {
      this.status[key] = { state: 'error', port, error: e.message };
      logger.error(key + ' 子进程错误：' + e.message);
    });

    logger.info('已启动 ' + key + ' API（PID ' + child.pid + '，端口 ' + port + '）');
  }

  /** 启动全部平台服务 */
  async startAll() {
    await this.startNetease();

    const defs = {
      qq: {
        script: path.join(ROOT, 'QQMusicApi', 'live', 'server.js'),
        cwd: path.join(ROOT, 'QQMusicApi', 'live'),
        port: this.platforms.qq.port || 33012,
      },
      kugou: {
        script: path.join(ROOT, 'KuGouMusicApi', 'app.js'),
        cwd: path.join(ROOT, 'KuGouMusicApi'),
        port: this.platforms.kugou.port || 33013,
      },
      kuwo: {
        script: path.join(ROOT, 'kuwoMusicApi', 'live', 'server.js'),
        cwd: path.join(ROOT, 'kuwoMusicApi', 'live'),
        port: this.platforms.kuwo.port || 33014,
      },
    };

    for (const key of Object.keys(defs)) {
      if (this.platforms[key] && this.platforms[key].disabled) continue;
      this.startChild(key, defs[key]);
    }

    // 等待服务可用
    await new Promise((r) => setTimeout(r, 2500));
  }

  /** 健康检查（异步，不阻塞） */
  async healthCheck() {
    const checks = [
      ['netease', 'http://127.0.0.1:' + (this.platforms.netease.port || 33011) + '/'],
      ['qq', 'http://127.0.0.1:' + (this.platforms.qq.port || 33012) + '/health'],
      ['kugou', 'http://127.0.0.1:' + (this.platforms.kugou.port || 33013) + '/search/suggest?keywords=test'],
      ['kuwo', 'http://127.0.0.1:' + (this.platforms.kuwo.port || 33014) + '/health'],
    ];
    for (const [key, url] of checks) {
      const prev = this.status[key] || {};
      if (prev.state === 'missing') continue;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        this.status[key] = { ...prev, state: res.status < 500 ? 'running' : 'error', httpStatus: res.status };
      } catch (e) {
        this.status[key] = { ...prev, state: prev.state === 'starting' ? 'starting' : 'unreachable', error: e.message };
      }
    }
    return this.status;
  }

  /** 停止全部子进程 */
  stopAll() {
    for (const key of Object.keys(this.children)) {
      const child = this.children[key];
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      delete this.children[key];
    }
  }

  snapshot() {
    const out = {};
    for (const key of ['netease', 'qq', 'kugou', 'kuwo']) {
      out[key] = {
        ...(this.status[key] || { state: 'unknown' }),
        logs: (this.logs[key] || []).slice(-6),
      };
    }
    return out;
  }
}

module.exports = { PlatformSupervisor };
