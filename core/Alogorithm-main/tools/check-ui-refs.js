// 检查前端引用的元素 id 是否都能找到：静态页面里的，或 JS 自己动态生成出来的
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');

const ids = [...js.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]);
const uniq = [...new Set(ids)];

// 判定某个 id 是否「存在于静态页面」或「由 JS 动态生成」
const missing = uniq.filter((id) => {
  if (html.includes('id="' + id + '"')) return false;
  // 动态生成的写法：id="xxx" 出现在 app.js 的字符串里
  if (js.includes('id="' + id + '"') || js.includes("id='" + id + "'")) return false;
  return true;
});

console.log('前端引用元素 ' + uniq.length + ' 个');
if (missing.length) {
  console.log('❌ 既不在页面、也不是动态生成：' + missing.join(', '));
  process.exit(1);
}
const dyn = uniq.filter((id) => !html.includes('id="' + id + '"'));
console.log('✅ 全部可解析（其中 ' + dyn.length + ' 个由 JS 动态生成：' + (dyn.join(', ') || '无') + '）');

// 反向检查：JS 里是否还在用已从页面删掉的元素
const htmlIds = [...html.matchAll(/id="([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
const unusedInJs = htmlIds.filter((id) => !js.includes("'" + id + "'"));
if (unusedInJs.length) console.log('（页面里有但 JS 未直接引用的 id：' + unusedInJs.join(', ') + '）');
