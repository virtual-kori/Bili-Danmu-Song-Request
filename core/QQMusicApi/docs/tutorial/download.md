# 下载歌曲

获取歌曲文件链接需要登录凭证。基本流程：先获取 CDN 节点，再请求文件地址。

## 基本用法

```python
import asyncio
import random

from qqmusic_api import Client, Credential
from qqmusic_api.modules.song import SongFileInfo


async def main() -> None:
    credential = Credential(musicid=123456, musickey="Q_H_L_xxx")
    async with Client(credential=credential) as client:
        cdn_dispatch = await client.song.get_cdn_dispatch()
        cdn = random.choice(cdn_dispatch.sip)

        urls = await client.song.get_song_urls(
            [SongFileInfo(mid="003w2xz20QlUZt")]
        )
        for info in urls.data:
            if info.purl:
                print(f"{info.mid}: {cdn}{info.purl}")


asyncio.run(main())
```

## 检查下载权限

通过 `query_song` 获取歌曲信息后，可从 `pay` 字段判断是否需要付费：

```python
song = await client.song.query_song([SongQueryInfo(mid="003w2xz20QlUZt")])
track = song.tracks[0]

# pay_play: 1=需要付费播放, 0=免费
# pay_down: 1=需要付费下载, 0=免费
# pay_month: 1=需要绿钻/付费包
if track.pay.pay_month == 1:
    print("需要绿钻或付费包权限")
elif track.pay.pay_down == 1:
    print("需要单独付费下载")
else:
    print("可免费下载")
```

请求文件链接后，`UrlinfoItem.result` 会返回授权结果码：

| result   | 含义                       |
|----------|----------------------------|
| `0`      | 成功，`purl` 可用          |
| `104003` | 无权限（未登录或等级不够） |
| `104004` | VKey 获取失败              |
| `104013` | 播放设备受限               |

```python
urls = await client.song.get_song_urls([SongFileInfo(mid="003w2xz20QlUZt")])
for info in urls.data:
    if info.result == 0 and info.purl:
        url = cdn + info.purl
        print(f"可下载: {url}")
    else:
        print(f"无法下载 (result={info.result})")
```

## 检查文件是否存在

`query_song` 返回的 `file` 字段包含各音质的文件大小，值为 `0` 表示该音质不存在：

```python
song = await client.song.query_song([SongQueryInfo(mid="003w2xz20QlUZt")])
track = song.tracks[0]

file = track.file
if file.size_flac > 0:
    print(f"FLAC 无损可用, 大小: {file.size_flac / 1024 / 1024:.1f} MB")
if file.size_320mp3 > 0:
    print(f"MP3 320k 可用, 大小: {file.size_320mp3 / 1024 / 1024:.1f} MB")
if file.size_128mp3 > 0:
    print(f"MP3 128k 可用, 大小: {file.size_128mp3 / 1024 / 1024:.1f} MB")
```

## 同时获取多种音质

`get_song_urls` 支持在一次请求中为同一首歌请求不同音质。为每首歌构造多个 `SongFileInfo`，指定不同的 `file_type`：

```python
from qqmusic_api.modules.song import SongFileInfo, SongFileType

song_mid = "003w2xz20QlUZt"
media_mid = "003w2xz20QlUZt"  # 从 track.file.media_mid 获取

urls = await client.song.get_song_urls(
    [
        SongFileInfo(mid=song_mid, file_type=SongFileType.MP3_128, media_mid=media_mid),
        SongFileInfo(mid=song_mid, file_type=SongFileType.FLAC, media_mid=media_mid),
        SongFileInfo(mid=song_mid, file_type=SongFileType.OGG_320, media_mid=media_mid),
    ]
)

for info in urls.data:
    if info.result == 0 and info.purl:
        print(f"{info.filename}: {cdn}{info.purl}")
```

常用的 `SongFileType`：

| 枚举值    | 音质      | 格式              |
|-----------|-----------|-------------------|
| `MP3_128` | 标准音质  | MP3 128k          |
| `MP3_320` | HQ 高品质 | MP3 320k          |
| `OGG_192` | HQ 高品质 | OGG 192k          |
| `OGG_320` | HQ 高品质 | OGG 320k          |
| `FLAC`    | SQ 无损   | FLAC              |
| `OGG_640` | SQ 无损   | OGG 640k          |
| `MASTER`  | 臻品母带  | FLAC 24Bit/192kHz |

!!! tip

    `ACC_96`音质部分 VIP 歌曲即使未登录或无会员，也可能通过该音质获取到播放链接（试听级别）。
