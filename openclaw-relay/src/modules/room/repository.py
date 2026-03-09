from typing import Optional, List, Dict, Any
from uuid import UUID, uuid4
import asyncio
from datetime import datetime
from enum import Enum

from ...schemas.room import RoomCreate, RoomUpdate


class RoomStatus(str, Enum):
    ACTIVE = "active"
    ARCHIVED = "archived"
    DELETED = "deleted"


class MemberRole(str, Enum):
    OWNER = "owner"
    MODERATOR = "moderator"
    MEMBER = "member"


class MemberStatus(str, Enum):
    ONLINE = "online"
    OFFLINE = "offline"
    IDLE = "idle"


class UserType(str, Enum):
    HUMAN = "human"
    AGENT = "agent"
    SYSTEM = "system"


class Room:
    """房间模型"""
    def __init__(
        self,
        id: UUID,
        name: str,
        password_hash: str,
        created_by: str,
        access_token: str = "",
        description: Optional[str] = None,
        max_members: int = 50,
        message_retention: int = 0,
        allow_anonymous: bool = False,
        allow_media_upload: bool = True,
        media_max_size: int = 52428800,
    ):
        self.id = id
        self.name = name
        self.description = description
        self.password_hash = password_hash
        self.access_token = access_token
        self.max_members = max_members
        self.message_retention = message_retention
        self.allow_anonymous = allow_anonymous
        self.allow_media_upload = allow_media_upload
        self.media_max_size = media_max_size
        self.status = RoomStatus.ACTIVE
        self.created_by = created_by
        self.created_at = datetime.utcnow()
        self.updated_at = datetime.utcnow()
        self._members: Dict[str, 'RoomMember'] = {}
    
    def add_member(self, member: 'RoomMember'):
        self._members[member.user_id] = member
    
    def remove_member(self, user_id: str):
        self._members.pop(user_id, None)
    
    def get_member(self, user_id: str) -> Optional['RoomMember']:
        return self._members.get(user_id)
    
    @property
    def members(self) -> List['RoomMember']:
        return list(self._members.values())
    
    @property
    def member_count(self) -> int:
        return len(self._members)


class RoomMember:
    """房间成员模型"""
    def __init__(
        self,
        id: UUID,
        room_id: UUID,
        user_id: str,
        username: str,
        user_type: UserType = UserType.HUMAN,
        role: MemberRole = MemberRole.MEMBER,
        a2a_endpoint: Optional[str] = None,
        agent_card_url: Optional[str] = None,
        agent_id: Optional[str] = None,
    ):
        self.id = id
        self.room_id = room_id
        self.user_id = user_id
        self.username = username
        self.user_type = user_type
        self.role = role
        self.a2a_endpoint = a2a_endpoint
        self.agent_card_url = agent_card_url
        self.agent_id = agent_id  # 服务端分发的 UUID（仅 agent 成员有值）
        self.joined_at = datetime.utcnow()
        self.last_active_at = datetime.utcnow()
        self.status = MemberStatus.ONLINE


class InMemoryRoomRepository:
    """内存存储的房间仓库"""
    
    def __init__(self):
        self._rooms: Dict[UUID, Room] = {}
        self._members: Dict[UUID, Dict[str, RoomMember]] = {}  # room_id -> {user_id: member}
        self._lock = asyncio.Lock()
    
    async def create(self, room: Room) -> Room:
        """创建房间"""
        async with self._lock:
            self._rooms[room.id] = room
            self._members[room.id] = {}
        return room
    
    async def get_by_id(self, room_id: UUID) -> Optional[Room]:
        """通过ID获取房间"""
        return self._rooms.get(room_id)
    
    async def get_by_name(self, name: str) -> Optional[Room]:
        """通过名称获取房间"""
        for room in self._rooms.values():
            if room.name == name:
                return room
        return None
    
    async def list(
        self, 
        status: RoomStatus = RoomStatus.ACTIVE,
        page: int = 1,
        page_size: int = 20
    ) -> tuple[List[Room], int]:
        """获取房间列表"""
        start = (page - 1) * page_size
        end = start + page_size
        
        filtered_rooms = [
            room for room in self._rooms.values()
            if room.status == status
        ]
        
        total = len(filtered_rooms)
        rooms = filtered_rooms[start:end]
        
        return rooms, total
    
    async def update(self, room_id: UUID, update_data: Dict[str, Any]) -> Optional[Room]:
        """更新房间"""
        async with self._lock:
            room = self._rooms.get(room_id)
            if not room:
                return None
            
            for key, value in update_data.items():
                if hasattr(room, key):
                    setattr(room, key, value)
            
            room.updated_at = datetime.utcnow()
            return room
    
    async def delete(self, room_id: UUID) -> bool:
        """删除房间"""
        async with self._lock:
            if room_id in self._rooms:
                del self._rooms[room_id]
                self._members.pop(room_id, None)
                return True
            return False
    
    async def add_member(self, member: RoomMember) -> RoomMember:
        """添加成员"""
        async with self._lock:
            if member.room_id not in self._members:
                self._members[member.room_id] = {}
            
            self._members[member.room_id][member.user_id] = member
            
            # 同时添加到房间对象
            room = self._rooms.get(member.room_id)
            if room:
                room.add_member(member)
            
            return member
    
    async def get_member(self, room_id: UUID, user_id: str) -> Optional[RoomMember]:
        """获取成员"""
        room_members = self._members.get(room_id)
        if not room_members:
            return None
        return room_members.get(user_id)
    
    async def list_members(self, room_id: UUID) -> List[RoomMember]:
        """获取房间成员列表"""
        room_members = self._members.get(room_id)
        if not room_members:
            return []
        return list(room_members.values())
    
    async def list_members_by_role(self, room_id: UUID, role: MemberRole) -> List[RoomMember]:
        """通过角色获取成员列表"""
        members = await self.list_members(room_id)
        return [member for member in members if member.role == role]
    
    async def count_members(self, room_id: UUID) -> int:
        """统计房间成员数"""
        room_members = self._members.get(room_id)
        if not room_members:
            return 0
        return len(room_members)
    
    async def remove_member(self, room_id: UUID, user_id: str) -> bool:
        """移除成员"""
        async with self._lock:
            room_members = self._members.get(room_id)
            if not room_members:
                return False
            
            if user_id in room_members:
                del room_members[user_id]
                
                # 同时从房间对象中移除
                room = self._rooms.get(room_id)
                if room:
                    room.remove_member(user_id)
                
                return True
            return False
    
    async def update_member_status(
        self, 
        room_id: UUID, 
        user_id: str, 
        status: MemberStatus
    ) -> bool:
        """更新成员状态"""
        async with self._lock:
            member = await self.get_member(room_id, user_id)
            if not member:
                return False
            
            member.status = status
            member.last_active_at = datetime.utcnow()
            return True
    
    async def update_member_role(
        self, 
        room_id: UUID, 
        user_id: str,
        role: MemberRole
    ) -> bool:
        """更新成员角色"""
        async with self._lock:
            member = await self.get_member(room_id, user_id)
            if not member:
                return False
            
            member.role = role
            return True