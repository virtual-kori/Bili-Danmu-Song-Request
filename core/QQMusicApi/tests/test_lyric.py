"""歌词模块测试."""

from qqmusic_api import Client


async def test_get_lyric_by_id(client: Client) -> None:
    """测试通过歌曲 ID 获取歌词."""
    result = await client.lyric.get_lyric(value=100)
    assert result.songid == 100
    assert result.lyric


async def test_get_lyric_with_qrc(client: Client) -> None:
    """测试获取逐字歌词."""
    result = await client.lyric.get_lyric(value=100, qrc=True)
    assert result.lyric


async def test_get_lyric_with_trans(client: Client) -> None:
    """测试获取带翻译的歌词."""
    result = await client.lyric.get_lyric(value=100, trans=True)
    assert result.trans is not None


async def test_get_lyric_with_roma(client: Client) -> None:
    """测试获取带罗马音的歌词."""
    result = await client.lyric.get_lyric(value=100, roma=True)
    assert result.roma is not None


async def test_get_lyric_with_singing_annotations(client: Client) -> None:
    """测试获取助唱标注歌词."""
    result = await client.lyric.get_lyric(value=4835784, singing_annotations=True)
    assert result.songid == 4835784


async def test_get_lyric_with_all_options(client: Client) -> None:
    """测试获取包含所有选项的歌词."""
    result = await client.lyric.get_lyric(
        value=4835784,
        qrc=True,
        trans=True,
        roma=True,
        singing_annotations=True,
    )
    assert result.lyric


async def test_get_singing_annotations_info(client: Client) -> None:
    """测试获取助唱标注歌词信息."""
    result = await client.lyric.get_singing_annotations_info(songid=4835784)
    assert result.has_singing_annotations_lyric is True


async def test_get_multi_style_trans_lyric(client: Client) -> None:
    """测试获取多风格翻译歌词."""
    result = await client.lyric.get_multi_style_trans_lyric(songid=496097762)
    assert isinstance(result.lyrics, list)


async def test_is_ai_dict_exists(client: Client) -> None:
    """测试检查是否存在 AI 歌词词典."""
    result = await client.lyric.is_ai_dict_exists(songid=7137686)
    assert isinstance(result.exists, bool)


async def test_get_ai_dict_info(client: Client) -> None:
    """测试获取 AI 歌词词典信息."""
    result = await client.lyric.get_ai_dict(songid=7137686)
    assert isinstance(result.dict_list, list)
