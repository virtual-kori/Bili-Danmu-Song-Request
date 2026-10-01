# B站直播间弹幕抓取协议实现规范（2024–2026，纯 Node.js 无依赖）

> 调研日期：依据 `pskdje/bilibili-API-collect` **master 分支（2026-01-25 同步快照）** 与官方仓库归档说明整理。
> 上游 `SocialSisterYi/bilibili-API-collect` 于 2026-01 收到 B 站律师函后**清空并归档**（默认分支改名 `deprecated`，仅剩 README 与 reason.jpg），
> 因此本文引用镜像：`https://cdn.jsdelivr.net/gh/pskdje/bilibili-API-collect@master/...`

---

## 0. 关键时效性结论（必读）

| 变更 | 生效时间 | 影响 |
|---|---|---|
| `getDanmuInfo` **强制 WBI 签名**（`w_rid` + `wts`） | 2025-05-26 | 不签名会拿不到 `token`/`host_list` |
| `getDanmuInfo` **强制 Cookie `buvid3` 非空** | 2025-06-27 | 缺 buvid3 被风控 |
| `getDanmuInfo` 需要 `SESSDATA`（可选但强烈建议） | — | 未登录受限，见 §8 |
| WebSocket 未登录连接：`uid` 返回 0、昵称打码为 `*` | 隐私政策更新后 | 见 §8 |

**不要**再按 2023 年的老教程只传 `id` + `type=0`。

---

## 1. 获取弹幕服务器列表 `getDanmuInfo`

```
GET https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo
```

**Query 参数（全部参与 WBI 签名）**

| 参数 | 类型 | 必要性 | 说明 |
|---|---|---|---|
| `id` | num | **必要** | **直播间真实 id（长号）**，不是短号 |
| `type` | num | 非必要 | 传 `0` |
| `web_location` | str | 非必要 | 传 `444.8`（网页端同款） |
| `w_rid` | str | **必要** | WBI 签名，见 §2 |
| `wts` | num | **必要** | 当前 Unix 秒级时间戳 |

**必需请求头**

```http
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36
Referer: https://live.bilibili.com/<roomid>
Origin:  https://live.bilibili.com
Cookie:  SESSDATA=<...>; buvid3=<...>; bili_jct=<...>
```

**完整示例 URL**

```
https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=1017&type=0&web_location=444.8&w_rid=cf24f88ea0cbb61e7b29aed0c070187d&wts=1748266797
```

**响应**

```jsonc
{
  "code": 0,            // 0 成功; 1 错误; 65530 token 错误(登录错误); 60009 分区不存在; 1002002 房间号错误
  "message": "0",
  "ttl": 1,
  "data": {
    "group": "live",
    "business_id": 0,
    "refresh_row_factor": 0.125,
    "refresh_rate": 100,
    "max_delay": 5000,
    "token": "gZ2Pp2T4rIc2...",          // 认证秘钥，塞进 WS 认证包
    "host_list": [
      { "host": "zj-cn-live-comet.chat.bilibili.com", "port": 2243, "wss_port": 2245, "ws_port": 2244 },
      { "host": "broadcastlv.chat.bilibili.com",      "port": 2243, "wss_port": 2245, "ws_port": 2244 }
    ]
  }
}
```

**风控表现**：WBI 缺失/错误时可能返回 `{"code":0,...,"data":{"v_voucher":"voucher_******"}}`（无 `token`）或 `code: -352`。
→ 实现里必须判断 `data.token` 是否存在，而不是只看 `code === 0`。

---

## 2. WBI 签名算法（纯 Node，`crypto` 即可）

`md5` 用 `require('crypto').createHash('md5').update(s).digest('hex')`。

### 2.1 取 `img_key` / `sub_key`

```
GET https://api.bilibili.com/x/web-interface/nav
Headers: User-Agent(浏览器 UA), Referer: https://www.bilibili.com/
（可带 Cookie，也可完全不带 —— 未登录返回 code:-101 但仍带 wbi_img）
```

从 `data.wbi_img.img_url`、`data.wbi_img.sub_url` 提取**文件名去扩展名**：
`https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png` → `7cd084941338484aae1ad9425b84077c`

- 全站统一，**每日更替** → 建议缓存 1 小时 / 1 天，失败后强刷。
- 备用来源：`bili_ticket` 接口的 `img` / `sub` 字段；某些页面 SSR 的 `__INITIAL_STATE__.wbiImgKey/wbiSubKey`。
- **不要**去真的请求那两个 png URL（是伪装成图片的 token）。

### 2.2 生成 `mixin_key`（重排表 = `MIXIN_KEY_ENC_TAB`，长 64）

```js
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18,  2, 53,  8, 23, 32, 15, 50, 10, 31, 58,  3, 45, 35, 27, 43,  5, 49,
  33,  9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48,  7, 16, 24, 55, 40, 61,
  26, 17,  0,  1, 60, 51, 30,  4, 22, 25, 54, 21, 56, 59,  6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
];
// raw = img_key + sub_key（拼接后共 64 字符）
// mixin_key = MIXIN_KEY_ENC_TAB.map(i => raw[i]).join('').slice(0, 32)
```

**自检向量（务必用它做单测）**

| img_key | sub_key | mixin_key |
|---|---|---|
| `7cd084941338484aae1ad9425b84077c` | `4932caff0ff746eab6f01bf08b70ac45` | `ea1db124af3c7062474693fa704f4ff8` |

### 2.3 计算 `w_rid`

1. 复制一份**原始**参数对象，加入 `wts = Math.round(Date.now()/1000)`。
2. **过滤每个 value 中的 `!'()*` 五个字符**（正则 `/[!'()*]/g` 替换为空）。
3. 按 **key 升序**排序。
4. 用 **`encodeURIComponent` 语义**百分号编码（**hex 大写**、空格 → `%20` 而非 `+`）拼成 `k=v&k=v`。
   注意：Node 的 `encodeURIComponent` 完全符合，但它**不编码** `!'()*` —— 所以第 2 步的手动过滤是必需的、不是可选的。
5. `w_rid = md5(query + mixin_key)`（32 位小写 hex）。
6. 把 `w_rid`、`wts` 追加到**原始**请求参数的 query 之后（原始参数无需排序）。

**自检向量**

```
img_key = 7cd084941338484aae1ad9425b84077c
sub_key = 4932caff0ff746eab6f01bf08b70ac45
params  = { foo:'114', bar:'514', zab:1919810 }
wts     = 1702204169
→ bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4
```

含中文/空格：

```
{ foo:'one one four', bar:'五一四', baz:1919810 }
→ bar=%E4%BA%94%E4%B8%80%E5%9B%9B&baz=1919810&foo=one%20one%20four
```

### 2.4 哪些直播接口需要 WBI？

| 接口 | WBI | 依据 |
|---|---|---|
| `xlive/web-room/v1/index/getDanmuInfo` | ✅ **强制**（2025-05-26 起） | 参数表标注 `w_rid` 必要 |
| `room/v1/Room/get_info` | ❌ 不需要 | 文档无鉴权、无 `w_rid` 参数 |
| `room/v1/Room/room_init` | ❌ 不需要 | 同上 |
| `xlive/web-room/v1/dM/gethistory` | ❌ 不需要 | 同上 |
| `xlive/web-room/v1/dM/GetDMConfigByGroup` | ⭕ 可选 | 标注「不强制需要」 |
| `msg/send` | ⭕ 可选 | 标注「不强制需要」 |

---

## 3. 短号 → 真实房间号

```
GET https://api.live.bilibili.com/room/v1/Room/room_init?id=<短号或长号>
```

无需 Cookie / WBI。

```jsonc
{ "code": 0, "msg": "ok", "message": "ok",
  "data": {
    "room_id": 14073662,   // ← 真实房间号（长号），auth 包和 getDanmuInfo 都用它
    "short_id": 76,        // 短号；为 0 表示无短号
    "uid": 50333369,       // 主播 mid
    "live_status": 1,      // 0 未开播 / 1 直播中 / 2 轮播中
    "encrypted": false, "pwd_verified": false, "is_hidden": false, "is_locked": false
  } }
```
错误码：`60004` 直播间不存在。

**补充：`room/v1/Room/get_info?room_id=<短号或长号>`**（无需鉴权）返回 `data.room_id`(长号)、`data.short_id`、`data.live_status`、`data.title`、`data.online`、`data.uid` 等，可用来同时拿标题与开播状态。

> 经验做法：先 `room_init` 拿 `room_id`，若 `short_id === 0` 说明传进去的已经是长号。两者都拿来当缓存 key。

---

## 4. WebSocket 连接与二进制封包

### 4.1 连接

```
wss://{host}:{wss_port}/sub          // 从 host_list[*] 里挑一个
wss://broadcastlv.chat.bilibili.com:443/sub   // 通用兜底（CDN 在 443 也终结 TLS）
```

路径必须是 `/sub`。握手头建议带：

```http
Origin: https://live.bilibili.com
User-Agent: <浏览器 UA>
```

**纯 Node 手写 WebSocket 客户端要点（无 npm）**
- 用 `tls.connect({host, port, servername: host})`，发 `GET /sub HTTP/1.1` + `Host` + `Upgrade: websocket` + `Connection: Upgrade` + `Sec-WebSocket-Key: base64(16随机字节)` + `Sec-WebSocket-Version: 13`。
- **不要**发 `Sec-WebSocket-Extensions: permessage-deflate`（B 站弹幕自带压缩，协商压缩会让分帧处理复杂化且无必要）。
- 上行帧（客户端→服务端）**必须**加掩码：`FIN=1, opcode=0x2(binary)`，mask bit=1，4 字节随机 mask key，payload 逐字节 XOR。长度编码：`len<126` 直接 1 字节；`126≤len<65536` → `126` + 2 字节 BE；否则 `127` + 8 字节 BE。
- 下行帧需处理：opcode `0x1`(text，忽略/仅调试) / `0x2`(binary) / `0x8`(close) / `0x9`(ping→回 `0xA` pong) / `0x0`(continuation，需按 FIN 拼装)。
- **WS 帧的 payload 可能包含多个弹幕封包，也可能一个弹幕封包跨多个 WS 帧** → 必须维护一个字节缓冲区，按 §4.3 循环切包。

### 4.2 封包头部（固定 16 字节，**大端**）

| 偏移 | 长度 | 类型 | 含义 |
|---|---|---|---|
| 0 | 4 | uint32 BE | **封包总大小** = 头部 16 + 正文长度 |
| 4 | 2 | uint16 BE | **头部大小**，恒为 `0x0010` = 16 |
| 6 | 2 | uint16 BE | **协议版本 protover**：`0` 普通包(不压缩) / `1` 心跳与认证包(不压缩) / `2` 普通包(zlib) / `3` 普通包(brotli，内含多个带头部的普通包) |
| 8 | 4 | uint32 BE | **操作码 op** |
| 12 | 4 | uint32 BE | **sequence**，每次发包自增（初始 1 即可） |

**操作码 op**

| op | 方向 | 含义 |
|---|---|---|
| 2 | ↑ | 心跳包 |
| 3 | ↓ | 心跳包回复（含人气值） |
| 5 | ↓ | 普通包（业务命令） |
| 7 | ↑ | 认证包 |
| 8 | ↓ | 认证包回复 |

### 4.3 认证包（op=7, protover(头部)=1）

正文为 UTF-8 JSON：

```json
{"uid":0,"roomid":14073662,"protover":3,"platform":"web","type":2,"key":"<getDanmuInfo 返回的 token>"}
```

| 字段 | 类型 | 必要性 | 含义 |
|---|---|---|---|
| `uid` | num | 非必要 | 用户 mid；**`0` = 游客** |
| `roomid` | num | **必要** | **直播间真实 id（长号）** |
| `protover` | num | 非必要 | 填 **`3`**（要求服务端 brotli 压缩；与头部 protover 无关） |
| `platform` | str | 非必要 | `"web"` |
| `type` | num | 非必要 | `2` |
| `key` | str | 非必要 | `getDanmuInfo` 的 `data.token` |

> ⚠️ **uid 一致性约束（官方文档明确）**：若 `uid` 填了用户 mid，则该 mid **必须**与申请 token 时所用 Cookie 的登录用户 mid 一致，否则**强制断开**。
> 安全策略：登录态下 `uid = 自己的 mid`；未登录或不确定时一律 `uid = 0`。
>
> ⚠️ `buvid` 字段**不在官方文档的认证包字段表内**（文档二进制示例里也只有 uid/roomid/protover/platform/type/key）。部分第三方实现会塞进去，服务端通常忽略；**不要**依赖它。
>
> ⚠️ 连接建立后 **5 秒内**必须发出认证包，否则强制断开。

### 4.4 认证回复（op=8, protover(头部)=1）

正文 `{"code":0}`，`code:0` 即成功。失败时表现为 HTTP/0.9 的 403 或直接断开。

### 4.5 心跳包（op=2, protover(头部)=1）

- **间隔 30 秒**（官方推荐「30 秒左右」；**超过 60 秒不发会被强制断开**）。
- 正文可空或任意字符串（实际网页端发的是 `[object Object]`）。

### 4.6 心跳回复（op=3）

正文 = **前 4 字节 uint32 BE = 房间人气值**，其后是心跳正文的回显。可用来当「连接健康度」判断。

### 4.7 解压与多消息处理

```js
const zlib = require('zlib');

function onPacket(buf) {
  const total  = buf.readUInt32BE(0);
  const header = buf.readUInt16BE(4);   // 通常 16
  const proto  = buf.readUInt16BE(6);
  const op     = buf.readUInt32BE(8);
  const body   = buf.subarray(header, total);

  if (op === 8) { /* 认证回复 */ return; }
  if (op === 3) { return body.readUInt32BE(0); }  // 人气值

  if (op === 5) {
    if (proto === 3) {
      // brotli：解压后是「多个完整的带 16 字节头部的封包」拼接
      const inner = zlib.brotliDecompressSync(body);
      for (const p of splitPackets(inner)) handleCommand(p);
    } else if (proto === 2) {
      // zlib：新版同样是「多个完整封包」拼接；老版/个别房间是单个 JSON
      const inner = zlib.inflateSync(body);
      const pkts = splitPackets(inner);
      if (pkts.length && pkts.every(p => p.ok)) pkts.forEach(handleCommand);
      else handleCommand(inner);           // 回退：整块当一个 JSON
    } else {
      handleCommand(body);                 // proto 0/1 不压缩
    }
  }
}

// 按头部声明的总长度循环切包
function splitPackets(buf) {
  const out = []; let off = 0;
  while (off + 16 <= buf.length) {
    const total = buf.readUInt32BE(off);
    if (total < 16 || off + total > buf.length) { out.push({ ok: false }); break; }
    out.push({ ok: true, packet: buf.subarray(off, off + total) });
    off += total;
  }
  return out.filter(x => x.ok).map(x => x.packet);
}
```

- **protover 3（brotli）** → `zlib.brotliDecompressSync`（Node ≥ 11.7 / 10.16 内置；标准发行版都带）。
- **protover 2（zlib）** → `zlib.inflateSync`（**zlib 包装格式**，不是 `inflateRawSync`，因为带 2 字节 zlib 头）。
- 解压后的内容**每个内层封包仍带 16 字节头部**，需要再切一次；内层 `op` 通常为 5，`protover` 为 0。
- 外层封包也可能在一个 WS 帧里连续出现多个 → 上层同样要按 `total` 循环切。
- 心跳回复（op=3）**不压缩**。

---

## 5. 弹幕消息 JSON 结构

### 5.1 `DANMU_MSG`（普通弹幕）

```jsonc
{
  "cmd": "DANMU_MSG",
  "dm_v2": "",
  "info": [
    [ /*info[0] 弹幕元信息，见下*/ ],
    "白花300块[热]",          // ← info[1] 弹幕文本 ★最稳的取文本位置
    [ 6088969, "tim1997", 0, 0, 0, 10000, 1, "" ],   // ← info[2][0]=uid, info[2][1]=用户名
    [ /*info[3] 粉丝勋章数组，无则 []*/ ],
    [ 39, 0, 10512625, 42523, 2 ],   // info[4] UL 等级
    [ "", "" ], 0, 0, null,
    { "ct": "AFFF4206", "ts": 1723979200 },  // info[9] 发送时间（秒级）
    0, 0, null, null, 0, 1040, [ 49 ], null
  ],
  "msg_id": "..."        // 极低概率存在
}
```

**取字段优先级（推荐）**

| 想要的 | 首选 | 兜底 |
|---|---|---|
| 弹幕文本 | `info[1]` | `JSON.parse(info[0][15].extra).content` |
| 发送者 uid | `info[0][15].user.uid` | `info[2][0]` |
| 发送者用户名 | `info[0][15].user.base.name` | `info[2][1]` |
| 头像 | `info[0][15].user.base.face` | — |
| 弹幕颜色 | `info[0][3]`（十进制） | `info[0][15].extra.color` |
| 字体大小 | `info[0][2]` | — |
| 弹幕模式 | `info[0][1]` | — |
| 发送毫秒时间戳 | `info[0][4]` | `info[9].ts * 1000` |

**`info[0][15]` 结构**

| 字段 | 类型 | 说明 |
|---|---|---|
| `extra` | **str** | **字符串形式的 JSON**，需二次 `JSON.parse`。含 `content`/`mode`/`color`/`font_size`/`emots`(表情表)/`id_str` |
| `mode` | num | 弹幕模式 |
| `show_player_type` | num | — |
| `user` | obj | 用户信息（见下） |

**`info[0][15].user`**

| 字段 | 说明 |
|---|---|
| `uid` | 发送者 mid |
| `base.name` / `base.face` / `base.name_color` / `base.name_color_str` / `base.is_mystery` / `base.official_info` | 基本信息 |
| `medal` | 粉丝勋章（可能为 `null`） |
| `guard` | 大航海信息（可能 `null`） |
| `guard_leader.is_guard_leader` | 是否舰长头子 |
| `wealth` | 荣耀等级（可能 `null`） |
| `title` | 头衔 |

**`user.medal`（推荐取勋章的位置）**

| 字段 | 说明 |
|---|---|
| `name` | 粉丝牌名称 |
| `level` | 粉丝牌等级 |
| `color` / `color_start` / `color_end` / `color_border` | 颜色（十进制） |
| `guard_level` | **大航海等级：1 总督 / 2 提督 / 3 舰长 / 0 无** |
| `is_light` | 是否点亮 |
| `ruid` | 粉丝牌对应主播 mid |
| `v2_medal_color_*` | APP 端颜色（`#RRGGBBAA`） |

**`info[3]` 备用勋章数组（无勋章时为 `[]`）**

```
[0]=level  [1]=medal_name  [2]=主播名  [3]=?  [4]=color  [7]=color_border
[8]=color_start  [9]=color_end  [10]=guard_level  [11]=is_light  [12]=ruid
```

**`info` 数组索引总表**

| idx | 类型 | 内容 |
|---|---|---|
| 0 | array | 弹幕元信息（`[15].extra` 是宝库） |
| 1 | str | **弹幕文本** |
| 2 | array | `[0]`=uid, `[1]`=用户名 |
| 3 | array | 粉丝勋章（空则 `[]`） |
| 4 | array | UL 等级 |
| 9 | obj | `{ct, ts}` 发送时间（秒级） |

> ⚠️ **`cmd` 可能带后缀。** 官方文档只记录 `DANMU_MSG`，但线上实际会见到形如 **`DANMU_MSG:4:0:2:2:2:0`** 的 cmd（同一结构）。
> 稳妥写法：`const cmd = msg.cmd.split(':')[0];` 再比较。
> **此点在 2026-01 的文档快照中无法确认（文档无该条目），属实践经验，请以抓包为准。**

### 5.2 醒目留言 `SUPER_CHAT_MESSAGE`

```jsonc
{
  "cmd": "SUPER_CHAT_MESSAGE",
  "roomid": 6154037,                 // 顶层也有 roomid（长号）
  "data": {
    "id": 6522809, "uid": 294094150,
    "message": "猪播完美预测自己第一个死…",   // ← SC 内容
    "message_trans": "", "message_font_color": "#A3F6FF",
    "price": 30, "rate": 1000, "time": 60,          // price 单位 CNY；time = 持续时间(秒)
    "start_time": 1677069035, "end_time": 1677069095, "ts": 1677069035,
    "token": "7BED5681", "trans_mark": 0, "is_ranked": 1, "is_send_audit": 0,
    "background_color": "#EDF5FF", "background_image": "https://...",
    "gift": { "gift_id": 12000, "gift_name": "醒目留言", "num": 1 },
    "medal_info": { "medal_name": "ASAKI", "medal_level": 21, "guard_level": 3,
                    "anchor_uname": "Asaki大人", "anchor_roomid": 732, "target_id": 194484313 },
    "user_info": { "uname": "界原虚", "face": "https://...", "guard_level": 3, "user_level": 6 }
  }
}
```
变体：`SUPER_CHAT_MESSAGE_JPN`（多一个 `message_jpn`）、`SUPER_CHAT_MESSAGE_DELETE`（删除该 SC，`data.message_id`）。

### 5.3 礼物 `SEND_GIFT`

```jsonc
{
  "cmd": "SEND_GIFT",
  "data": {
    "uid": 510149209, "uname": "12138额83121", "face": "https://...",
    "giftId": 31036, "giftName": "小花花", "num": 1,
    "price": 100, "discount_price": 100, "total_coin": 100, "coin_type": "gold",
    "action": "投喂", "timestamp": 1673622464, "rnd": "...", "tid": "...",
    "medal_info": { "medal_name": "", "medal_level": 0, "guard_level": 0 },
    "receive_user_info": { "uid": 36047134, "uname": "小霖QL" },
    "combo_send": {...}, "batch_combo_send": {...}
  }
}
```
注意字段是 **驼峰** `giftId` / `giftName`。`total_coin` 是实际金瓜子总值（**不恒等于** `num * price`）。
判重/连击：用 `batch_combo_id` 或 `combo_send.combo_id`。

### 5.4 其他常用命令

| cmd | 关键字段 |
|---|---|
| `GUARD_BUY` | `data.uid` `data.username` `data.guard_level`(1总督/2提督/3舰长) `data.num` `data.price` `data.gift_name` |
| `USER_TOAST_MSG` | `data.uid` `data.username` `data.guard_level` `data.role_name` `data.num` `data.toast_msg`(含陪伴天数) |
| `DM_INTERACTION` | 弹幕连击/关注/送礼合并；`data.type`(101投票/102弹幕/103关注/104送礼/105分享/106点赞)，`data.data` 是**字符串 JSON** 需二次解析 |
| `WATCHED_CHANGE` | `data.num` `data.text_small` `data.text_large`（看过人数，可替代人气） |
| `LIKE_INFO_V3_CLICK` / `LIKE_INFO_V3_UPDATE` | 点赞用户 / `data.click_count` |
| `ENTRY_EFFECT` | 进场特效，`data.uid` `data.copy_writing` `data.uinfo` |
| `INTERACT_WORD` | 进房/关注/分享 |
| `ONLINE_RANK_COUNT` / `POPULAR_RANK_CHANGED` | 高能榜/热门榜 |
| `LIVE` / `PREPARING` | 开播 / 下播轮播 |
| `ROOM_CHANGE` | 标题/分区变更 |

`GUARD_BUY` / `USER_TOAST_MSG` 出现的舰长 = **大航海信息最可靠的来源**（比 `info[3]` 全）。

---

## 6. 发送弹幕 `msg/send`

```
POST https://api.live.bilibili.com/msg/send?w_rid=<可选>&wts=<可选>
Content-Type: application/x-www-form-urlencoded
Referer: https://live.bilibili.com/<roomid>
Origin:  https://live.bilibili.com
Cookie:  SESSDATA=<...>; bili_jct=<...>; buvid3=<...>
```

**表单正文**

| 参数 | 类型 | 必要性 | 说明 |
|---|---|---|---|
| `csrf` | str | **必要** | = Cookie `bili_jct` 的值 |
| `roomid` | num | **必要** | 直播间 id（长号） |
| `msg` | str | **必要** | 弹幕内容 |
| `rnd` | num | **必要** | 当前 Unix **秒**级时间戳 |
| `fontsize` | num | **必要** | 默认 `25`（小 18 / 中 25 / 大 36） |
| `color` | num | **必要** | **十进制**颜色值；官方注：**实际无效果** |
| `mode` | num | 非必要 | 默认 `1`；`1` 滚动 / `4` 底部 / `5` 顶部 |
| `reply_mid` | num | 非必要 | 要 @ 的用户 mid（默认 `0`） |
| `reply_uname` | str | 非必要 | 要 @ 的用户名（给了 `reply_mid` 就不用给） |
| `replay_dmid` | str | 非必要 | 要回复的弹幕 id（**注意官方就是这个拼写 `replay_dmid`**） |
| `bubble` | num | 非必要 | `0` |
| `room_type` | num | 非必要 | `0` |
| `jumpfrom` | num | 非必要 | `0` |
| `reply_attr` | num | 非必要 | `0` |
| `statistics` | str | 非必要 | `{"appId":100,"platform":5}` |
| `csrf_token` | str | 非必要 | 同 `csrf` |

**响应与错误码**

| code | 含义 |
|---|---|
| `0` | 成功，`data.mode_info` 即刚发出的弹幕元信息（结构同 `info[0][15]`） |
| `-101` | 账号未登录 |
| `-111` | csrf 校验失败（`bili_jct` 与 `csrf` 不一致） |
| `-400` | 请求错误（缺必要参数） |
| `1003212` | 超出限制长度 |
| `10031` | **发送频率过快** |

**风控注意事项（重要）**
- 未登录 / 无 `bili_jct` 无法发送，必须走 §7 登录。
- 有**发送频率限制**：网页端大约 1 条 / 数秒，日累计也有上限。回复观众务必做**本地令牌桶**（建议 ≥ 5 秒/条 + 每房间配额），否则连续 `10031` 会升级为静默/封禁。
- 必须携带 `Referer` + `Origin` + 浏览器 `UA`，否则极易触发风控。
- 弹幕内容受**审核**：敏感词、外链、重复刷屏会被吞（返回成功但不下发）或触发 `is_audited`。
- 带 WBI 参数（`w_rid`/`wts`）更安全，但文档标注**不强制**。
- 使用自动化账号发送弹幕存在**账号风险**（禁言/封禁），生产环境建议单独用小号或仅在主播授权下使用。

---

## 7. 扫码登录 + buvid3

### 7.1 申请二维码

```
GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate
```
→ `data.url`（生成二维码给用户扫）、`data.qrcode_key`（恒 32 字符）。**密钥 180 秒超时**。

### 7.2 轮询扫码状态

```
GET https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=<key>
```

`data.code`：

| code | 含义 |
|---|---|
| `0` | **登录成功** |
| `86038` | 二维码已失效 |
| `86090` | 已扫码未确认 |
| `86101` | 未扫码 |

建议轮询间隔 1–2 秒，总时长不超过 180 秒。

### 7.3 拿 Cookie（**关键实现细节**）

登录成功时服务端通过 `Set-Cookie` 下发：

```
SESSDATA, bili_jct, DedeUserID, DedeUserID__ckMd5, sid
```

**纯 Node 拿 Set-Cookie 的两种办法：**

1. 全局 `fetch`（Node 18.14+ / 19.7+）：
   ```js
   const cks = res.headers.getSetCookie();   // string[]
   ```
   更老版本用 `res.headers.raw()['set-cookie']`（undici）。

2. **兜底（很实用）**：`data.url` 是跨域登录 url，query 里**直接带了全部 cookie**：
   ```
   https://passport.biligame.com/crossDomain?DedeUserID=***&DedeUserID__ckMd5=***&Expires=***&SESSDATA=***&bili_jct=***&gourl=...
   ```
   用 `new URL(data.url).searchParams` 就能把 `SESSDATA` / `bili_jct` / `DedeUserID` / `DedeUserID__ckMd5` 全部取出来（注意值需要 URL 解码）。

`data.refresh_token` / `data.timestamp` 可用于后续 cookie 刷新（`docs/login/cookie_refresh.md`）。

> ⚠️ **`buvid3` 不由扫码登录下发**，必须单独获取（见下）。

### 7.4 免登录获取 buvid3

**方式 A（推荐，一次拿 buvid3 + buvid4）**
```
GET https://api.bilibili.com/x/frontend/finger/spi
→ { "code":0, "message":"ok", "data": { "b_3": "<buvid3>", "b_4": "<buvid4>" } }
```

**方式 B（只拿 buvid3）**
```
GET https://api.bilibili.com/x/web-frontend/getbuvid
→ { "code":0, "data": { "buvid": "<buvid3>" } }
```

**方式 C（从响应头拿 buvid3 + b_nut）**
```
GET/HEAD https://www.bilibili.com/
UA 不得包含 curl / python / awa 等敏感子串，且同一 UA 不得短时高频请求
→ Set-Cookie: buvid3=...; b_nut=<unix 秒>
```

拿到后手动塞进 Cookie 串：`buvid3=<b_3>; buvid4=<b_4>`。
（`buvid4` 不是所有接口都要求，但一起带上更保险。）

---

## 8. 未登录 WebSocket 能收到弹幕吗？

**能。** 认证包 `uid=0`、不带任何 Cookie 也能收到 `DANMU_MSG` / `SEND_GIFT` / `SUPER_CHAT_MESSAGE` 等全量事件。

**但有限制（官方文档明确记载）**

1. **隐私打码**：未登录连接会先收到提示「为保护用户隐私，未注册登陆用户将无法查看他人昵称」；
   随后部分数据包（弹幕、用户交互消息）的 **用户 mid 全部为 `0`**，**用户名被 `*` 打码**。
   → 会员购/点歌机这类需要按 uid 区分观众的场景，**必须登录**。
2. **部分房间受豁免**（见官方 issue #732），表现不稳定，不可依赖。
3. **收不到自己的弹幕**：`send_from_me` 需要登录态才能正确标记。
4. **`getDanmuInfo` 仍需 WBI + buvid3**，未登录时 `nav` 只给 WBI key 不给用户信息（`code:-101`，属正常）。
5. **发送弹幕（`msg/send`）必须登录**，游客绝无可能。
6. 未登录更容易被限流/降级（长连接被断开、节点质量差）。

**建议**：接收弹幕用「已登录 Cookie」连接，这样 `uid`/`uname`/勋章数据完整，点歌机才能正确区分观众。

---

## 9. 端到端伪代码（纯 Node 内置模块）

```js
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const tls = require('tls');

const MIXIN_KEY_ENC_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,
  33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,
  22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const md5 = s => crypto.createHash('md5').update(s).digest('hex');

// ---------- WBI ----------
let wbiCache = { img: '', sub: '', at: 0 };
async function getWbiKeys(cookie) {
  if (Date.now() - wbiCache.at < 3600e3) return wbiCache;
  const j = await getJson('https://api.bilibili.com/x/web-interface/nav',
    { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: cookie || '' });
  const name = u => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'));
  wbiCache = { img: name(j.data.wbi_img.img_url),
               sub: name(j.data.wbi_img.sub_url), at: Date.now() };
  return wbiCache;
}
function encWbi(params, img, sub) {
  const raw = img + sub;
  const mixin = MIXIN_KEY_ENC_TAB.map(i => raw[i]).join('').slice(0, 32);
  const p = Object.assign({}, params, { wts: Math.round(Date.now() / 1000) });
  const query = Object.keys(p).sort()
    .map(k => `${encodeURIComponent(k)}=` +
              `${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return query + '&w_rid=' + md5(query + mixin);
}

// ---------- 1. 短号 -> 长号 ----------
const init = await getJson(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${shortId}`, {});
const realRoomId = init.data.room_id;

// ---------- 2. getDanmuInfo（必须 WBI）----------
const { img, sub } = await getWbiKeys(cookie);
const q = encWbi({ id: realRoomId, type: 0, web_location: '444.8' }, img, sub);
const info = await getJson(
  `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${q}`,
  { 'User-Agent': UA, Referer: `https://live.bilibili.com/${realRoomId}`,
    Origin: 'https://live.bilibili.com', Cookie: cookie });
if (!info.data || !info.data.token) throw new Error('风控/未拿到 token: ' + JSON.stringify(info));
const { token, host_list } = info.data;

// ---------- 3. WebSocket 连接 ----------
const node = host_list[0];
const ws = await wsConnect(node.host, node.wss_port, '/sub');  // 自实现 RFC6455
// 兜底: wsConnect('broadcastlv.chat.bilibili.com', 443, '/sub')

// ---------- 4. 认证 ----------
const auth = { uid: myMid | 0, roomid: realRoomId, protover: 3,
               platform: 'web', type: 2, key: token };
ws.sendFrame(makePacket(7, 1, JSON.stringify(auth)));   // op=7, headerProtover=1

// ---------- 5. 心跳 ----------
const hb = setInterval(() =>
  ws.sendFrame(makePacket(2, 1, '[object Object]')), 30000);   // op=2

// ---------- 6. 收包 -> 解压 -> 解析 ----------
ws.onFrame = buf => {
  for (const pkt of splitPackets(buf)) {                 // WS 帧可能含多个封包
    const header = pkt.readUInt16BE(4), proto = pkt.readUInt16BE(6);
    const op = pkt.readUInt32BE(8), body = pkt.subarray(header);
    if (op === 8) { /* {"code":0} 认证成功 */ }
    else if (op === 3) { /* body.readUInt32BE(0) = 人气值 */ }
    else if (op === 5) {
      if (proto === 3) splitPackets(zlib.brotliDecompressSync(body)).forEach(handle);
      else if (proto === 2) {
        const inf = zlib.inflateSync(body);
        try { splitPackets(inf).forEach(handle); } catch { handle(inf); }
      } else handle(body);
    }
  }
};

function handle(pkt) {
  const header = pkt.readUInt16BE(4), op = pkt.readUInt32BE(8);
  if (op !== 5) return;
  const msg = JSON.parse(pkt.subarray(header).toString('utf8'));
  const cmd = String(msg.cmd).split(':')[0];              // 兼容 DANMU_MSG:4:0:2:2:2:0

  if (cmd === 'DANMU_MSG') {
    const u = msg.info[0][15] && msg.info[0][15].user;
    const medal = (u && u.medal) || null;
    onDanmaku({
      text:   msg.info[1],
      uid:    (u && u.uid) ?? msg.info[2][0],
      uname:  (u && u.base && u.base.name) ?? msg.info[2][1],
      ts:     msg.info[9] && msg.info[9].ts,
      medal:  medal && { name: medal.name, level: medal.level, guard: medal.guard_level },
      guard:  (medal && medal.guard_level) || (msg.info[3] && msg.info[3][10]) || 0
    });
  } else if (cmd === 'SUPER_CHAT_MESSAGE') {
    onSuperChat({ text: msg.data.message, price: msg.data.price,
                  uname: msg.data.user_info.uname, uid: msg.data.uid });
  } else if (cmd === 'SEND_GIFT') {
    onGift({ uname: msg.data.uname, uid: msg.data.uid,
             gift: msg.data.giftName, num: msg.data.num, coin: msg.data.total_coin });
  } else if (cmd === 'GUARD_BUY') { onGuardBuy(msg.data); }
}

// ---------- 7. 发送弹幕 ----------
async function sendDanmaku(roomId, text) {
  const body = new URLSearchParams({
    csrf: biliJct, roomid: String(roomId), msg: text,
    rnd: String(Math.round(Date.now() / 1000)),
    fontsize: '25', color: '16777215', mode: '1'
  }).toString();
  return postForm('https://api.live.bilibili.com/msg/send', body,
    { 'User-Agent': UA, Referer: `https://live.bilibili.com/${roomId}`,
      Origin: 'https://live.bilibili.com',
      'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie });
}

// ---------- 8. 封包构造 ----------
function makePacket(op, protover, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16 + body.length, 0);
  head.writeUInt16BE(16, 4);
  head.writeUInt16BE(protover, 6);
  head.writeUInt32BE(op, 8);
  head.writeUInt32BE(1, 12);          // sequence
  return Buffer.concat([head, body]);
}
```

**其他工程要点**
- `getDanmuInfo` 拿到的 `host_list` 建议**打乱后按顺序尝试**，连接失败自动切换下一个节点；掉线后**重新拉一次 `getDanmuInfo`**（token 会过期）。
- 长连接断线重连要带**指数退避**，避免风控。
- 房间未开播时连接仍可建立，但只有少量事件（`PREPARING`/`LIVE`），弹幕要等开播。
- `host_list` 里的节点有地域属性（`zj-` 浙江、`bd-sz-` 深圳等），选延迟最低的。

---

## 10. 不确定性与风险提示

| 项 | 状态 |
|---|---|
| `DANMU_MSG:4:0:2:2:2:0` 这类 cmd 后缀 | **文档中无记载**，属线上实践观察。请以 `cmd.split(':')[0]` 兼容处理，并用真实抓包确认。 |
| `getDanmuInfo` 的 `type` / `web_location` 语义 | 官方标注「作用尚不明确」；传 `type=0`、`web_location=444.8` 与网页端一致即可。 |
| `getDanmuInfo` 是否在 2026 年有进一步收紧 | 存疑。上游仓库被清空后**不再有官方文档更新**，2026-01-25 之后的变更无从查证。 |
| `buvid4` 是否必需 | 官方只明确要求 `buvid3`。建议一并带上。 |
| WebSocket 是否长期支持无 Cookie 连接 | 文档记载可行但会打码；B 站可能随时收紧。生产环境请用登录态。 |
| `msg/send` 的精确频率限制数值 | 未公开。保守取 ≥ 5 秒/条。 |
| `protover 2`（zlib）解压后是「多封包」还是「单 JSON」 | 两种都出现过，代码必须双兼容。 |

---

## 引用来源（2026-01-25 镜像快照）

- 弹幕信息流（封包格式 / 认证 / 心跳 / DANMU_MSG / SC / 礼物 / 上舰）：<https://cdn.jsdelivr.net/gh/pskdje/bilibili-API-collect@master/docs/live/message_stream.md>
  （GitHub 视图：<https://github.com/pskdje/bilibili-API-collect/blob/master/docs/live/message_stream.md>）
- WBI 签名算法：<https://cdn.jsdelivr.net/gh/pskdje/bilibili-API-collect@master/docs/misc/sign/wbi.md>
- 发送直播弹幕 `msg/send`：<https://cdn.jsdelivr.net/gh/pskdje/bilibili-API-collect@master/docs/live/danmaku.md>
- 直播间基本信息（`room_init` / `get_info`）：<https://cdn.jsdelivr.net/gh/pskdje/bilibili-API-collect@master/docs/live/info.md>
- 二维码登录：<https://cdn.jsdelivr.net/gh/pskdje/bilibili-API-collect@master/docs/login/login_action/QR.md>
- buvid3 / buvid4 / b_nut：<https://cdn.jsdelivr.net/gh/pskdje/bilibili-API-collect@master/docs/misc/buvid3_4.md>
- 原仓库归档说明（律师函、清空）：<https://github.com/SocialSisterYi/bilibili-API-collect>（默认分支 `deprecated`，仅剩 README 与 `reason.jpg`）
- 镜像仓库说明：<https://github.com/pskdje/bilibili-API-collect>（master 分支为基础内容同步快照）
