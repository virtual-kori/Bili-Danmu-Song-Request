/**
 * 隐私自查：确认项目里不残留任何登录凭据与直播间信息。
 *
 * 用法：node core\Alogorithm-main\tools\check-no-secrets.js [要检查的目录]
 *   不传目录时检查项目自身。
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', '..', '..');

// 这些是「有值就一定有问题」的字段
const SECRET_KEYS = /^(cookie|sessdata|bilijct|bili_jct|dedeuserid|music_u|musickey|qm_keyst|qqmusic_key|refresh_key|refresh_token|websid|sid|t3|token)$/i;
// 直播间房间号（非 0 即为残留）
const ROOM_KEY = /^roomId$/;
/**
 * 这些键下面出现 cookie 之类的名字属于**误报**，跳过不再往下递归：
 * npm 的 package-lock.json 里 cookie 是个依赖包名（cookie@^0.7.1）。
 */
const SKIP_KEYS = /^(dependencies|devDependencies|peerDependencies|optionalDependencies|requires|packages|engines|scripts|resolutions)$/i;

const findings = [];
let scanned = 0;

function rel(p) {
  return path.relative(ROOT, p);
}

function scanFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (!['.json', '.js', '.ts', '.md', '.txt', '.bat', '.cmd'].includes(ext)) return;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  scanned += 1;

  // 1) JSON 里字段有值
  if (ext === '.json') {
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch {
      /* 不是合法 JSON 就跳过字段检查 */
    }
    if (obj && typeof obj === 'object') {
      const walk = (node, trail) => {
        if (!node || typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node)) {
          const where = trail ? trail + '.' + k : k;
          if (SKIP_KEYS.test(k)) continue; // npm 依赖树，不是凭据
          if (SECRET_KEYS.test(k) && typeof v === 'string' && v.trim().length > 0) {
            findings.push({ file: rel(file), what: '字段 ' + where + ' 有值（' + v.slice(0, 20) + '…）', level: 'BAD' });
          }
          if (SECRET_KEYS.test(k) && v && typeof v === 'object' && Object.keys(v).length) {
            findings.push({ file: rel(file), what: '字段 ' + where + ' 是对象且有内容', level: 'BAD' });
          }
          if (ROOM_KEY.test(k) && Number(v) > 0) {
            findings.push({ file: rel(file), what: '直播间房间号 = ' + v, level: 'BAD' });
          }
          if (v && typeof v === 'object') walk(v, where);
        }
      };
      walk(obj, '');
    }
  }

  // 2) 明显的长凭据字面量（源码/文档里被误提交的真实值）
  //    注意判据要严：示例占位符（xxx / *** / <...>）、全 0 的脱敏掩码、npm 依赖名都不能算。
  const notMask = (s) => !/^0+$/.test(s);
  const uw = /(userid=(\d{6,});\s*(?:\w+=[^;'"]*;\s*)*?(?:websid|sid)=(\d{6,}))/.exec(text);
  const literal =
    /(MUSIC_U\s*=\s*[A-Za-z0-9+/=]{40,})/.exec(text) ||
    /(SESSDATA\s*=\s*(?!\*{3}|<)[A-Za-z0-9%_,]{25,})/.exec(text) ||
    /(qm_keyst\s*=\s*(?!W_X_xxx|x{4,})[A-Za-z0-9_-]{25,})/.exec(text) ||
    (uw && notMask(uw[2]) && notMask(uw[3]) ? [uw[1]] : null);
  if (literal) {
    findings.push({ file: rel(file), what: '疑似真实凭据字面量：' + String(literal[0]).slice(0, 44) + '…', level: 'BAD' });
  }

  // 2b) 别人的真实身份信息（上游模板里夹带的）
  const identity =
    /(uname3=%u[0-9A-Fa-f]{4}(?:%u[0-9A-Fa-f]{4})+)/.exec(text) ||
    /(pic3="https?:\/\/(?!example)[^"]{20,}")/.exec(text);
  if (identity) {
    findings.push({ file: rel(file), what: '含他人真实身份信息：' + String(identity[0]).slice(0, 40) + '…', level: 'BAD' });
  }

  // 3) 日志文件名残留
  if (/diankeji-\d{4}-\d{2}-\d{2}\.log$/.test(path.basename(file))) {
    findings.push({ file: rel(file), what: '运行日志（含弹幕记录）', level: 'BAD' });
  }
  if (/^login-qr-.*\.png$/.test(path.basename(file))) {
    findings.push({ file: rel(file), what: '登录二维码图片', level: 'BAD' });
  }
}

(function walk(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) scanFile(p);
  }
})(ROOT);

console.log('检查目录：' + ROOT);
console.log('扫描文件：' + scanned + ' 个（已排除 node_modules）');
if (findings.length) {
  console.log('\n❌ 发现 ' + findings.length + ' 处隐私残留：');
  findings.slice(0, 40).forEach((f) => console.log('   · ' + f.file + '  →  ' + f.what));
  console.log('\n===== 隐私自查：不通过 =====');
  process.exit(1);
}
console.log('\n✅ 未发现登录凭据、Cookie、直播间房间号或弹幕日志');
console.log('\n===== 隐私自查：通过 =====');
