from typing import Optional, List
from pydantic import BaseModel, Field
from datetime import datetime
import uuid
from enum import Enum


class RoomStatus(str, Enum):
    ACTIVE = "active"
    ARCHIVED = "archived"
    DELETED = "deleted"


class RoomCreate(BaseModel):
    """创建房间请求 — 密码由服务端生成，无需客户端传入"""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = Field(None, max_length=1000)
    max_members: int = Field(default=50, ge=1, le=1000)
    message_retention: int = Field(default=0, ge=0)
    allow_anonymous: bool = Field(default=False)
    allow_media_upload: bool = Field(default=True)
    media_max_size: int = Field(default=52428800)


class RoomUpdate(BaseModel):
    """更新房间请求（通过密码定位房间）"""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = Field(None, max_length=1000)
    max_members: Optional[int] = Field(None, ge=1, le=1000)
    message_retention: Optional[int] = Field(None, ge=0)
    allow_anonymous: Optional[bool] = None
    allow_media_upload: Optional[bool] = None
    media_max_size: Optional[int] = Field(None, ge=0)


class RoomResponse(BaseModel):
    """房间响应"""
    id: uuid.UUID
    name: str
    description: Optional[str] = None
    max_members: int
    message_retention: int
    allow_anonymous: bool
    allow_media_upload: bool
    media_max_size: int
    status: RoomStatus
    created_at: datetime
    updated_at: datetime
    created_by: str
    member_count: int
    last_message_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class RoomCreateResponse(RoomResponse):
    """创建房间响应 — 包含一次性明文密码，此后不再返回"""
    plain_password: str


class RoomListResponse(BaseModel):
    """房间列表响应"""
    rooms: List[RoomResponse]
    total: int
    page: int
    page_size: int


class RoomCreateRequest(RoomCreate):
    """创建房间请求（含创建者信息，与前端扁平格式对应）"""
    user_id: str = Field(..., min_length=1, max_length=255)
    username: str = Field(..., min_length=1, max_length=255)


class RoomJoinRequest(BaseModel):
    """加入房间请求 — password 即服务端颁发的 access_token"""
    user_id: str = Field(..., min_length=1, max_length=255)
    username: str = Field(..., min_length=1, max_length=255)
    password: str = Field(..., min_length=1, max_length=100)
    room_id: Optional[str] = Field(None, max_length=36)
    user_type: str = Field(default="human", pattern="^(human|agent|system)$")
    a2a_endpoint: Optional[str] = Field(None, max_length=512)
    agent_card_url: Optional[str] = Field(None, max_length=512)
    agent_id: Optional[str] = Field(None, max_length=255)


class RoomPasswordRequest(BaseModel):
    """通用房间密码请求基类（leave / delete / update 等操作）"""
    password: str = Field(..., min_length=1, max_length=100)
    user_id: str = Field(..., min_length=1, max_length=255)


class RoomUpdateRequest(RoomPasswordRequest):
    """更新房间请求（含密码鉴权 + 更新字段）"""
    update: RoomUpdate


class RoomMembersRequest(BaseModel):
    """获取房间成员列表请求"""
    password: str = Field(..., min_length=1, max_length=100)


class RoomLeaveRequest(BaseModel):
    """离开房间请求"""
    password: str = Field(..., min_length=1, max_length=100)
    user_id: str = Field(..., min_length=1, max_length=255)


class RoomMemberResponse(BaseModel):
    """房间成员响应"""
    id: uuid.UUID
    user_id: str
    username: str
    user_type: str
    role: str
    status: str
    joined_at: datetime
    last_active_at: datetime
    a2a_endpoint: Optional[str] = None
    agent_card_url: Optional[str] = None
    agent_id: Optional[str] = None

    class Config:
        from_attributes = True
