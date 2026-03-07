from typing import Optional, List, Dict, Any
from uuid import UUID, uuid4
from datetime import datetime

from sqlalchemy import select, update, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.database import db_manager
from ...models.room import RoomModel, RoomMemberModel
from .repository import (
    Room, RoomMember, RoomStatus, MemberRole, MemberStatus, UserType
)


def _model_to_room(m: RoomModel) -> Room:
    room = Room(
        id=m.id,
        name=m.name,
        password_hash=m.password_hash,
        created_by=m.created_by,
        description=m.description,
        max_members=m.max_members,
        message_retention=m.message_retention,
        allow_anonymous=m.allow_anonymous,
        allow_media_upload=m.allow_media_upload,
        media_max_size=m.media_max_size,
    )
    room.status = RoomStatus(m.status)
    room.created_at = m.created_at
    room.updated_at = m.updated_at
    return room


def _model_to_member(m: RoomMemberModel) -> RoomMember:
    member = RoomMember(
        id=m.id,
        room_id=m.room_id,
        user_id=m.user_id,
        username=m.username,
        user_type=UserType(m.user_type),
        role=MemberRole(m.role),
        a2a_endpoint=m.a2a_endpoint,
        agent_card_url=m.agent_card_url,
        agent_id=m.agent_id,
    )
    member.status = MemberStatus(m.status)
    member.joined_at = m.joined_at
    member.last_active_at = m.last_active_at
    return member


class PGRoomRepository:
    """PostgreSQL 房间仓库"""

    async def create(self, room: Room) -> Room:
        async with db_manager.get_session() as session:
            model = RoomModel(
                id=room.id,
                name=room.name,
                description=room.description,
                password_hash=room.password_hash,
                status=room.status.value,
                created_by=room.created_by,
                max_members=room.max_members,
                message_retention=room.message_retention,
                allow_anonymous=room.allow_anonymous,
                allow_media_upload=room.allow_media_upload,
                media_max_size=room.media_max_size,
                created_at=room.created_at,
                updated_at=room.updated_at,
            )
            session.add(model)
            await session.flush()
            return _model_to_room(model)

    async def get_by_id(self, room_id: UUID) -> Optional[Room]:
        async with db_manager.get_session() as session:
            result = await session.get(RoomModel, room_id)
            return _model_to_room(result) if result else None

    async def get_by_name(self, name: str) -> Optional[Room]:
        async with db_manager.get_session() as session:
            stmt = select(RoomModel).where(RoomModel.name == name)
            result = await session.execute(stmt)
            model = result.scalar_one_or_none()
            return _model_to_room(model) if model else None

    async def list(
        self,
        status: RoomStatus = RoomStatus.ACTIVE,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[List[Room], int]:
        async with db_manager.get_session() as session:
            count_stmt = select(func.count()).select_from(RoomModel).where(
                RoomModel.status == status.value
            )
            total = (await session.execute(count_stmt)).scalar()

            offset = (page - 1) * page_size
            stmt = (
                select(RoomModel)
                .where(RoomModel.status == status.value)
                .order_by(RoomModel.created_at.desc())
                .offset(offset)
                .limit(page_size)
            )
            rows = (await session.execute(stmt)).scalars().all()
            return [_model_to_room(r) for r in rows], total

    async def update(self, room_id: UUID, update_data: Dict[str, Any]) -> Optional[Room]:
        async with db_manager.get_session() as session:
            model = await session.get(RoomModel, room_id)
            if not model:
                return None
            for key, value in update_data.items():
                if hasattr(model, key):
                    setattr(model, key, value)
            model.updated_at = datetime.utcnow()
            await session.flush()
            return _model_to_room(model)

    async def delete(self, room_id: UUID) -> bool:
        async with db_manager.get_session() as session:
            model = await session.get(RoomModel, room_id)
            if not model:
                return False
            await session.delete(model)
            return True

    async def add_member(self, member: RoomMember) -> RoomMember:
        async with db_manager.get_session() as session:
            model = RoomMemberModel(
                id=member.id,
                room_id=member.room_id,
                user_id=member.user_id,
                username=member.username,
                user_type=member.user_type.value,
                role=member.role.value,
                status=member.status.value,
                a2a_endpoint=member.a2a_endpoint,
                agent_card_url=member.agent_card_url,
                agent_id=member.agent_id,
                joined_at=member.joined_at,
                last_active_at=member.last_active_at,
            )
            session.add(model)
            await session.flush()
            return _model_to_member(model)

    async def get_member(self, room_id: UUID, user_id: str) -> Optional[RoomMember]:
        async with db_manager.get_session() as session:
            stmt = select(RoomMemberModel).where(
                RoomMemberModel.room_id == room_id,
                RoomMemberModel.user_id == user_id,
            )
            result = await session.execute(stmt)
            model = result.scalar_one_or_none()
            return _model_to_member(model) if model else None

    async def get_member_by_username(self, room_id: UUID, username: str) -> Optional[RoomMember]:
        async with db_manager.get_session() as session:
            stmt = select(RoomMemberModel).where(
                RoomMemberModel.room_id == room_id,
                RoomMemberModel.username == username,
            )
            result = await session.execute(stmt)
            model = result.scalar_one_or_none()
            return _model_to_member(model) if model else None

    async def list_members(self, room_id: UUID) -> List[RoomMember]:
        async with db_manager.get_session() as session:
            stmt = select(RoomMemberModel).where(
                RoomMemberModel.room_id == room_id
            ).order_by(RoomMemberModel.joined_at)
            rows = (await session.execute(stmt)).scalars().all()
            return [_model_to_member(r) for r in rows]

    async def list_members_by_role(self, room_id: UUID, role: MemberRole) -> List[RoomMember]:
        async with db_manager.get_session() as session:
            stmt = select(RoomMemberModel).where(
                RoomMemberModel.room_id == room_id,
                RoomMemberModel.role == role.value,
            )
            rows = (await session.execute(stmt)).scalars().all()
            return [_model_to_member(r) for r in rows]

    async def count_members(self, room_id: UUID) -> int:
        async with db_manager.get_session() as session:
            stmt = select(func.count()).select_from(RoomMemberModel).where(
                RoomMemberModel.room_id == room_id
            )
            return (await session.execute(stmt)).scalar()

    async def remove_member(self, room_id: UUID, user_id: str) -> bool:
        async with db_manager.get_session() as session:
            stmt = select(RoomMemberModel).where(
                RoomMemberModel.room_id == room_id,
                RoomMemberModel.user_id == user_id,
            )
            model = (await session.execute(stmt)).scalar_one_or_none()
            if not model:
                return False
            await session.delete(model)
            return True

    async def update_member_status(
        self, room_id: UUID, user_id: str, status: MemberStatus
    ) -> bool:
        async with db_manager.get_session() as session:
            stmt = select(RoomMemberModel).where(
                RoomMemberModel.room_id == room_id,
                RoomMemberModel.user_id == user_id,
            )
            model = (await session.execute(stmt)).scalar_one_or_none()
            if not model:
                return False
            model.status = status.value
            model.last_active_at = datetime.utcnow()
            return True

    async def update_member_role(
        self, room_id: UUID, user_id: str, role: MemberRole
    ) -> bool:
        async with db_manager.get_session() as session:
            stmt = select(RoomMemberModel).where(
                RoomMemberModel.room_id == room_id,
                RoomMemberModel.user_id == user_id,
            )
            model = (await session.execute(stmt)).scalar_one_or_none()
            if not model:
                return False
            model.role = role.value
            return True

    async def list_all_agent_members(self) -> List[RoomMember]:
        """查询所有房间中 user_type='agent' 且有 a2a_endpoint 的成员（用于重启恢复）"""
        async with db_manager.get_session() as session:
            stmt = select(RoomMemberModel).where(
                RoomMemberModel.user_type == UserType.AGENT.value,
                RoomMemberModel.a2a_endpoint.isnot(None),
            )
            rows = (await session.execute(stmt)).scalars().all()
            return [_model_to_member(r) for r in rows]
