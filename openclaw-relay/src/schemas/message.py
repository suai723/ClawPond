from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field
from datetime import datetime
import uuid
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


class Attachment(BaseModel):
    """媒体附件"""
    type: str = Field(..., pattern="^(image|audio|video|file)$")
    url: str
    filename: str
    size: int = Field(ge=0)
    mime_type: str
    thumbnail_url: Optional[str] = None


class ToolCall(BaseModel):
    """工具调用"""
    tool_id: str
    tool_name: str
    params: Dict[str, Any] = Field(default_factory=dict)
    result: Optional[Any] = None
    error: Optional[str] = None


class MessageCreate(BaseModel):
    """创建消息请求"""
    room_id: uuid.UUID
    sender_id: str = Field(..., min_length=1, max_length=255)
    sender_name: str = Field(..., min_length=1, max_length=255)
    text: str = Field(..., min_length=1, max_length=10000)
    type: MessageType = MessageType.TEXT
    mentions: List[Any] = Field(default_factory=list)
    attachments: Optional[List[Attachment]] = None
    reply_to: Optional[int] = None
    tool_calls: Optional[List[ToolCall]] = None
    metadata: Optional[Dict[str, Any]] = None


class MessageUpdate(BaseModel):
    """更新消息请求"""
    text: Optional[str] = Field(None, min_length=1, max_length=10000)
    metadata: Optional[Dict[str, Any]] = None


class MessageResponse(BaseModel):
    """消息响应"""
    id: uuid.UUID
    room_id: uuid.UUID
    message_id: int
    sender_id: str
    sender_name: str
    text: str
    type: MessageType
    mentions: List[Any]
    attachments: Optional[List[Attachment]] = None
    reply_to: Optional[int] = None
    tool_calls: Optional[List[ToolCall]] = None
    tool_results: Optional[Dict[str, Any]] = None
    status: MessageStatus
    created_at: datetime
    edited_at: Optional[datetime] = None
    deleted_at: Optional[datetime] = None
    metadata: Optional[Dict[str, Any]] = None
    
    class Config:
        from_attributes = True


class MessageListResponse(BaseModel):
    """消息列表响应"""
    messages: List[MessageResponse]
    total: int
    page: int
    page_size: int
    next_cursor: Optional[int] = None


class MessageFilter(BaseModel):
    """消息过滤器"""
    room_id: uuid.UUID
    start_message_id: Optional[int] = None
    limit: int = Field(default=20, ge=1, le=100)
    mentioning: Optional[List[str]] = None
    from_user: Optional[List[str]] = None
    type: Optional[MessageType] = None
    time_range_start: Optional[datetime] = None
    time_range_end: Optional[datetime] = None


class WSSendMessageRequest(BaseModel):
    """WebSocket发送消息请求"""
    method: str = Field("sendMessage", pattern="^sendMessage$")
    params: Dict[str, Any]


class WSSendMessageParams(BaseModel):
    """WebSocket发送消息参数"""
    text: str = Field(..., min_length=1, max_length=10000)
    mentions: List[Any] = Field(default_factory=list)
    reply_to: Optional[int] = None
    attachments: Optional[List[Attachment]] = None
    metadata: Optional[Dict[str, Any]] = None


class WSEventMessage(BaseModel):
    """WebSocket消息事件"""
    event: str = Field("message", pattern="^message$")
    data: MessageResponse


class WSEventMemberJoined(BaseModel):
    """WebSocket成员加入事件"""
    event: str = Field("memberJoined", pattern="^memberJoined$")
    data: Dict[str, Any]


class WSEventMemberLeft(BaseModel):
    """WebSocket成员离开事件"""
    event: str = Field("memberLeft", pattern="^memberLeft$")
    data: Dict[str, Any]


class WSEventMemberStatus(BaseModel):
    """WebSocket成员状态变更事件"""
    event: str = Field("memberStatus", pattern="^memberStatus$")
    data: Dict[str, Any]


class WSEventMentioned(BaseModel):
    """WebSocket提及事件"""
    event: str = Field("mentioned", pattern="^mentioned$")
    data: Dict[str, Any]