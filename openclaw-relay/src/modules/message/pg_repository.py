import re
from typing import Optional, List, Dict, Any
from uuid import UUID
from datetime import datetime

from sqlalchemy import select, func, text
from sqlalchemy.ext.asyncio import AsyncSession

from ...core.database import db_manager
from ...models.message import MessageModel
from .repository import Message, MessageType, MessageStatus


def _model_to_message(m: MessageModel) -> Message:
    msg = Message(
        id=m.id,
        room_id=m.room_id,
        message_id=m.message_id,
        sender_id=m.sender_id,
        sender_name=m.sender_name,
        text=m.text,
        type=MessageType(m.type),
        mentions=list(m.mentions) if m.mentions else [],
        attachments=list(m.attachments) if m.attachments else [],
        reply_to=m.reply_to,
        reply_preview=m.reply_preview,
        tool_calls=list(m.tool_calls) if m.tool_calls else [],
        tool_results=dict(m.tool_results) if m.tool_results else {},
        metadata=dict(m.metadata_) if m.metadata_ else {},
    )
    msg.status = MessageStatus(m.status)
    msg.created_at = m.created_at
    msg.edited_at = m.edited_at
    msg.deleted_at = m.deleted_at
    return msg


class PGMessageRepository:
    """PostgreSQL 消息仓库"""

    _mention_pattern = re.compile(r'@([a-zA-Z0-9_\-]+)')

    async def _next_message_id(self, session: AsyncSession, room_id: UUID) -> int:
        stmt = select(func.coalesce(func.max(MessageModel.message_id), 0)).where(
            MessageModel.room_id == room_id
        )
        return (await session.execute(stmt)).scalar() + 1

    async def create(self, message: Message) -> Message:
        async with db_manager.get_session() as session:
            if message.message_id <= 0:
                message.message_id = await self._next_message_id(session, message.room_id)

            model = MessageModel(
                id=message.id,
                room_id=message.room_id,
                message_id=message.message_id,
                sender_id=message.sender_id,
                sender_name=message.sender_name,
                text=message.text,
                type=message.type.value if isinstance(message.type, MessageType) else message.type,
                status=message.status.value if isinstance(message.status, MessageStatus) else message.status,
                mentions=message.mentions,
                attachments=message.attachments,
                reply_to=message.reply_to,
                reply_preview=message.reply_preview,
                tool_calls=message.tool_calls,
                tool_results=message.tool_results,
                metadata_=message.metadata,
                created_at=message.created_at,
            )
            session.add(model)
            await session.flush()
            message.message_id = model.message_id
            return message

    async def get_message(self, room_id: UUID, message_id: int) -> Optional[Message]:
        async with db_manager.get_session() as session:
            stmt = select(MessageModel).where(
                MessageModel.room_id == room_id,
                MessageModel.message_id == message_id,
            )
            model = (await session.execute(stmt)).scalar_one_or_none()
            return _model_to_message(model) if model else None

    async def get_messages(
        self,
        room_id: UUID,
        start_message_id: Optional[int] = None,
        limit: int = 20,
        mentioning: Optional[List[str]] = None,
        from_user: Optional[List[str]] = None,
        message_type: Optional[MessageType] = None,
    ) -> List[Message]:
        async with db_manager.get_session() as session:
            stmt = select(MessageModel).where(MessageModel.room_id == room_id)

            if start_message_id is not None:
                stmt = stmt.where(MessageModel.message_id > start_message_id)
            if from_user:
                stmt = stmt.where(MessageModel.sender_id.in_(from_user))
            if message_type:
                stmt = stmt.where(
                    MessageModel.type == (
                        message_type.value if isinstance(message_type, MessageType) else message_type
                    )
                )

            stmt = stmt.order_by(MessageModel.message_id).limit(limit)
            rows = (await session.execute(stmt)).scalars().all()
            messages = [_model_to_message(r) for r in rows]

            if mentioning:
                messages = [
                    m for m in messages
                    if any(name in m.mentions for name in mentioning)
                ]

            return messages

    async def update_message(
        self,
        room_id: UUID,
        message_id: int,
        text: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[Message]:
        async with db_manager.get_session() as session:
            stmt = select(MessageModel).where(
                MessageModel.room_id == room_id,
                MessageModel.message_id == message_id,
            )
            model = (await session.execute(stmt)).scalar_one_or_none()
            if not model:
                return None
            model.text = text
            if metadata:
                current = dict(model.metadata_) if model.metadata_ else {}
                current.update(metadata)
                model.metadata_ = current
            model.edited_at = datetime.utcnow()
            model.status = MessageStatus.EDITED.value
            await session.flush()
            return _model_to_message(model)

    async def delete_message(self, room_id: UUID, message_id: int) -> bool:
        async with db_manager.get_session() as session:
            stmt = select(MessageModel).where(
                MessageModel.room_id == room_id,
                MessageModel.message_id == message_id,
            )
            model = (await session.execute(stmt)).scalar_one_or_none()
            if not model:
                return False
            model.deleted_at = datetime.utcnow()
            model.status = MessageStatus.DELETED.value
            return True

    async def search_messages(
        self, room_id: UUID, query: str, limit: int = 20
    ) -> List[Message]:
        async with db_manager.get_session() as session:
            stmt = (
                select(MessageModel)
                .where(
                    MessageModel.room_id == room_id,
                    MessageModel.text.ilike(f"%{query}%"),
                )
                .order_by(MessageModel.message_id.desc())
                .limit(limit)
            )
            rows = (await session.execute(stmt)).scalars().all()
            return [_model_to_message(r) for r in rows]

    async def parse_mentions(self, text: str) -> List[str]:
        return list(set(self._mention_pattern.findall(text)))

    async def get_message_stats(self, room_id: UUID) -> Dict[str, Any]:
        async with db_manager.get_session() as session:
            total_stmt = select(func.count()).select_from(MessageModel).where(
                MessageModel.room_id == room_id
            )
            total = (await session.execute(total_stmt)).scalar()

            per_user_stmt = (
                select(MessageModel.sender_id, func.count().label("cnt"))
                .where(MessageModel.room_id == room_id)
                .group_by(MessageModel.sender_id)
            )
            rows = (await session.execute(per_user_stmt)).all()
            messages_by_user = {row.sender_id: row.cnt for row in rows}

            return {"total_messages": total, "messages_by_user": messages_by_user}

    async def get_latest_message_id(self, room_id: UUID) -> int:
        async with db_manager.get_session() as session:
            stmt = select(func.coalesce(func.max(MessageModel.message_id), 0)).where(
                MessageModel.room_id == room_id
            )
            return (await session.execute(stmt)).scalar()
