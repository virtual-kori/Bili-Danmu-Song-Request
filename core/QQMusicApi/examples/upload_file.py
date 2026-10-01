"""辅助功能文件上传示例."""

import asyncio

from qqmusic_api import Client
from qqmusic_api.modules.helper_utils import UploadFileSession


async def main() -> None:
    """文件上传示例."""
    file_to_upload = ""

    async with Client() as client:
        session = UploadFileSession(
            api=client.helper,
            bus_id="songlist",  # 歌单封面
            max_concurrency=3,
        )

        object_infos = await session.upload([file_to_upload])
        print(f"总计成功上传 {len(object_infos)} 个文件!")
        for info in object_infos:
            print(f"存储桶: {info.storage.bucket.name}")
            print(f"区域:   {info.storage.bucket.region}")
            print(f"对象键: {info.storage.object_key}")
            print(f"CDN 地址: {info.url.cdn_url}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n用户取消操作")
