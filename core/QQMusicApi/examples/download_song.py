"""下载歌曲文件示例."""

import asyncio
import random

from qqmusic_api import Client, Credential
from qqmusic_api.modules.song import SongFileInfo

MUSICID = 0
MUSICKEY = ""

credential = Credential(musicid=MUSICID, musickey=MUSICKEY)

SONG_MIDS = ["003w2xz20QlUZt", "000Zu3Ah1jb4gl"]


async def main():
    """并发下载所有可用歌曲文件."""
    async with Client(credential) as client:
        cdn_dispatch = await client.song.get_cdn_dispatch()
        cdn: str = random.choice(cdn_dispatch.sip)
        data = await client.song.get_song_urls([SongFileInfo(mid=mid) for mid in SONG_MIDS])
        for info in data.data:
            if not info.purl:
                print(f"{info.mid} 无法下载")
                continue
            url = cdn + info.purl
            print(f"{info.mid} 可下载链接: {url}")


asyncio.run(main())
