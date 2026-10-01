"""获取歌曲所有来源曲谱示例."""

import asyncio

from qqmusic_api import Client

CREDENTIAL_PATH = __import__("pathlib").Path(__file__).parent.parent / "credential.json"

MID = "0039MnYb0qxYhV"


async def main() -> None:
    """并行获取所有来源曲谱并合并."""
    async with Client() as client:
        # 1. 先检查有哪些类型的曲谱
        has = await client.song.has_sheet(MID)
        print(f"歌曲 {MID}:")
        print(f"  吉他谱: {has.has_guitar}")
        print(f"  虫虫钢琴: {has.has_chong_chong}")
        print(f"  更多曲谱: {has.has_more}")

        # 2. 并行拉取三个来源
        results = await client.gather(
            [
                client.song.get_sheet(MID, ttype=0),
                client.song.get_sheet(MID, ttype=1),
                client.song.get_sheet(MID, ttype=2),
            ]
        )

        # 3. 合并结果, 按 scoreMID 去重
        seen: set[str] = set()
        merged: list = []
        for resp in results:
            if isinstance(resp, Exception):
                continue
            for sheet in resp.result:
                if sheet.score_mid not in seen:
                    seen.add(sheet.score_mid)
                    merged.append(sheet)

        print(f"\n共获取 {len(merged)} 首曲谱:")
        for sheet in merged:
            print(f"  {sheet.score_name} [{sheet.ins_type_text}] ({sheet.score_type_text})")


asyncio.run(main())
