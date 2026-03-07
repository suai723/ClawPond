from typing import Optional, List
from uuid import UUID, uuid4
import bcrypt
import structlog
from datetime import datetime

from ...schemas.room import RoomCreate, RoomUpdate, RoomJoinRequest
from .repository import Room, RoomMember, RoomStatus, MemberRole, MemberStatus, UserType
from .pg_repository import PGRoomRepository

logger = structlog.get_logger()


class RoomService:
    """房间服务"""
    
    def __init__(self):
        self.repository = PGRoomRepository()
    
    async def create_room(
        self, 
        data: RoomCreate, 
        creator_id: str, 
        creator_username: str
    ) -> Room:
        """创建房间"""
        logger.info("create_room", name=data.name, creator=creator_id)
        
        # 检查房间名是否已存在
        existing = await self.repository.get_by_name(data.name)
        if existing:
            logger.warning("room_already_exists", name=data.name)
            raise ValueError(f"Room '{data.name}' already exists")
        
        # 加密密码
        password_hash = bcrypt.hashpw(
            data.password.encode('utf-8'), 
            bcrypt.gensalt()
        ).decode('utf-8')
        
        # 创建房间
        room = Room(
            id=uuid4(),
            name=data.name,
            password_hash=password_hash,
            created_by=creator_id,
            description=data.description,
            max_members=data.max_members,
            message_retention=data.message_retention,
            allow_anonymous=data.allow_anonymous,
            allow_media_upload=data.allow_media_upload,
            media_max_size=data.media_max_size,
        )
        
        room = await self.repository.create(room)
        logger.info("room_created", room_id=room.id, name=room.name)
        
        # 创建者自动成为owner
        await self.add_member(
            room.id,
            creator_id,
            creator_username,
            UserType.HUMAN,
            MemberRole.OWNER
        )
        
        return room
    
    async def get_room(self, room_id: UUID) -> Optional[Room]:
        """获取房间"""
        room = await self.repository.get_by_id(room_id)
        if room:
            logger.debug("get_room", room_id=room_id)
        else:
            logger.debug("room_not_found", room_id=room_id)
        return room
    
    async def get_room_with_members(self, room_id: UUID) -> Optional[Room]:
        """获取房间及成员"""
        room = await self.get_room(room_id)
        if room:
            # 从repository获取成员并设置到room对象
            members = await self.repository.list_members(room_id)
            for member in members:
                room.add_member(member)
        return room
    
    async def list_rooms(
        self, 
        status: RoomStatus | str = RoomStatus.ACTIVE,
        page: int = 1,
        page_size: int = 20
    ) -> tuple[List[Room], int]:
        """获取房间列表"""
        if isinstance(status, str):
            try:
                status = RoomStatus(status)
            except ValueError:
                status = RoomStatus.ACTIVE
        logger.debug("list_rooms", status=status, page=page, page_size=page_size)
        return await self.repository.list(status, page, page_size)
    
    async def update_room(
        self, 
        room_id: UUID, 
        data: RoomUpdate,
        updater_id: str
    ) -> Optional[Room]:
        """更新房间"""
        logger.info("update_room", room_id=room_id, updater=updater_id)
        
        # 检查权限
        member = await self.repository.get_member(room_id, updater_id)
        if not member or member.role not in [MemberRole.OWNER, MemberRole.MODERATOR]:
            logger.warning("permission_denied", room_id=room_id, user_id=updater_id)
            raise PermissionError("Insufficient permissions to update room")
        
        # 更新数据
        update_data = data.model_dump(exclude_unset=True)
        
        # 如果更新密码，需要加密
        if 'password' in update_data:
            password = update_data.pop('password')
            update_data['password_hash'] = bcrypt.hashpw(
                password.encode('utf-8'), 
                bcrypt.gensalt()
            ).decode('utf-8')
        
        return await self.repository.update(room_id, update_data)
    
    async def delete_room(self, room_id: UUID, deleter_id: str) -> bool:
        """删除房间"""
        logger.info("delete_room", room_id=room_id, deleter=deleter_id)
        
        # 检查权限
        member = await self.repository.get_member(room_id, deleter_id)
        if not member or member.role != MemberRole.OWNER:
            logger.warning("permission_denied_delete", room_id=room_id, user_id=deleter_id)
            raise PermissionError("Only room owner can delete the room")
        
        return await self.repository.delete(room_id)
    
    async def validate_access(self, room_id: UUID, password: str) -> bool:
        """验证房间访问权限"""
        room = await self.get_room(room_id)
        if not room:
            return False
        
        try:
            return bcrypt.checkpw(
                password.encode('utf-8'), 
                room.password_hash.encode('utf-8')
            )
        except Exception as e:
            logger.error("password_check_failed", room_id=room_id, error=str(e))
            return False
    
    async def join_room(
        self, 
        room_id: UUID, 
        data: RoomJoinRequest
    ) -> RoomMember:
        """加入房间"""
        logger.info("join_room", room_id=room_id, user_id=data.user_id, username=data.username)
        
        # 验证房间密码
        if not await self.validate_access(room_id, data.password):
            logger.warning("invalid_password", room_id=room_id, user_id=data.user_id)
            raise ValueError("Invalid room password")
        
        # 检查房间状态
        room = await self.get_room(room_id)
        if not room or room.status != RoomStatus.ACTIVE:
            logger.warning("room_inactive", room_id=room_id)
            raise ValueError("Room is not active")
        
        # 检查成员数限制
        member_count = await self.repository.count_members(room_id)
        if member_count >= room.max_members:
            logger.warning("room_full", room_id=room_id, current=member_count, max=room.max_members)
            raise ValueError("Room is full")
        
        # 检查是否已经是成员，直接返回现有记录（避免覆盖 owner 等角色）
        existing_member = await self.repository.get_member(room_id, data.user_id)
        if existing_member:
            logger.info("member_already_in_room", room_id=room_id, user_id=data.user_id)
            return existing_member

        # 检查是否有相同 username 的残留记录（agent 重连时 user_id 会变化）
        stale_member = await self.repository.get_member_by_username(room_id, data.username)
        if stale_member:
            logger.info(
                "removing_stale_member_by_username",
                room_id=room_id,
                stale_user_id=stale_member.user_id,
                new_user_id=data.user_id,
                username=data.username,
            )
            await self.repository.remove_member(room_id, stale_member.user_id)

        # 确定用户类型
        if data.user_type == "agent":
            user_type = UserType.AGENT
        elif data.user_type == "system":
            user_type = UserType.SYSTEM
        else:
            user_type = UserType.HUMAN
        
        # 添加成员
        provided_agent_id = data.agent_id if hasattr(data, 'agent_id') else None
        # agent 未提供 agent_id 时自动分配，确保 memberJoined 事件携带有效标识符
        resolved_agent_id = provided_agent_id or (str(uuid4()) if user_type == UserType.AGENT else None)
        member = RoomMember(
            id=uuid4(),
            room_id=room_id,
            user_id=data.user_id,
            username=data.username,
            user_type=user_type,
            role=MemberRole.MEMBER,
            a2a_endpoint=data.a2a_endpoint,
            agent_card_url=data.agent_card_url,
            agent_id=resolved_agent_id,
        )
        
        try:
            result = await self.repository.add_member(member)
            logger.info("member_joined", room_id=room_id, user_id=data.user_id, username=data.username)
            return result
        except Exception as e:
            logger.error("join_room_failed", room_id=room_id, user_id=data.user_id, error=str(e))
            raise
    
    async def leave_room(self, room_id: UUID, user_id: str) -> bool:
        """离开房间"""
        logger.info("leave_room", room_id=room_id, user_id=user_id)
        
        # 获取成员
        member = await self.repository.get_member(room_id, user_id)
        if not member:
            logger.warning("member_not_found", room_id=room_id, user_id=user_id)
            raise ValueError("User is not a member of this room")
        
        # 如果是owner，检查是否有其他owner
        if member.role == MemberRole.OWNER:
            other_owners = await self.repository.list_members_by_role(room_id, MemberRole.OWNER)
            if len(other_owners) == 1:  # 这是唯一的owner
                logger.warning("last_owner_leaving", room_id=room_id, user_id=user_id)
                raise ValueError("Cannot leave room as the last owner")
        
        return await self.repository.remove_member(room_id, user_id)
    
    async def add_member(
        self, 
        room_id: UUID, 
        user_id: str, 
        username: str,
        user_type: UserType,
        role: MemberRole = MemberRole.MEMBER,
        a2a_endpoint: Optional[str] = None,
        agent_card_url: Optional[str] = None
    ) -> RoomMember:
        """添加成员"""
        logger.debug("add_member", room_id=room_id, user_id=user_id, username=username, role=role)
        
        member = RoomMember(
            id=uuid4(),
            room_id=room_id,
            user_id=user_id,
            username=username,
            user_type=user_type,
            role=role,
            a2a_endpoint=a2a_endpoint,
            agent_card_url=agent_card_url
        )
        return await self.repository.add_member(member)
    
    async def remove_member(self, room_id: UUID, user_id: str) -> bool:
        """移除成员"""
        logger.info("remove_member", room_id=room_id, user_id=user_id)
        return await self.repository.remove_member(room_id, user_id)
    
    async def get_members(self, room_id: UUID) -> List[RoomMember]:
        """获取房间成员"""
        return await self.repository.list_members(room_id)
    
    async def get_member(self, room_id: UUID, user_id: str) -> Optional[RoomMember]:
        """获取特定成员"""
        return await self.repository.get_member(room_id, user_id)
    
    async def update_member_status(
        self, 
        room_id: UUID, 
        user_id: str, 
        status: MemberStatus | str
    ) -> bool:
        """更新成员状态"""
        if isinstance(status, str):
            try:
                status = MemberStatus(status)
            except ValueError:
                status = MemberStatus.ONLINE
        logger.debug("update_member_status", room_id=room_id, user_id=user_id, status=status)
        return await self.repository.update_member_status(room_id, user_id, status)
    
    async def update_member_role(
        self, 
        room_id: UUID, 
        user_id: str,
        role: MemberRole,
        updater_id: str
    ) -> bool:
        """更新成员角色"""
        logger.info("update_member_role", room_id=room_id, user_id=user_id, role=role, updater=updater_id)
        
        # 检查权限
        updater = await self.repository.get_member(room_id, updater_id)
        if not updater or updater.role not in [MemberRole.OWNER, MemberRole.MODERATOR]:
            logger.warning("permission_denied_role_update", room_id=room_id, updater_id=updater_id)
            raise PermissionError("Insufficient permissions to update member role")
        
        # 不能修改owner的角色，除非自己是owner
        target_member = await self.repository.get_member(room_id, user_id)
        if target_member.role == MemberRole.OWNER and updater.role != MemberRole.OWNER:
            logger.warning("cannot_change_owner_role", room_id=room_id, user_id=user_id)
            raise PermissionError("Cannot change owner's role")
        
        return await self.repository.update_member_role(room_id, user_id, role)
    
    async def get_agent_members(self, room_id: UUID) -> List[RoomMember]:
        """获取房间内的Agent成员"""
        members = await self.get_members(room_id)
        return [member for member in members if member.user_type == UserType.AGENT]

    async def get_all_agent_members(self) -> List[RoomMember]:
        """查询所有房间中的 Agent 成员（含 a2a_endpoint），用于 relay 重启后恢复 AgentRegistry"""
        return await self.repository.list_all_agent_members()