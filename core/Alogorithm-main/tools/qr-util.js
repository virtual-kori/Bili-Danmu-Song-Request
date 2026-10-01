/**
 * 终端二维码工具。
 *
 * 复用本项目已安装的 qrcode 依赖（在 core/KuGouMusicApi 或 core/Netease-Api 的
 * node_modules 里），把文本渲染成：
 *   1) 终端可直接显示的 ASCII/半块字符二维码（不依赖任何外部图片查看器）
 *   2) PNG 图片（同时自动用系统默认看图程序打开，方便手机扫）
 *
 * 找不到 qrcode 依赖时优雅降级：只在终端打印链接，不影响登录流程。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CORE_DIR = path.resolve(__dirname, '..', '..');
const ROOT_DIR = path.resolve(CORE_DIR, '..');

let cached = null;
let tried = false;

/** 找出 qrcode 模块（可能装在 KuGouMusicApi / Netease-Api 的 node_modules 下） */
function loadQrcode() {
  if (tried) return cached;
  tried = true;
  const searchPaths = [
    path.join(CORE_DIR, 'KuGouMusicApi'),
    path.join(CORE_DIR, 'Netease-Api'),
    path.join(CORE_DIR, 'QQMusicApi'),
    CORE_DIR,
    ROOT_DIR,
  ];
  try {
    const resolved = require.resolve('qrcode', { paths: searchPaths });
    cached = require(resolved);
  } catch {
    cached = null;
  }
  return cached;
}

/** 在终端直接画出二维码 */
async function printTerminal(text) {
  const QR = loadQrcode();
  if (!QR) return false;
  try {
    const out = await QR.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
    process.stdout.write(out + '\n');
    return true;
  } catch {
    return false;
  }
}

/** 生成 PNG 文件并返回路径 */
async function writePng(text, filePath) {
  const QR = loadQrcode();
  if (!QR) return null;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await QR.toFile(filePath, text, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
    return filePath;
  } catch {
    return null;
  }
}

/** 用系统默认程序打开图片（不阻塞） */
function openImage(filePath) {
  try {
    execFile('cmd', ['/c', 'start', '', filePath], { windowsHide: true }, () => {});
  } catch {
    /* ignore */
  }
}

/** 生成 data:image/png;base64 形式（给 Web UI 用） */
async function toDataUrl(text, width = 320) {
  const QR = loadQrcode();
  if (!QR) return '';
  try {
    return await QR.toDataURL(text, { margin: 1, width, errorCorrectionLevel: 'M' });
  } catch {
    return '';
  }
}

module.exports = { loadQrcode, printTerminal, writePng, openImage, toDataUrl, CORE_DIR, ROOT_DIR };
