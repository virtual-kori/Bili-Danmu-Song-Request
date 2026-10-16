/**
 * 让启动脚本优先使用自带的 Node（前置运行时），找不到才回退到系统 PATH。
 *
 * 查找顺序（都相对于**项目根目录**）：
 *   core\node\node.exe   ← 标准位置：前置运行时统一放 core/ 里
 *   node\node.exe        ← 旧位置，仍然兼容
 *   系统 PATH 里的 node
 *
 * 为什么要这样：打包出去的目录要能在「没装 Node 的电脑」上直接双击运行。
 *
 * 注意：本项目所有 .bat 必须是**纯 ASCII**（cmd.exe 用 GBK 解析 bat，
 * 混入 UTF-8 中文会让命令被截断），所以这里的输出文案一律用英文。
 *
 * 用法：node core\Alogorithm-main\tools\use-bundled-node.js [项目目录]
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', '..', '..');

/** 根目录的 bat：工作目录 = 项目根 */
const ROOT_BATS = ['启动.bat', '停止.bat'];
/** core 里的 bat：工作目录 = 项目根（脚本自己会 cd 到 ..） */
const CORE_BATS = ['登录.bat', '登录网易云.bat', '登录QQ音乐.bat', '登录酷狗.bat', '登录酷我.bat'];

const MARK = 'BUNDLED_NODE_DETECT';

/** 依次尝试的 Node 相对路径（相对项目根）；第一个是标准位置 */
const NODE_CANDIDATES = ['core\\node\\node.exe', 'node\\node.exe'];

/** 生成「自带 Node 探测」代码块（纯 ASCII）。前提：脚本已 cd 到项目根 */
function detectBlock() {
  const lines = [
    'rem --- ' + MARK + ': prefer the bundled Node, fall back to system Node ---',
    'set "NODE_BIN="',
    'set "NODE_SRC="',
  ];
  NODE_CANDIDATES.forEach((rel, i) => {
    const prefix = i === 0 ? 'if' : 'if not defined NODE_BIN if';
    lines.push(prefix + ' exist "' + rel + '" set "NODE_BIN=' + rel + '"');
  });
  lines.push('if defined NODE_BIN set "NODE_SRC=bundled"');
  lines.push('if not defined NODE_BIN (');
  lines.push('  where node >nul 2>nul');
  lines.push('  if not errorlevel 1 (');
  lines.push('    set "NODE_BIN=node"');
  lines.push('    set "NODE_SRC=system"');
  lines.push('  )');
  lines.push(')');
  // 这里不 goto：先让横幅打出来，检查放到真正调用前
  lines.push('');
  return lines.join('\r\n');
}

/** 把脚本里的裸 `node xxx` 调用换成 "%NODE_BIN%" xxx */
function swapNodeCalls(text) {
  return text
    .split(/\r?\n/)
    .map((raw) => {
      const trimmed = raw.trim();
      if (!/^node\s/.test(trimmed)) return raw;
      const indent = raw.slice(0, raw.length - raw.trimStart().length);
      return indent + trimmed.replace(/^node(\s+)/, '"%NODE_BIN%"$1');
    })
    .join('\r\n');
}

/** 在第一次调用 NODE_BIN 之前插入「没找到就报错」的检查（可重复执行，不会重复插入） */
function insertGuard(text, hardFail) {
  const guard = 'if not defined NODE_BIN goto ' + (hardFail ? 'NONODE' : 'NONODE_SOFT');
  // 先清掉旧的 guard，保证反复刷新不会叠加
  const lines = text
    .split(/\r?\n/)
    .filter((l) => !/^\s*if not defined NODE_BIN goto NONODE(_SOFT)?\s*$/.test(l));
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*"%NODE_BIN%"/.test(lines[i])) {
      lines.splice(i, 0, guard);
      return lines.join('\r\n');
    }
  }
  return lines.join('\r\n');
}

/** 让「找不到运行时」的提示始终指向 core\node（兼容刷新已有补丁的脚本） */
function fixNonNodeHint(text) {
  return text
    .replace(
      /echo\s+Put a portable runtime at "[^"]*",\r?\n\s*echo\s+or install Node\.js 18\+ and add it to PATH\./,
      'echo         Expected a bundled runtime at "core\\node\\node.exe",\r\n' +
        'echo         (or "node\\node.exe"), otherwise install Node.js 18+ and add it to PATH.'
    )
    .replace(/echo\s+https:\/\/nodejs\.org\//, 'echo         Install Node.js 18+: https://nodejs.org/');
}

function patchFile(file, { hardFail, isCore }) {
  if (!fs.existsSync(file)) return { file, changed: false, reason: 'not found' };
  let text = fs.readFileSync(file, 'utf8');
  let reason;

  if (text.includes(MARK)) {
    // 已打过补丁：整体重写探测块，保证候选路径是最新的
    text = text.replace(/rem --- BUNDLED_NODE_DETECT[\s\S]*?\r?\n\r?\n/, detectBlock() + '\r\n');
    reason = '已刷新探测块';
  } else {
    // 1) 去掉原来的 `where node` 检查（会被探测块取代）
    text = text.replace(/^\s*where node >nul 2>nul\s*\r?\n\s*if errorlevel 1 goto NONODE\s*\r?\n/gm, '');

    // 2) 在 cd 之后插入探测块
    const cdRe = isCore ? /^(cd \/d "%~dp0\.\."\s*)$/m : /^(cd \/d "%~dp0"\s*)$/m;
    if (!cdRe.test(text)) return { file, changed: false, reason: '找不到 cd 行' };
    text = text.replace(cdRe, '$1\r\n\r\n' + detectBlock());
    reason = '已改为优先自带 Node';

    // 3) 更新错误提示
    text = text.replace(/echo \[ERROR\] Node\.js not found[^\r\n]*/, 'echo [ERROR] Node.js runtime not found.');
  }

  text = fixNonNodeHint(text);
  text = swapNodeCalls(text);
  text = insertGuard(text, hardFail);

  fs.writeFileSync(file, text, 'utf8');
  return { file, changed: true, reason };
}

// ---------------------------------------------------------------- 主流程

console.log('项目目录：' + ROOT);
const results = [];

for (const name of ROOT_BATS) {
  // 停止脚本没有 node 也要能靠端口兜底
  results.push(patchFile(path.join(ROOT, name), { hardFail: name !== '停止.bat', isCore: false }));
}
for (const name of CORE_BATS) {
  results.push(patchFile(path.join(ROOT, 'core', name), { hardFail: true, isCore: true }));
}

for (const r of results) {
  console.log('  ' + (r.changed ? '✏ ' : '✓ ') + path.relative(ROOT, r.file) + '  — ' + r.reason);
}

// 纯 ASCII 校验
const bad = [];
for (const r of results) {
  if (!fs.existsSync(r.file)) continue;
  if ([...fs.readFileSync(r.file)].some((x) => x > 0x7f)) bad.push(path.relative(ROOT, r.file));
}
if (bad.length) {
  console.log('\n❌ 以下脚本含非 ASCII 字节（会被 cmd.exe 解析错）：');
  bad.forEach((b) => console.log('   · ' + b));
  process.exit(1);
}

// 报告实际会用到哪个运行时
const present = NODE_CANDIDATES.filter((rel) => fs.existsSync(path.join(ROOT, rel)));
console.log(
  '\n✅ ' +
    results.filter((r) => fs.existsSync(r.file)).length +
    ' 个脚本已指向自带 Node，且全部为纯 ASCII' +
    (present.length ? '\n   探测到的运行时：' + present.join(' 、 ') : '\n   （当前没有自带运行时，将回退系统 Node）')
);
