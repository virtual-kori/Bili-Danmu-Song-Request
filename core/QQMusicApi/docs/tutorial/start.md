# 快速开始

本页提供一个从安装到跑通第一个请求的最短路径。

!!! example

    可在 GitHub 上查看[使用示例](https://github.com/L-1124/QQMusicApi/tree/main/examples)

## 1. 安装

```bash
pip install qqmusic-api-python
```

## 2. 创建 Client

绝大多数场景从 `Client` 开始。它负责管理会话、设备信息、平台参数和各业务模块入口。推荐使用异步上下文（`async with`），这样可以自动关闭底层网络会话：

```python
import asyncio

from qqmusic_api import Client


async def main() -> None:
    async with Client() as client:
        pass


asyncio.run(main())
```

## 3. 发起第一个请求

下面的示例会搜索 “周杰伦”：

```python
import asyncio

from qqmusic_api import Client


async def main() -> None:
    async with Client() as client:
        result = await client.search.search_by_type(keyword="周杰伦", num=5)
        print(result)


asyncio.run(main())
```

## 4. 何时需要 Credential

公开接口中有一部分无需登录即可访问；涉及用户资料、收藏、下载会员歌曲等场景时，通常需要 `Credential`。

```python
import asyncio

from qqmusic_api import Client, Credential


async def main() -> None:
    credential = Credential(musicid=0, musickey="")
    async with Client(credential=credential) as client:
        pass


asyncio.run(main())
```

## 5. 下载歌曲

获取歌曲文件链接需要登录凭证。详细用法请参阅 [下载歌曲](download.md)。
