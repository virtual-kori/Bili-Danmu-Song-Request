/**
 * 网易云 API 服务启动器。
 *
 * 直接跑 `node app.js` 时，原版会在启动阶段做一次版本检查（exec 调 npm），
 * 这在受限环境下会因 spawn EPERM 直接崩掉。这里改成：
 *   1) 把临时目录指到项目自己的 core/tmp/，并备好 xeapi 公钥
 *   2) 注册匿名 token（失败也不阻塞服务启动）
 *   3) 用 checkVersion: false 启动 HTTP 服务
 *
 * 为什么要自己准备公钥：
 *   上游 generateConfig.js 的顺序是**先** register_anonimous()、**后**取 xeapi 公钥，
 *   而 register_anonimous 走的正是需要公钥的 xeapi 通道 —— 首次运行必然抛
 *   「xeapi public key is missing」。这里先取公钥落盘，就不会再撞这个循环依赖。
 *
 * 为什么临时目录要自己定：
 *   API 会把 anonymous_token / xeapi_public_key 写到 os.tmpdir()。
 *   某些环境不允许写系统 temp，会抛
 *     EPERM: operation not permitted, open 'C:\...\Temp\xeapi_public_key'
 *   所以这里显式把 TMP/TEMP 指到项目内的 core/tmp/（一定可写）。
 *
 * 用法：
 *   node serve.js                 监听 3000
 *   $env:PORT=4000; node serve.js 换端口
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const PKG = '@neteasecloudmusicapienhanced/api'

/** 项目内的临时目录：core/Netease-Api 的上上级就是 core/ */
const LOCAL_TMP = path.resolve(__dirname, '..', 'tmp')

/**
 * 选定临时目录：优先项目内的 core/tmp，建不出来再退回系统 temp。
 *
 * 关键：必须在**加载 api 包之前**调用。
 * 包里 util/request.js 在模块加载时就把 tmpPath 算好并缓存了
 * （`const xeapiPublicKeyPath = path.resolve(tmpPath, './xeapi_public_key')`），
 * 之后再改 TMP 就晚了 —— 会去系统 temp 找公钥，报 "xeapi public key is missing"。
 */
function prepareTmpDir() {
  try {
    fs.mkdirSync(LOCAL_TMP, { recursive: true })
    // 探一下能不能真写（有些环境目录能建但不能写）
    const probe = path.join(LOCAL_TMP, '.write-test')
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    process.env.TMP = LOCAL_TMP
    process.env.TEMP = LOCAL_TMP
  } catch {
    /* 用不了就保持系统 temp */
  }
  if (process.env.NCM_DEBUG_INIT === '1') {
    console.log('[init] __dirname=' + __dirname)
    console.log('[init] LOCAL_TMP=' + LOCAL_TMP)
    console.log('[init] cwd=' + process.cwd())
    console.log('[init] os.tmpdir()=' + os.tmpdir())
  }
}

// 立即执行：一定要早于任何 require(api 包) 的代码
prepareTmpDir()

/** api 包目录（延迟解析，避免在 prepareTmpDir 之前加载包） */
function pkgDir() {
  return path.dirname(require.resolve(PKG + '/package.json'))
}

/** 当前生效的临时目录 */
function tmpDir() {
  return os.tmpdir()
}

/**
 * 先把 xeapi 公钥准备好。
 * 有缓存就直接用；缓存坏了或首次运行才联网取。
 */
async function ensureXeapiKey() {
  const keyFile = path.join(tmpDir(), 'xeapi_public_key')
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(keyFile, 'utf-8'))
  } catch {
    /* 首次运行没有缓存，正常 */
  }
  // 缓存里已经有可用公钥就不用联网了
  if (current && current.sk) return true

  try {
    const { getXeapiPublicKey } = require(path.join(pkgDir(), 'util', 'xeapiKey.js'))
    const publicKey = await getXeapiPublicKey(current, global.deviceId)
    fs.writeFileSync(keyFile, JSON.stringify(publicKey), 'utf-8')
    return true
  } catch (err) {
    // 离线/被风控时拿不到；没有公钥只会让匿名 token 注册这一步失败，服务照常可用
    return false
  }
}

/**
 * 临时屏蔽上游那几段「已知且无害」的噪音输出。
 *
 * ① xeapi public key is missing
 *    上游的循环依赖：generateConfig 先调 register_anonimous()（走 xeapi 通道、需要公钥），
 *    之后才去取公钥。而 util/request.js 在**模块加载时**就把公钥读进内存并缓存为 null，
 *    之后再写文件也不会重新读 —— 所以「首次运行」这一次必然抛这个错并 console.log 出来。
 *    看起来像故障，其实完全不影响服务（网易云照常起、照常搜歌取直链）。
 *
 * ② Generated Random Chinese IP: ...
 *    上游为了「本机请求带 realIP 参数时不用回环地址」而随机编的一个中国 IP
 *    （generateConfig 里的 generateRandomChineseIP）。它只是请求体里的一个字段，
 *    **不改变本机出口 IP**，而且每次启动都重新随机。
 *    打在启动横幅里很容易被误读成「我的 IP 怎么跑到广州去了」，所以不显示。
 *
 * 做法：临时把 console.log / error / warn 换成会过滤这些句子的版本，跑完立刻还原。
 * （直接改 process.stdout.write 会干扰 console 内部实现，所以改在这一层。）
 */
async function withQuietUpstreamNoise(fn) {
  const IGNORE = [
    /xeapi public key is missing/i,
    /Generated Random Chinese IP/i,
    // 取公钥/注册匿名 token 时的瞬时网络抖动：这两个文件只是缓存，
    // 拿不到不影响服务（网易云照常搜索取直链），下次启动会重试。
    /AxiosError: socket hang up/i,
  ];
  // 注意：上游多数日志走的是 console.info（见 util/logger.js），
  // 只包装 log/error/warn 会漏掉，所以 info/debug 也要一起换。
  const orig = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    error: console.error,
    warn: console.warn,
  };
  const wrap = (target) => (...args) => {
    const text = args.map((a) => (a && a.stack ? a.stack : String(a))).join(' ');
    if (IGNORE.some((re) => re.test(text))) return;
    target.apply(console, args);
  };
  for (const k of Object.keys(orig)) console[k] = wrap(orig[k]);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(orig)) console[k] = orig[k];
  }
}

async function main() {
  const port = Number(process.env.PORT || process.env.NCM_PORT || 3000)

  const hadKey = await ensureXeapiKey()

  // 匿名 token 只影响「未登录时接口稳不稳」，不是启动必需。
  const tokenFile = path.join(tmpDir(), 'anonymous_token')
  let hasToken = false
  try {
    hasToken = fs.statSync(tokenFile).size > 0
  } catch {
    hasToken = false
  }

  // 已有 token 就不用再跑 generateConfig（也就不必再吃那次首启报错）
  if (!hasToken) {
    try {
      const generateConfig = require(path.join(pkgDir(), 'generateConfig.js'))
      await withQuietUpstreamNoise(() => generateConfig())
    } catch (err) {
      console.warn('[warn] 匿名 token 初始化失败（不影响使用）:', (err && err.message) || err)
    }
  }

  if (process.env.NCM_DEBUG_INIT === '1') {
    console.log('[init] tmp=' + tmpDir() + ' key=' + hadKey + ' token=' + hasToken)
  }

  const { serveNcmApi } = require(path.join(pkgDir(), 'server.js'))
  serveNcmApi({ port, checkVersion: false })
}

main().catch((err) => {
  console.error('[fatal] 服务启动失败:', (err && err.message) || err)
  process.exit(1)
})
