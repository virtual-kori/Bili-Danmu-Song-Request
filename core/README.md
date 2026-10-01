# 弹幕点歌机

本机运行的 B 站直播弹幕点歌系统：抓取直播间弹幕 → 识别「点歌」指令 → 四平台（网易云 / QQ 音乐 / 酷狗 / 酷我）搜索匹配 → 加入未播放队列 → 用 MPV 逐首播放 → Web UI 实时管理。

本项目由: 半遥狐 开发开源
特别鸣谢: 喵的喵的喵cat(Bili UID:3546819585902757)
如果可以请支持一下 喵的喵的喵cat 吧

---

## 一、注意事项

1. 本项目使用了其他项目的代码:
  **KuwoMusicApi**`https://github.com/GSQZ/KuwoMusicApi`
  **KuGouMusicApi**`https://github.com/MakcRe/KuGouMusicApi`
  **QQMusicApi**`https://github.com/L-1124/QQMusicApi`
  **NeteaseMusic-API**`https://github.com/xgxdmx/NeteaseMusic-API`
2. 本产品仅用于学习交流，造成一切后果自行承担
3. 音乐平台不易，请遵守平台规定，保护歌曲版权
4. 代码允许二次开发，禁止任何形式的商业活动
5. 请遵守AGPLv3开源协议

---

## 二、快速开始

1. 双击根目录的 **`启动.bat`**
2. 浏览器会自动打开 `http://127.0.0.1:33000`（未自动打开就手动访问）
3. 点顶栏的 **「账号登录」**，把 B 站和音乐平台登录好
4. 在右侧「直播间弹幕」填入直播间房间号，点「连接」
5. 观众发送 `点歌 歌名 歌手`，即可入队播放

停止服务：双击 **`停止.bat`**（会一并关闭四个平台 API 与残留的 MPV 进程）。

> **环境要求**：Windows 10/11 + Node.js 18 以上（本机用 Node 24 验证）。
> **注意**：`core` 文件夹与两个 bat 必须保持同级，不要改名或单独移动。
> 除了网页登录，也可以双击 `core\登录.bat`（菜单式）或 `core\登录网易云.bat` / `core\登录酷我.bat` 等命令行登录。

---

## 三、目录结构

根目录只保留「一键启停脚本 + 主配置」，其余全部在 `core/` 里，**所有路径都是相对路径，整个文件夹可以随便改名或移动到任何位置**：

```
点歌机/
├── 启动.bat                ← 双击这个启动
├── 停止.bat                ← 双击这个停止
├── config.json             ← 主配置（开关、规则、播放参数、平台优先级）
└── core/                   ← 二级文件夹：程序、依赖、登录脚本都在这里
    ├── 登录.bat             ← 菜单式登录（可选，网页里也能登录）
    ├── 登录网易云.bat / 登录酷狗.bat / 登录QQ音乐.bat / 登录酷我.bat
    ├── Alogorithm-main/    点歌核心（算法 / 队列 / MPV / Web UI / 四平台适配器）
    │   ├── server.js         主服务（HTTP + WebSocket + 全局调度 + 账号接口）
    │   ├── core/             config / logger / queue / matcher / mpv / engine / platforms / ws-server / qr-cookie
    │   ├── platforms/        netease / qq / kugou / kuwo 四个适配器
    │   ├── web/              Web UI（index.html / app.js / style.css / obs.html / obs-lyrics.html）
    │   ├── tools/            自检、登录与运维脚本
    │   └── logs/             运行日志（按天滚动，保留 7 天）
    ├── Bullet-Screen-Capture/  弹幕捕捉
    │   ├── auth.js            B 站鉴权 + WBI 签名 + 扫码登录
    │   ├── ws-client.js       极简 WebSocket 客户端（RFC6455）
    │   ├── live.js            直播间弹幕客户端（取节点/认证/心跳/解压/重连）
    │   ├── parse.js           点歌指令解析与歌名清洗
    │   └── bilibili-danmaku-protocol.md   协议实现说明
    ├── Netease-Api/         网易云 API（依赖已装好）
    ├── QQMusicApi/          QQ 音乐（live/ 是补全的纯 Node 服务）
    ├── KuGouMusicApi/       酷狗 API（依赖已装好）
    ├── kuwoMusicApi/        酷我（live/ 是补全的纯 Node 服务，含微信扫码登录）
    ├── platform-ports.json  四平台端口与登录 Cookie（程序自动读写）
    ├── mpv.exe / mpv.com    播放器
    ├── vulkan-1.dll         mpv 运行库
    └── 说明文档.md           本文件
```

---

## 四、Web UI 功能

访问 `http://127.0.0.1:33000`。

| 区域 | 位置 | 能力 |
| --- | --- | --- |
| 顶部状态栏 | 顶部 | 空闲 / 播放中 / 停止中 / 已关闭，**登录中心按钮**（显示已登录 N/5），体检，WebSocket 状态，OBS 展示页 |
| 两个开关 | 顶部 | **允许弹幕点歌**、**空闲自动播放**，互不影响，即时生效 |
| 当前播放 | 顶部 | 封面、歌名、歌手、专辑、来源平台、点歌人、音质、播放进度 |
| 播放控制 | 顶部 | 暂停 / 继续、切歌、停止播放 |
| 手动点歌 | 左列 | 输入歌名/歌手 →「搜索候选」列出四平台各前 3 个版本供挑选，或「直接点歌」自动选最优 |
| **最近弹幕** | 左列 | 固定高度、滚轮查看，最多保留最近 60 条，可一键清空 |
| **实时歌词** | 中列 | 跟随播放进度高亮当前行并自动居中滚动；「展开」可全屏大字显示（按 `Esc` 退出），「收起」把空间让给队列 |
| **歌词设置** | 右列 | 歌词**模式**（滚动 / 三行 / 两行 / 单行）、**左右与上下对齐**、当前行 / 其他行的**颜色与字号**、发光、自动滚动跟随；以及 OBS 专属的颜色、字号、对齐与**自定义 CSS**。所有设置存在浏览器本地，刷新不丢 |
| **未播放队列** | 中列 | 固定高度、鼠标滚轮查看：**正在播放的那首一开播就出队**，框里只剩真正还没轮到的歌；支持置顶标记、置顶 / 取消置顶、上移 / 下移、删除、清空 |
| 点歌规则 | 右列 | 冷却时长、队列上限、同曲次数、重复策略、音量、空闲推荐源、黑白名单 |
| **登录中心** | 弹窗 | 三个标签页：**账号登录 / 直播间弹幕 / 平台优先级**（顶栏「登录中心」进入） |
| 候选选择 | 弹窗 | 四个平台各前 3 个版本，显示匹配等级、专辑、是否已在队列；点任意一条即入队 |

**布局规则**：左中右三列共用同一个行高，**底部齐平**，页面本身不会被内容撑长；每个卡片内部各自滚动（滚轮），窗口高度变化时整体自适应。

**登录中心（设置中心）三个标签页**：

* **账号登录** —— B 站 + 四平台一站式登录，左边选账号、右边扫码或粘贴 Cookie；
* **直播间弹幕** —— 填房间号连接 / 断开，实时弹幕统计（弹幕 / 礼物 / 醒目留言 / 舰长 / 人气）；
* **平台优先级** —— 上下箭头或**直接拖拽整行**调整取歌顺序，还能启用 / 停用平台、就地登录。

**手动点歌两种方式**：

* **搜索候选** —— 适合「想指定某个版本」：列出四平台各前 3 个候选，带匹配等级（如「歌名+歌手完全一致」）与专辑名，每条都能看到是否已在队列；点选后才会去解析播放地址，取不到会原地提示原因（如「可能需要登录酷狗账号」）。
* **直接点歌** —— 适合「随便放一版，越准越好」：按匹配等级 + 平台优先级自动选最优结果直接入队。

### 两个 OBS 链接

| 用途 | 地址 | 说明 |
| --- | --- | --- |
| 「正在播放 + 队列」展示层 | `http://127.0.0.1:33000/obs` | 透明背景，约 800×450 |
| **独立歌词层** | `http://127.0.0.1:33000/obs-lyrics` | **透明背景，只显示歌词**，专门叠加在画面底部 |

**歌词层建议这样用**：在「歌词设置」面板里调好配色、字号、模式与对齐 → 点**「复制链接」** → OBS 里「来源 → 加号 → 浏览器」→ URL 粘贴 → **宽 1200、高 300**。

链接会把当前所有设置写进查询参数，所以每个 OBS 场景都能有自己的样式。支持的参数：

| 参数 | 含义 | 默认 |
| --- | --- | --- |
| `cur` / `other` | 当前行 / 其他行颜色（6 位十六进制，不带 `#`） | `ffffff` / `8ea0b8` |
| `sizeCur` / `sizeOther` | 当前行 / 其他行字号，单位 `vh`（跟着源高度缩放） | `11` / `4.5` |
| `mode` | 歌词模式：`single` 单行 / `two` 两行 / `three` 三行 / `scroll` 滚动 | `two` |
| `halign` | 左右对齐：`left` / `center` / `right` | `center` |
| `valign` | 上下对齐：`top` / `middle` / `bottom` | `bottom` |
| `css` | **自定义 CSS**，原样注入页面（需 URL 编码） | 空 |
| `glow` | 当前行发光 | `0` |
| `song` | `1` 时「无歌词」显示歌名 | `0` |
| `showMeta` | `1` 时把「作词/作曲」也当歌词显示 | `0` |
| `waiting` | `1` 时空闲不显示提示文字 | `0` |
| `align` | `halign` 的旧名字，仍兼容 | — |
| `debug` | `1` 画一条底部参考线，方便在 OBS 里对齐 | 关 |

**四种歌词模式**：

* **滚动** —— 当前行 + 上下各 2 行，越远越淡，最接近 KTV 观感（默认）；
* **三行** —— 上 2 行 + 当前 + 下 2 行；
* **两行** —— 当前行 + 下一句（最干净）；
* **单行** —— 只显示当前句，适合空间很小的角标。

模式和对齐在**内嵌面板、全屏歌词、OBS 歌词页三处共用**，改一次全都跟着变。

**自定义 CSS**：OBS 读不到本地文件，所以 CSS 是通过 URL 的 `css` 参数传的（设置面板里粘贴即可，会自动编码）。可用选择器：

| 选择器 | 对应 |
| --- | --- |
| `body` | 整个页面（想加半透明底、圆角、内边距就改它） |
| `#stage` | 歌词容器 |
| `#cur` | 当前行 |
| `#l1` / `#l2` | 上面第 1 / 2 行 |
| `#n1` / `#n2` | 下面第 1 / 2 行 |

页面还会注入 CSS 变量 `--cur`、`--other`、`--size-cur`、`--size-other`，可以直接引用。例子：

```css
#cur { letter-spacing: 3px; }
#line1, #n1 { font-style: italic; }
body { background: rgba(0,0,0,.35); border-radius: 18px; }
```

手写链接的例子：

```
http://127.0.0.1:33000/obs-lyrics?cur=ffd166&sizeCur=10&mode=single&halign=left
http://127.0.0.1:33000/obs-lyrics?mode=scroll&sizeCur=12&valign=middle
```

> 提示：改完设置后链接会自动更新，重新点「复制链接」再换掉 OBS 里的 URL 即可。路径 `/obs/lyrics` 是等价别名。

### 弹幕捕捉说明

连接直播间时按「最稳优先」取弹幕服务器：

1. **`room/v1/Danmu/getConf`（首选）** —— 不需要 WBI 签名也不需要 Cookie，实测稳定返回节点与 token；
2. `xlive/web-room/v1/index/getDanmuInfo`（兜底）—— 官方 Web 端在用的接口，需要 WBI 签名 + `buvid3`，风控收紧时可能返回 `-352` 或 `v_voucher`；
3. 两条都失败时会**强制刷新 WBI 密钥再试一次**（密钥每日轮换，缓存过期会导致签名错）。

其它实现要点：

* 认证包按官方要求填 `uid`（未登录填 0，否则会被强制断连），并带上 `buvid` 让指纹更像正常浏览器；
* 30 秒心跳；掉线自动重连（指数退避，2 秒 → 60 秒封顶）；
* `brotli`(protover 3) 与 `zlib`(protover 2) 双解压支持，正确处理「一帧多包 / 一包跨帧」；
* `LOG_IN_NOTICE`、`WATCHED_CHANGE`、`ENTRY_EFFECT` 等 30 多个与点歌无关的 cmd **静默丢弃**，不再刷屏；
* **未登录 B 站也能收到弹幕**，但 B 站会把昵称打码成 `*`、`uid` 置 0，因此建议登录。

---

## 五、弹幕指令

| 弹幕 | 效果 |
| --- | --- |
| `点歌 夜曲` | 按歌名搜索，不限定歌手 |
| `点歌 夜曲 周杰伦` | 优先命中「歌名 + 歌手完全一致」 |
| `点歌：夜曲，周杰伦` | 全角标点、逗号、顿号均兼容 |
| `点歌以父之名` | 前缀后无分隔符也识别 |
| `点歌`（无内容） | 回复「请在「点歌」后写上歌名…」 |
| 其它弹幕 | 忽略（可记录到日志与「最近弹幕」） |

**解析规则**：去首尾空格 → 全角转半角 → 统一标点 → 按空格/逗号/顿号/竖线拆分 → 只有一段则全部作歌名，两段以上则最后一段作歌手、其余合并为歌名。

**机器人回复**（前缀可在 `config.json` 的 `danmaku.replyPrefix` 改）：

* `已加入点歌列表：歌名 - 歌手`
* `未找到该歌曲，可补充歌手名`
* `当前未开启弹幕点歌`
* `点歌太快啦，请 N 秒后再试`
* `你在黑名单中，暂时无法点歌` / `该歌曲包含受限关键词，无法点播`
* `点歌失败：队列已满（上限 N 首）`
* `该歌曲已在队列中`

> 回复弹幕需要登录 B 站（`bili_jct` 用于 csrf 校验），且内置 ≥5 秒/条 的发送限流。

---

## 六、匹配与播放规则

### 匹配优先级（同优先级按平台顺序）

1. 歌名完全一致 + 歌手完全一致
2. 歌名完全一致 + 歌手包含/相似
3. 歌名相似 + 歌手匹配
4. 仅歌名相似（相似度需 ≥ 62%，避免平台对无意义关键词「硬凑」结果）

「完全一致」判定：歌名与歌手都做清洗（去空格、去括号内容、忽略大小写、去 Live/伴奏/翻自等后缀）后比较。
命中候选后会**校验播放地址有效性**，无效则自动尝试同平台下一个候选；四平台全部失败才回复「未找到」。

平台优先级默认 **网易云 > QQ音乐 > 酷狗 > 酷我**，可在 Web UI 上调整。

### 播放流程（不常驻 MPV）

```
点歌 → 只入未播放队列（不立即播放）
IDLE + 队列非空 → 取队首 → 启动 MPV
播放结束 / 切歌 → 停止 MPV → 关闭 MPV 进程 → 检查队列
   队列非空 → 下一首
   队列为空 → 空闲自动播放开？ → 取推荐曲 1 首入队并播放；关 → 保持 IDLE
```

* 每首歌一个独立 MPV 进程，播放结束或切歌后**必定被关闭回收**（正常退出 → 1.5 秒未退则 `taskkill /T /F`）。
* 每次启动使用**唯一管道名**，避免快速切歌时的命名管道冲突。
* 「播放结束」以 `end-file reason=eof` 为主判据，另有 `eof-reached` / `idle-active` / 墙钟超时三层兜底，不会永久挂起。
* 状态机：`IDLE → PLAYING → STOPPING → CLOSED → IDLE`。
* **一开始播放就出队**：歌曲一进「正在播放」就立刻从未播放队列里移除，所以「未播放队列」里永远只剩真正还没轮到的歌（正在播放的那首显示在上方的「正在播放」区）。
* **空闲自动播放一次只取一首**：这首播完再取下一首，队列不会被推荐曲塞满；期间观众来点歌能立刻排到前面。

### 空闲自动播放的选曲规则

空闲（队列空了）时会自动补一首歌，规则如下：

1. **优先取榜单歌曲** —— 四个平台的**榜单/推荐**都会拉一遍（网易云热歌榜歌单、QQ 热歌榜、酷狗 TOP500、酷我榜单），再按平台优先级**轮流交错**，所以不会一直只用优先级最高的那一家；
2. **随机挑一首** —— 打乱候选池，不是每次都从榜单第一首开始；
3. **跳过最近播放过的** —— 会记住最近放过的曲目（默认 40 条），**并且跨平台按「歌名 + 歌手」判重**，所以同一首歌在酷我放过之后不会再从 QQ 榜单接着放一遍；
4. 逐个尝试解析播放地址，**第一个能播的就入队**（最多试 6 首，避免把平台接口打爆）；
5. 如果榜单里的歌**最近全都放过**，会放宽第 3 条（否则就没歌可放了），但仍然打乱。

> 「空闲推荐源」默认是 **`platform`（平台榜单/推荐）**。另一个选项 `lastPlayed`（上次播放列表）本质是把历史重放一遍，只适合歌单很固定的场景。

---

## 七、配置文件

主配置 `config.json` 在根目录，Web UI 上的改动会写回这里。

```jsonc
{
  "server": { "host": "127.0.0.1", "port": 33000, "openBrowser": true },
  "danmaku": {
    "enabled": true,          // 「允许弹幕点歌」开关
    "roomId": 0,              // 直播间房间号（短号长号都可以）
    "replyEnabled": true,     // 是否回复弹幕
    "replyPrefix": "【点歌机】",
    "replyCooldownMs": 5000   // 回复限流间隔
  },
  "play": {
    "mpvPath": "",            // 留空则自动用 core\mpv.exe
    "volume": 80,
    "audioDevice": "",        // 例如 "wasapi/{设备GUID}"，留空用系统默认
    "streamTimeoutMs": 30000, // 单曲加载超时
    "wallClockSlackMs": 30000 // 时长之外的容忍量
  },
  "order": {
    "prefixes": ["点歌"],
    "userCooldownMs": 60000,  // 同用户冷却
    "queueLimit": 50,         // 队列上限
    "sameSongMaxTimes": 2,    // 同曲最多点几次
    "duplicateStrategy": "cooldown",  // cooldown | reject | allow
    "blacklistUsers": [],
    "blacklistWords": []
  },
  "idle": {
    "enabled": false,         // 「空闲自动播放」开关
    "source": "platform",     // platform（榜单，推荐）| lastPlayed（上次播放列表）| playlist
    "playlistId": "",
    "recommendCount": 20,     // 每个平台取多少首候选
    "maxTry": 6               // 一次空闲补充最多尝试解析几首
  },
  "platforms": {
    "priority": ["netease", "qq", "kugou", "kuwo"],
    "enabled": { "netease": true, "qq": true, "kugou": true, "kuwo": true }
  },
  "log": { "danmaku": true, "level": "info", "keepDays": 7 }
}
```

四平台的端口与登录 Cookie 存在 `core/platform-ports.json`，由程序自动读写，一般不需要手改。

---

## 八、登录中心（Web UI 一站式）

点**顶栏的「登录中心」按钮**（上面显示已登录数，如 `登录中心 2/5`），打开设置中心后默认停在「账号登录」标签页；「直播间弹幕」和「平台优先级」是同弹窗里的另外两个标签页。

「账号登录」标签页左侧是 5 个账号，右侧是登录区：

| 账号 | 扫码 | 粘贴 Cookie | 说明 |
| --- | --- | --- | --- |
| 哔哩哔哩（弹幕来源） | ✅ | ✅ | **建议必须登录**：未登录时 B 站会把昵称打码成 `*`、`uid` 置 0，且无法回复弹幕 |
| 网易云音乐 | ✅ | ✅ | 登录 VIP 后可取无损 / 母带直链 |
| 酷狗音乐 | ✅ | ✅ | 登录后可取无损 FLAC / 320 直链 |
| QQ 音乐 | ✅ **微信扫码**（推荐）/ ⚠️ QQ 扫码 | ✅ | **微信扫码实测可用**；QQ 扫码被腾讯限制。界面里可切换，默认微信 |
| 酷我音乐 | ✅ **微信扫码** | ✅ | **用微信扫一扫登录**。登录后取无损 FLAC / 320；未登录走匿名接口，标准 128k |

**扫码登录**：点「获取二维码」→ 二维码直接显示在弹窗里（同时会存一份 PNG 到 `core/Alogorithm-main/logs/`）→ 用手机 App 扫 → 界面实时显示「等待扫码 / 已扫码待确认 / 登录成功」。

**酷我的微信扫码**（与其它平台不同，单独说明）：

酷我官方网页端没有自己的二维码接口，但登录弹窗上有一个微信图标。点它会走**微信开放平台的网站应用扫码授权**：

1. 打开 `open.weixin.qq.com/connect/qrconnect?appid=wx41c1275bb3e28427&scope=snsapi_login`，页面里给出二维码图；
2. 用长轮询 `long.open.weixin.qq.com/connect/l/qrconnect?uuid=...` 拿状态
   （`408` 未扫 / `404` 已扫待确认 / `405` 已确认 / `402` 已取消 / `403` 已过期）；
3. 手机确认后拿到 `code`，请求酷我回调 `WeixinCallback.jsp?code=...`
   → 302 到 `US_NEW/kuwo/login_by_weixin_web?code=...`，由它下发登录 Cookie（`userid` / `sid` / `t3` / `websid`）。

整个过程在本地完成，界面里就是「获取微信二维码 → 手机微信扫一扫 → 手机上点确认 → 自动登录成功」。
登录 Cookie 会同时写入 `core/platform-ports.json` 和酷我本地服务的 `live/data/cookie.json`。
登录态判定规则（`userid` + 任一登录令牌）由 `core/kuwoMusicApi/live/wechat-login.js` 统一提供，三处共用，避免逻辑漂移。

**网易云扫码登录的两个关键点**（参照 `B站弹幕点歌机器人便携版` 的实现补齐）：

1. **登录凭证在响应体里，不在 `Set-Cookie` 头**：`/login/qr/check` 成功时返回
   ```json
   {"code":803,"message":"登录成功","cookie":"MUSIC_U=...; __csrf=..."}
   ```
   只读 `Set-Cookie` 头的话只能拿到 `NMTID`（一个无关的访客 ID），**永远登不上**。
   提取实现见 `core/Alogorithm-main/core/qr-cookie.js`，顶层 / `body.cookie` / `data.cookie` / `set-cookie` 数组四种位置都会试。
2. **登录态以 `profile` 为准**：未登录时 `/login/status` 也会返回一个「匿名账号」
   （`account.userName` 形如 `1000_XXX`、`type=1000`），只看 `account` 会误判成功。
   现在统一走 `NeteaseAdapter.currentAccount()`，**没有 `profile` 就不算登录**。

**粘贴 Cookie 登录**：浏览器登录对应官网 → `F12` → Application/应用 → Storage/存储 → Cookies → 复制整行 → 粘贴到弹窗里的输入框 → 「保存 Cookie」。保存后**会立刻校验**并告诉你结论（通过 / 为什么没通过），不会「存了就当登上了」。

**QQ 音乐的两种扫码**（默认微信，可切换）：

登录弹窗里有 **「微信扫码（推荐）」/「QQ 扫码」** 两个按钮：

* **微信扫码（推荐，实测可用）** —— 配方移植自本项目自带的 Python 库 `core/QQMusicApi/qqmusic_api/modules/login.py`：
  1. 取二维码页 `open.weixin.qq.com/connect/qrconnect?appid=wx48db31d50e334801&redirect_uri=…y.qq.com/portal/wx_redirect.html?login_type=2…&scope=snsapi_login`，从页面里取 `uuid`；
  2. 二维码图 `open.weixin.qq.com/connect/qrcode/<uuid>`；
  3. 长轮询 `lp.open.weixin.qq.com/connect/l/qrconnect?uuid=…`（408 未扫 / 404 已扫码 / 405 已确认）；
  4. 拿到 `code` 后调 `music.login.LoginServer / Login`（`param={code, strAppid}`，走 zzc 签名），
     返回的 `musicid` / `musickey` 拼成登录 Cookie（`uin` + `qm_keyst`）。

* **QQ 扫码（受腾讯限制）** —— 腾讯对这类请求做了限制，`ptqrshow` 返回的二维码
  **扫出来是 `http://txz.qq.com/p?k=…`，即「下载 QQ 手机版」的落地页，不是登录码**；
  查询状态的 `ptqrlogin` 固定返回 **HTTP 403 空响应**。我试过 `m` / `daid` / `pt_3rd_aid` / `appid` / `s_url`
  等各种参数组合，**都是下载码**，属平台侧限制。所以这个按钮仍保留，但会明确提示你改用微信或粘贴 Cookie。

**QQ 音乐微信扫码：扫成功了但拿不到 Cookie？**

界面会显示卡在哪一步。想看得更细，直接用诊断脚本（会打印二维码、弹图、并把服务端**原始返回**打出来）：

```powershell
node core\Alogorithm-main\tools\debug-qq-wx.js
```

它会把「申请二维码 → 轮询 → 换取登录凭证」三步的原始返回都打印出来。也可以看本地服务的诊断接口：

```
http://127.0.0.1:33012/login/wx/diag
```

常见错误码含义：

| code | 含义 | 处理 |
| --- | --- | --- |
| `20274` | 账号绑定缺失 | 这个微信号没绑定过 QQ 音乐，先用微信登录一次 QQ 音乐 App/网页完成绑定 |
| `1000` / `104401` / `104400` | 登录态已失效 | 授权码被用过或已过期，重新获取二维码再扫一次 |
| `20271` | 验证码错误 | 重新扫码 |
| `20279` | 设备数超限 | 去 QQ 音乐里踢掉一些登录设备 |
| `104604` | 触发频率限制 | 等几分钟再试 |
| `20277` / `20278` / `20450` | 账号受限 / 被封禁 | 该账号无法登录 |

> 注意：微信授权码是**一次性**的，拿到后必须立刻换取；如果中途关了弹窗或按了刷新，就作废了，需要重新扫码。

> 实测补充：QQ 音乐的登录态对播放影响很小 —— **未登录时也能取到完整可播的直链**（实测某首 `pay_play=1` 的歌拿到了完整 23MB 文件）。所以即使 QQ 没登录，点歌播放一般也不受影响。

各平台 Cookie 里必须有的字段：

* 网易云：`MUSIC_U`
* QQ 音乐：`uin` + `qm_keyst`（或 `qqmusic_key`）
* 酷狗：`token` + `userid`（程序会自动补 `dfid`）

登录信息保存在 `core/platform-ports.json`，B 站的登录态单独存在 `core/Bullet-Screen-Capture/bili-auth.json`。

> **提示**：账号状态里「可用」表示**当前真的能取到播放直链**，不只是服务在线。未登录时通常显示「可用（未登录，VIP 歌曲只能试听），当前可取『极高』」这类更准确的信息。
>
> **关于酷我**：酷我支持**微信扫码**和**粘贴 Cookie**两种登录方式。未登录时走 antiserver 匿名接口也能稳定播放（128k 标准音质），所以不登录也不影响点歌；登录（含 VIP）后可取无损 FLAC / 320。命令行同样支持：`node core\Alogorithm-main\tools\login.js kuwo`。

### 命令行登录（可选）

不想开网页时，也可以：

```powershell
# 菜单式（登录脚本都在 core\ 里）
双击 core\登录.bat

# 直接指定平台
双击 core\登录网易云.bat
双击 core\登录酷狗.bat
双击 core\登录QQ音乐.bat
双击 core\登录酷我.bat        # 微信扫码

# 或用命令
node core\Alogorithm-main\tools\login.js netease        # 扫码
node core\Alogorithm-main\tools\login.js kuwo           # 微信扫码
node core\Alogorithm-main\tools\login.js kugou --status # 只看状态
node core\Alogorithm-main\tools\login.js qq --cookie    # 改用粘贴 Cookie
```

命令行登录会在终端里直接画出二维码（不用切窗口），同时也会弹出 PNG 图片。

---

## 九、各平台实现说明与已知限制

| 平台 | 搜索实现 | 取直链实现 | 限制 |
| --- | --- | --- | --- |
| 网易云 | 本地 API `/search` | `/song/url/v1`，按无损→极高→较高→标准依次尝试 | ① **无版权时不会报错，而是返回空列表**（例如没有周杰伦版权，搜「夜曲 周杰伦」直接空），程序会自动退化成只搜歌名；② 请求过密会被服务端风控，返回 `code 405 操作频繁`，程序会**自动冷却 90 秒并让其它平台顶上**，无需手动处理 |
| QQ 音乐 | 网页搜索接口（含专辑/时长/media_mid） | `music.vkey.GetVkey`，文件名带 media_mid | 未登录通常只有试听，**登录 VIP 后可取无损** |
| 酷狗 | 本地 API `/search/song`（需 `userid` 参数，已修）+ 移动端接口兜底 | 本地 `/song/url`（自动注册 `dfid`） | 热门/付费曲需要登录；未登录很多曲目只返回试听 |
| 酷我 | 无签名 `search/searchMusicBykeyWord` | 登录后走带签名 `playUrl` 拿无损/320，未登录走 antiserver 匿名接口 | **支持微信扫码 / 粘贴 Cookie 登录**；网页接口的 Secret「盐」就是 Cookie 名，酷我轮换过盐值，本项目已用新盐。若日后又报 `The request is illegal!`，抓一次 `https://www.kuwo.cn/` 的 Set-Cookie，把新 Cookie 名替换到 `core/Alogorithm-main/platforms/kuwo.js` 顶部的 `TOKEN_COOKIE` 即可 |

### 关于「某首歌在网易云搜不到」

这不是故障，而是版权原因。典型例子：**网易云没有周杰伦的原唱版权**，搜「夜曲 周杰伦」会直接返回空（翻唱标题里甚至会写「原唱：周杰伦」）。程序的处理方式是：

1. 先按「歌名 + 歌手」搜；某平台返回空时，**自动退化成只搜歌名**再试一次；
2. 汇总四个平台的候选，按匹配等级 + 平台优先级排序（见第五节）；
3. 所以「点歌 夜曲 周杰伦」最终会命中 **QQ 音乐的《夜曲》- 周杰伦**（歌名+歌手完全一致），而不是网易云的翻唱。

只要四个平台里有一个平台有正版，就能点播成功；四个平台都没有才会回「未找到该歌曲」。

---

## 十、自检与运维脚本

全部位于 `core/Alogorithm-main/tools/`，在根目录执行（需先双击 `启动.bat` 把服务跑起来）：

```powershell
# 总验收：目录结构 / 一键启动 / 登录中心 / 弹幕捕捉 / 功能自检 / 一键停止
# （会自己启动与停止服务，跑完约 3~5 分钟）
node core\Alogorithm-main\tools\check-all.js

# 一键验收：队列、置顶、切歌、暂停、MPV 无残留、两个开关、空闲自动播放
node core\Alogorithm-main\tools\self-test.js

# 四平台逐个验证：能否搜索、能否取到可播放直链
node core\Alogorithm-main\tools\check-platforms.js

# 弹幕点歌链路验证：指令解析、黑白名单、冷却、队列上限、匹配优先级、回复文案
node core\Alogorithm-main\tools\check-danmaku-flow.js

# B 站弹幕链路验证：房间号解析、WBI 签名、弹幕服务器接口、WebSocket 收包
node core\Alogorithm-main\tools\check-danmaku.js 21452505 30

# 酷我微信扫码登录验证：申请二维码、轮询状态、无效会话容错
node core\Alogorithm-main\tools\check-kuwo-login.js

# 空闲选曲验证：四平台榜单、开播即出队、随机且跳过最近播放
node core\Alogorithm-main\tools\check-idle-pick.js

# 登录链路验证：二维码接口契约、状态准确性、Cookie 校验
node core\Alogorithm-main\tools\check-login-flow.js

# QQ 音乐双扫码验证：微信扫码可用、QQ 扫码受限提示、切换不互相影响
node core\Alogorithm-main\tools\check-qq-login.js

# 弹幕捕捉实测：连一个真实直播间，验证真能收到弹幕
node core\Alogorithm-main\tools\check-danmaku-live.js 21452505

# Web UI 验证：页面元素、静态资源、登录中心、二维码接口
node core\Alogorithm-main\tools\check-webui.js

# 前端引用自检：JS 里用到的元素是否都存在（防改动后留下死引用）
node core\Alogorithm-main\tools\check-ui-refs.js

# 可移植性自检：源码无绝对路径、路径都由 __dirname 推导、bat 全用相对路径
node core\Alogorithm-main\tools\check-paths.js

# 强制停止点歌机及全部子进程
node core\Alogorithm-main\tools\stop-all.js
```

> **整个文件夹可以随便挪**：所有路径都由 `__dirname` 推导或写成相对路径，`启动.bat` / `停止.bat` 用 `cd /d "%~dp0"`，`core\` 里的登录脚本用 `cd /d "%~dp0.."` 回到上一层。改名、移动到别的盘、放到带空格或中文的路径下都能正常工作（已实测：复制到 `%TEMP%\portable test 移动测试\点歌机` 跑完整验收 29/29 通过）。

> 弹幕相关的自检要**挑一个正在开播的直播间**才有数据。`check-danmaku.js` 默认用 1017，它常年不开播，只验证接口与连接即可；想看真实弹幕用 `check-danmaku-live.js` 并传一个开播中的房间号（`check-all.js` 会自动帮你挑一个）。

日志在 `core/Alogorithm-main/logs/`，按天滚动、默认保留 7 天。

---

## 十一、常见问题

**Q：双击 `启动.bat` 后窗口一闪而过？**
看窗口里的提示。最常见是 Node.js 未安装或不在 PATH。

**Q：提示 `[ERROR] Missing core\Alogorithm-main\server.js`？**
说明 `core` 文件夹不在 `启动.bat` 旁边，或者被改名/移动了。请保持「`启动.bat` / `停止.bat` / `config.json` / `core`」这四样在同一个目录里（登录脚本在 `core\` 内）。

**Q：Web UI 打不开？**
确认控制台里有 `Web UI 已启动：http://127.0.0.1:33000`。端口被占用可改 `config.json` 的 `server.port`。

**Q：点了歌不出声？**
在 Web UI 点「体检」，看 mpv 版本与四平台状态。若 mpv 起来了但无声，检查 `play.audioDevice` 是否指向了不存在的设备（留空用系统默认）。

**Q：切歌后还有 mpv 残留？**
正常不会。可双击 `停止.bat` 兜底清理；若复现请把 `core/Alogorithm-main/logs/` 里对应时间的日志留档。

**Q：弹幕收不到 / 昵称显示成 `*`？**
两种情况分开看：
* **昵称是 `*`、uid 是 0** —— 这是未登录 B 站，B 站主动打码。点顶栏「账号登录」→ 选「哔哩哔哩」扫码登录即可。
* **一条弹幕都没有** —— 先确认房间**正在开播**（未开播时连接会成功但没有任何弹幕，这是正常的）；再确认房间号填对了。可用 `node core\Alogorithm-main\tools\check-danmaku-live.js <房间号>` 单独验证，它会打印收到的弹幕条数。

**Q：弹幕捕捉到底走的哪个接口？**
优先走 `room/v1/Danmu/getConf`（不需要签名，最稳），失败才回退到需要 WBI 签名的 `getDanmuInfo`。自检输出里会写 `来源=getConf` 或 `来源=getDanmuInfo`。这样即使 B 站哪天把带签名的新接口风控收紧，弹幕捕捉也不会整个挂掉。

**Q：点了周杰伦的歌，为什么不是网易云的？**
因为**网易云没有周杰伦的原唱版权**（搜歌名出来的全是翻唱，标题里还写着「原唱：周杰伦」）。程序会自动退化成只搜歌名、汇总四个平台后按「歌名+歌手完全一致」排序，所以最终会命中 QQ 音乐的周杰伦原唱。这是正常的版权路由，不是故障。

**Q：网易云状态里出现「限流冷却中」？**
网易云服务端对请求频率有风控，短时间请求太密会返回 `405 操作频繁`。程序会自动冷却 90 秒，这期间改用其它三个平台出歌，冷却结束自动恢复，不需要你做任何操作。想立刻恢复也可以双击 `停止.bat` 再 `启动.bat`。

**Q：四平台自检里网易云报「搜索 0 首」？**
先看提示。如果是 `code 405`，那是限流，等几分钟重跑即可；如果提示无版权，就是那首歌网易云确实没有。自检默认用《卡农》这类各平台都有版权的曲目，可以自己指定关键词：`node core\Alogorithm-main\tools\check-platforms.js "卡农 帕赫贝尔"`。

**Q：想改点歌前缀（比如「来一首」）？**
改 `config.json` 的 `order.prefixes` 数组，支持多个前缀。

**Q：想限制某些歌或某些人？**
Web UI 的「点歌规则」里填用户黑名单与关键词黑名单（逗号分隔），保存后即时生效。

**Q：为什么 `启动.bat` 里是英文提示？**
中文 Windows 的 `cmd.exe` 按 GBK 解析批处理文件。之前脚本里混用了中文与 `chcp`，导致 cmd 读取偏移错乱、脚本把自己解析坏掉（正是「一键启动无法启动」的原因）。为彻底消除编码风险，启动脚本只用 ASCII 字符；中文说明都在本文件和 Web UI 里。
