"""私信只读接口示例."""

import asyncio

from qqmusic_api import Client, Credential
from qqmusic_api.models.private_message import PrivateMessageSession

MUSICID = 0
MUSICKEY = ""

credential = Credential(musicid=MUSICID, musickey=MUSICKEY)


def format_session_preview(index: int, session: PrivateMessageSession) -> str:
    """格式化私信会话预览."""
    user = session.user
    latest_message = session.new_msg
    metadata = latest_message.meta_data if latest_message else None
    latest_text = metadata.content if metadata and metadata.content else latest_message.tips if latest_message else ""
    return (
        f"{index}. session_id={session.session_id}, "
        f"uin={user.uin if user else ''}, "
        f"nick={user.nick if user else ''}, "
        f"unread={session.new_msg_cnt}, "
        f"last={latest_text or '<无文本预览>'}"
    )


async def main() -> None:
    """运行私信只读接口示例."""
    async with Client(credential) as client:
        session_result = await client.private_message.get_sessions(size=10)
        print(f"会话列表: has_more={session_result.has_more}, count={len(session_result.sessions)}")

        if not session_result.sessions:
            print("当前账号没有可展示的私信会话。")
            return

        print("可用会话:")
        for index, session in enumerate(session_result.sessions, start=1):
            print(format_session_preview(index, session))

        first_session = session_result.sessions[0]
        target_user = first_session.user
        message_result = await client.private_message.get_messages(
            session_id=first_session.session_id,
            user_id=target_user.uin if target_user else "",
            size=20,
        )
        print(f"首个会话消息: has_more={message_result.has_more}, count={len(message_result.messages)}")

        entries_result = await client.private_message.get_chat_entries(
            [1, 2],
            from_user_type=0,
            user_id=target_user.uin if target_user else None,
        )
        entry_count = sum(len(entries) for entries in entries_result.entries.values())
        print(f"聊天入口: ret_code={entries_result.ret_code}, entry_count={entry_count}")

        media_msg_ids = [
            message.id for message in message_result.messages if message.id and message.msg_type in {2, 3, 5, 6}
        ]
        if not media_msg_ids:
            print("当前会话没有可用于预览详情查询的图片或视频消息。")
            return

        detail_result = await client.private_message.get_media_message_details(
            first_session.session_id,
            media_msg_ids[:5],
        )
        print(f"媒体消息详情: count={len(detail_result.msg_ids)}")


asyncio.run(main())
