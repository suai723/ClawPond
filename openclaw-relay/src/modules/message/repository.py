from typing import Optional, List, Dict, Any
from uuid import UUID, uuid4
import asyncio
from datetime import datetime
import re
from enum import Enum


class MessageType(str, Enum):
    TEXT = "text"
    MEDIA = "media"
    SYSTEM = "system"
    COMMAND = "command"


class MessageStatus(str, Enum):
    SENT = "sent"
    DELIVERED = "delivered"
    EDITED = "edited"
    DELETED = "deleted"


class Message:
    """消息模型"""
    def __init__(
        self,
        id: UUID,
        room_id: UUID,
        message_id: int,
        sender_id: str,
        sender_name: str,
        text: str,
        type: MessageType = MessageType.TEXT,
        mentions: List[Any] = None,
        attachments: List[Dict[str, Any]] = None,
        reply_to: Optional[int] = None,
        reply_preview: Optional[str] = None,
        tool_calls: List[Dict[str, Any]] = None,
        tool_results: Dict[str, Any] = None,
        metadata: Dict[str, Any] = None,
    ):
        self.id = id
        self.room_id = room_id
        self.message_id = message_id
        self.sender_id = sender_id
        self.sender_name = sender_name
        self.text = text
        self.type = type
        self.mentions = mentions or []
        self.attachments = attachments or []
        self.reply_to = reply_to
        self.reply_preview = reply_preview
        self.tool_calls = tool_calls or []
        self.tool_results = tool_results or {}
        self.metadata = metadata or {}
        self.status = MessageStatus.SENT
        self.created_at = datetime.utcnow()
        self.edited_at = None
        self.deleted_at = None
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            "id": str(self.id),
            "room_id": str(self.room_id),
            "message_id": self.message_id,
            "sender_id": self.sender_id,
            "sender_name": self.sender_name,
            "text": self.text,
            "type": self.type,
            "mentions": self.mentions,
            "attachments": self.attachments,
            "reply_to": self.reply_to,
            "reply_preview": self.reply_preview,
            "tool_calls": self.tool_calls,
            "tool_results": self.tool_results,
            "metadata": self.metadata,
            "status": self.status,
            "created_at": self.created_at.isoformat(),
            "edited_at": self.edited_at.isoformat() if self.edited_at else None,
            "deleted_at": self.deleted_at.isoformat() if self.deleted_at else None,
        }


class InMemoryMessageRepository:
    """内存存储的消息仓库"""
    
    def __init__(self):
        self._messages: Dict[str, Dict[int, Message]] = {}  # room_id -> {message_id: message}
        self._message_counter: Dict[str, int] = {}  # room_id -> next_message_id
        self._lock = asyncio.Lock()
        self._mention_pattern = re.compile(r'@([a-zA-Z0-9_\-]+)')
    
    async def create(self, message: Message) -> Message:
        """创建消息"""
        async with self._lock:
            room_id = str(message.room_id)
            
            # 初始化房间的消息计数器
            if room_id not in self._message_counter:
                self._message_counter[room_id] = 0
                self._messages[room_id] = {}
            
            # 确保message_id是递增的
            if message.message_id <= 0:
                self._message_counter[room_id] += 1
                message.message_id = self._message_counter[room_id]
            
            # 存储消息
            self._messages[room_id][message.message_id] = message
            
            return message
    
    async def get_message(self, room_id: UUID, message_id: int) -> Optional[Message]:
        """获取消息"""
        room_key = str(room_id)
        if room_key not in self._messages:
            return None
        return self._messages[room_key].get(message_id)
    
    async def get_messages(
        self,
        room_id: UUID,
        start_message_id: Optional[int] = None,
        limit: int = 20,
        mentioning: Optional[List[str]] = None,
        from_user: Optional[List[str]] = None,
        message_type: Optional[MessageType] = None,
    ) -> List[Message]:
        """获取消息列表"""
        room_key = str(room_id)
        if room_key not in self._messages:
            return []
        
        messages = list(self._messages[room_key].values())
        
        # 按message_id排序
        messages.sort(key=lambda x: x.message_id)
        
        # 应用过滤条件
        filtered_messages = []
        for msg in messages:
            # 按起始message_id过滤
            if start_message_id and msg.message_id <= start_message_id:
                continue
            
            # 按@提及过滤
            if mentioning and not any(m in msg.mentions for m in mentioning):
                continue
            
            # 按发送者过滤
            if from_user and msg.sender_id not in from_user:
                continue
            
            # 按消息类型过滤
            if message_type and msg.type != message_type:
                continue
            
            filtered_messages.append(msg)
            
            # 限制数量
            if len(filtered_messages) >= limit:
                break
        
        return filtered_messages
    
    async def update_message(
        self,
        room_id: UUID,
        message_id: int,
        text: str,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Optional[Message]:
        """更新消息"""
        async with self._lock:
            message = await self.get_message(room_id, message_id)
            if not message:
                return None
            
            message.text = text
            if metadata:
                message.metadata.update(metadata)
            message.edited_at = datetime.utcnow()
            message.status = MessageStatus.EDITED
            
            return message
    
    async def delete_message(
        self,
        room_id: UUID,
        message_id: int
    ) -> bool:
        """删除消息"""
        async with self._lock:
            room_key = str(room_id)
            if room_key not in self._messages:
                return False
            
            message = self._messages[room_key].get(message_id)
            if not message:
                return False
            
            # 软删除
            message.deleted_at = datetime.utcnow()
            message.status = MessageStatus.DELETED
            
            return True
    
    async def search_messages(
        self,
        room_id: UUID,
        query: str,
        limit: int = 20
    ) -> List[Message]:
        """搜索消息"""
        room_key = str(room_id)
        if room_key not in self._messages:
            return []
        
        messages = list(self._messages[room_key].values())
        matching_messages = []
        
        for msg in messages:
            if query.lower() in msg.text.lower():
                matching_messages.append(msg)
            
            if len(matching_messages) >= limit:
                break
        
        return matching_messages
    
    async def parse_mentions(self, text: str) -> List[str]:
        """解析消息中的@提及"""
        mentions = self._mention_pattern.findall(text)
        return list(set(mentions))
    
    async def get_message_stats(self, room_id: UUID) -> Dict[str, Any]:
        """获取消息统计"""
        room_key = str(room_id)
        if room_key not in self._messages:
            return {"total_messages": 0, "messages_by_user": {}}
        
        messages = self._messages[room_key].values()
        total = len(messages)
        
        # 统计每个用户的消息数
        messages_by_user = {}
        for msg in messages:
            if msg.sender_id not in messages_by_user:
                messages_by_user[msg.sender_id] = 0
            messages_by_user[msg.sender_id] += 1
        
        return {
            "total_messages": total,
            "messages_by_user": messages_by_user,
        }
    
    async def get_latest_message_id(self, room_id: UUID) -> int:
        """获取最新的消息ID"""
        room_key = str(room_id)
        if room_key not in self._message_counter:
            return 0
        return self._message_counter[room_key]