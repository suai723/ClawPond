from typing import Optional, List, Dict, Any, Callable, Awaitable
from uuid import UUID, uuid4
from datetime import datetime
import asyncio
import structlog

from ...schemas.message import MessageCreate, MessageUpdate, MessageFilter
from ...modules.room.service import RoomService
from ...modules.room.repository import RoomMember, MemberStatus
from .repository import Message, MessageType, MessageStatus
from .pg_repository import PGMessageRepository

logger = structlog.get_logger()


class MessageService:
    """消息服务"""

    def __init__(self, room_service: RoomService):
        self.room_service = room_service
        self.repository = PGMessageRepository()
        self._mention_pattern = r'@([a-zA-Z0-9_\-]+)'
        # Agent registry、广播回调、WS 连接检查，由外部注入以避免循环依赖
        self._agent_registry = None
        self._broadcast_callback: Optional[Callable[[UUID, Dict], Awaitable[None]]] = None
        self._ws_is_connected = None

    def set_agent_registry(self, agent_registry):
        """注入 AgentRegistry（避免循环依赖）"""
        self._agent_registry = agent_registry

    def set_broadcast_callback(self, callback: Callable[[UUID, Dict], Awaitable[None]]):
        """注入广播回调函数（由 WebSocketManager 提供）"""
        self._broadcast_callback = callback

    def set_ws_connected_check(self, fn):
        """注入 WebSocketManager.is_connected，若 Agent 已通过 WS 在线则跳过 HTTP A2A"""
        self._ws_is_connected = fn

    async def send_message(self, data: MessageCreate) -> Message:
        """发送消息"""
        logger.info(
            "send_message",
            room_id=str(data.room_id),
            sender_id=data.sender_id,
            sender_name=data.sender_name
        )
        
        # 验证房间是否存在
        room = await self.room_service.get_room(data.room_id)
        if not room:
            raise ValueError(f"Room {data.room_id} does not exist")
        
        # 验证发送者是否是房间成员
        member = await self.room_service.get_member(data.room_id, data.sender_id)
        if not member:
            raise ValueError(f"User {data.sender_id} is not a member of room {data.room_id}")
        
        # 解析结构化 mentions：
        # 客户端传来的 mentions 格式为 [{"agentId": "uuid", "username": "name"}, ...]
        # 或后备格式 ["username", ...]（纯文本解析）
        structured_mentions = await self._resolve_mentions(data.room_id, data.text, data.mentions)
        
        # 创建消息，mentions 存储为结构化列表
        message = Message(
            id=uuid4(),
            room_id=data.room_id,
            message_id=0,  # 由repository分配
            sender_id=data.sender_id,
            sender_name=data.sender_name,
            text=data.text,
            type=data.type,
            mentions=structured_mentions,
            attachments=data.attachments,
            reply_to=data.reply_to,
            tool_calls=data.tool_calls,
            metadata=data.metadata,
        )
        
        # 存储消息
        stored_message = await self.repository.create(message)
        logger.info(
            "message_stored",
            room_id=str(data.room_id),
            message_id=stored_message.message_id,
            sender=data.sender_id
        )

        # 更新成员最后活动时间
        await self.room_service.update_member_status(
            data.room_id,
            data.sender_id,
            MemberStatus.ONLINE
        )

        # 异步触发 Agent 响应（不阻塞消息发送）
        if structured_mentions and self._agent_registry:
            asyncio.create_task(
                self._trigger_agent_responses(stored_message, structured_mentions)
            )

        return stored_message

    async def _resolve_mentions(
        self,
        room_id: UUID,
        text: str,
        client_mentions: List = None,
    ) -> List[Dict]:
        """解析并验证 @mention，返回结构化列表 [{"agentId": str, "username": str}, ...]
        
        优先使用客户端传来的结构化 mentions（含 agentId），
        后备从文本正则解析并在当前 room 成员中按 username 查找。
        """
        result: List[Dict] = []
        seen_ids = set()

        # 1. 优先处理客户端传来的结构化 mentions
        if client_mentions:
            for item in client_mentions:
                if isinstance(item, dict) and "agentId" in item:
                    agent_id = item["agentId"]
                    username = item.get("username", "")
                    if agent_id not in seen_ids:
                        seen_ids.add(agent_id)
                        result.append({"agentId": agent_id, "username": username})
                    continue
                # 兼容旧格式：纯字符串 username
                if isinstance(item, str):
                    agent_info = await self._agent_registry.get_agent_by_name_in_room(item, room_id) if self._agent_registry else None
                    if agent_info and agent_info.agent_id not in seen_ids:
                        seen_ids.add(agent_info.agent_id)
                        result.append({"agentId": agent_info.agent_id, "username": agent_info.name})

        # 2. 后备：从文本中解析 @mention，在当前 room 成员里查
        import re
        text_mentions = re.findall(r'@([a-zA-Z0-9_\-]+)', text)
        if text_mentions and self._agent_registry:
            for username in set(text_mentions):
                agent_info = await self._agent_registry.get_agent_by_name_in_room(username, room_id)
                if agent_info and agent_info.agent_id not in seen_ids:
                    seen_ids.add(agent_info.agent_id)
                    result.append({"agentId": agent_info.agent_id, "username": agent_info.name})

        return result

    async def _trigger_agent_responses(
        self,
        original_message: Message,
        mentions: List[Dict],
    ):
        """检查提及的 Agent 并触发 A2A HTTP 调用（仅当 Agent 未通过 WS 在线时）"""
        for mention in mentions:
            agent_id = mention.get("agentId")
            agent_name = mention.get("username", "")
            if not agent_id:
                continue

            agent_info = await self._agent_registry.get_agent(agent_id)
            if not agent_info:
                continue

            logger.info(
                "triggering_agent_response",
                agent_id=agent_id,
                agent_name=agent_name,
                message_id=original_message.message_id,
            )

            try:
                # 若 Agent 已通过 WebSocket 连接在线，广播已送达，跳过 HTTP A2A
                ws_user_id = f"agent-{agent_id}"
                if self._ws_is_connected and self._ws_is_connected(
                    original_message.room_id, ws_user_id
                ):
                    logger.info(
                        "agent_ws_connected_skip_http",
                        agent_id=agent_id,
                        room_id=str(original_message.room_id),
                    )
                    continue

                context = {
                    "room_id": str(original_message.room_id),
                    "sender_id": original_message.sender_id,
                    "sender_name": original_message.sender_name,
                    "message_id": original_message.message_id,
                }
                a2a_result = await self._agent_registry.call_agent(
                    agent_id=agent_id,
                    message=original_message.text,
                    context=context,
                )

                # 解析 A2A 响应文本
                reply_text = self._extract_a2a_text(a2a_result, agent_info.name)

                # 创建 Agent 回复消息
                reply_message = Message(
                    id=uuid4(),
                    room_id=original_message.room_id,
                    message_id=0,
                    sender_id=ws_user_id,
                    sender_name=agent_info.name,
                    text=reply_text,
                    type=MessageType.TEXT,
                    reply_to=original_message.message_id,
                    metadata={"agent": True, "a2a_task_id": a2a_result.get("id", "")},
                )
                stored_reply = await self.repository.create(reply_message)

                # 广播给房间所有人
                if self._broadcast_callback:
                    await self._broadcast_callback(
                        original_message.room_id,
                        {"event": "message", "data": stored_reply.to_dict()},
                    )

                logger.info(
                    "agent_reply_broadcast",
                    agent_id=agent_id,
                    reply_message_id=stored_reply.message_id,
                )

            except Exception as e:
                logger.error(
                    "agent_response_failed",
                    agent_id=agent_id,
                    error=str(e),
                )

    def _extract_a2a_text(self, a2a_result: Dict[str, Any], agent_name: str) -> str:
        """从 A2A 响应中提取文本内容"""
        try:
            artifacts = a2a_result.get("artifacts", [])
            for artifact in artifacts:
                parts = artifact.get("parts", [])
                for part in parts:
                    if "text" in part:
                        return part["text"]
            # 兼容直接返回 result.text 格式
            if "result" in a2a_result:
                result = a2a_result["result"]
                if isinstance(result, str):
                    return result
                if isinstance(result, dict):
                    content = result.get("content", [])
                    for c in content:
                        if c.get("type") == "text":
                            return c.get("text", "")
        except Exception:
            pass
        return f"[{agent_name} 已收到消息，但响应格式不标准]"
    
    async def edit_message(
        self,
        room_id: UUID,
        message_id: int,
        editor_id: str,
        text: str,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Optional[Message]:
        """编辑消息"""
        logger.info(
            "edit_message",
            room_id=str(room_id),
            message_id=message_id,
            editor_id=editor_id
        )
        
        # 获取消息
        message = await self.repository.get_message(room_id, message_id)
        if not message:
            logger.warning("message_not_found", room_id=str(room_id), message_id=message_id)
            return None
        
        # 验证编辑权限（只能编辑自己发送的消息）
        if message.sender_id != editor_id:
            logger.warning(
                "permission_denied_edit",
                room_id=str(room_id),
                message_id=message_id,
                editor_id=editor_id,
                sender_id=message.sender_id
            )
            raise PermissionError("You can only edit your own messages")
        
        # 解析新的提及
        new_mentions = await self.repository.parse_mentions(text)
        
        # 更新消息
        updated_message = await self.repository.update_message(
            room_id,
            message_id,
            text,
            metadata
        )
        
        logger.info(
            "message_edited",
            room_id=str(room_id),
            message_id=message_id,
            editor_id=editor_id
        )
        
        return updated_message
    
    async def delete_message(
        self,
        room_id: UUID,
        message_id: int,
        deleter_id: str
    ) -> bool:
        """删除消息"""
        logger.info(
            "delete_message",
            room_id=str(room_id),
            message_id=message_id,
            deleter_id=deleter_id
        )
        
        # 获取消息
        message = await self.repository.get_message(room_id, message_id)
        if not message:
            logger.warning("message_not_found", room_id=str(room_id), message_id=message_id)
            return False
        
        # 获取删除者信息
        deleter = await self.room_service.get_member(room_id, deleter_id)
        if not deleter:
            logger.warning("deleter_not_member", room_id=str(room_id), user_id=deleter_id)
            raise PermissionError("Only room members can delete messages")
        
        # 验证删除权限（发送者或房间管理员）
        can_delete = (
            message.sender_id == deleter_id or  # 自己发送的消息
            deleter.role in ["owner", "moderator"]  # 房间管理员
        )
        
        if not can_delete:
            logger.warning(
                "permission_denied_delete",
                room_id=str(room_id),
                message_id=message_id,
                deleter_id=deleter_id,
                sender_id=message.sender_id,
                deleter_role=deleter.role
            )
            raise PermissionError("You don't have permission to delete this message")
        
        # 删除消息
        result = await self.repository.delete_message(room_id, message_id)
        
        if result:
            logger.info(
                "message_deleted",
                room_id=str(room_id),
                message_id=message_id,
                deleter_id=deleter_id
            )
        else:
            logger.error(
                "delete_failed",
                room_id=str(room_id),
                message_id=message_id,
                deleter_id=deleter_id
            )
        
        return result
    
    async def get_messages(self, filter_params: MessageFilter) -> List[Message]:
        """获取消息列表"""
        logger.debug(
            "get_messages",
            room_id=str(filter_params.room_id),
            start_message_id=filter_params.start_message_id,
            limit=filter_params.limit
        )
        
        return await self.repository.get_messages(
            room_id=filter_params.room_id,
            start_message_id=filter_params.start_message_id,
            limit=filter_params.limit,
            mentioning=filter_params.mentioning,
            from_user=filter_params.from_user,
            message_type=filter_params.type,
        )
    
    async def get_message(self, room_id: UUID, message_id: int) -> Optional[Message]:
        """获取单条消息"""
        return await self.repository.get_message(room_id, message_id)
    
    async def search_messages(
        self,
        room_id: UUID,
        query: str,
        limit: int = 20
    ) -> List[Message]:
        """搜索消息"""
        return await self.repository.search_messages(room_id, query, limit)
    
    async def get_message_stats(self, room_id: UUID) -> Dict[str, Any]:
        """获取消息统计"""
        return await self.repository.get_message_stats(room_id)
    
    async def get_latest_message_id(self, room_id: UUID) -> int:
        """获取最新的消息ID"""
        return await self.repository.get_latest_message_id(room_id)
    
    async def get_recent_messages(self, room_id: UUID, limit: int = 20) -> List[Message]:
        """获取最近的消息"""
        latest_id = await self.get_latest_message_id(room_id)
        return await self.repository.get_messages(
            room_id=room_id,
            start_message_id=max(0, latest_id - limit),
            limit=limit
        )
    
    async def get_messages_after_id(
        self,
        room_id: UUID,
        last_message_id: int,
        limit: int = 50
    ) -> List[Message]:
        """获取指定ID之后的消息"""
        return await self.repository.get_messages(
            room_id=room_id,
            start_message_id=last_message_id,
            limit=limit
        )
    
    async def validate_mentions(
        self,
        room_id: UUID,
        text: str,
        client_mentions: List = None,
    ) -> List[Dict]:
        """验证并解析提及，返回结构化 mentions 列表"""
        return await self._resolve_mentions(room_id, text, client_mentions)