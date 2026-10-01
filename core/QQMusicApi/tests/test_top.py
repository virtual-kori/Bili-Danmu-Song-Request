"""排行榜模块测试."""

from qqmusic_api import Client


async def test_get_category(client: Client) -> None:
    """测试获取所有排行榜分类结构化结果."""
    result = await client.top.get_category()

    assert result.group
    assert result.group[0].name
    assert result.group[0].toplist
    assert result.group[0].toplist[0].id > 0
    assert result.group[0].toplist[0].name


async def test_get_detail(client: Client) -> None:
    """测试获取排行榜详情结构化结果."""
    result = await client.top.get_detail(top_id=62, tag=False)

    assert result.info.id == 62
    assert result.info.name
    assert result.songs


async def test_get_detail_with_pagination(client: Client) -> None:
    """测试分页获取排行榜歌曲列表结构."""
    result = await client.top.get_detail(top_id=62, num=5, page=1, tag=False)

    assert len(result.songs) == 5


async def test_get_detail_page2(client: Client) -> None:
    """测试获取排行榜歌曲列表第二页结构."""
    result = await client.top.get_detail(top_id=62, num=10, page=2, tag=False)

    assert result.info.id == 62
    assert result.info.name
    assert result.songs


async def test_get_detail_without_tag(client: Client) -> None:
    """测试关闭标签时仍返回排行榜歌曲."""
    result = await client.top.get_detail(top_id=62, tag=False)

    assert result.song_tags == []
    assert result.songs


async def test_get_detail_with_tag(client: Client) -> None:
    """测试开启标签时返回排行榜标签."""
    result = await client.top.get_detail(top_id=62, tag=True)

    assert result.song_tags is not None
    assert result.songs
