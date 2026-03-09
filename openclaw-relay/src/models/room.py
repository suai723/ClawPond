from sqlalchemy import Column, String, Boolean, Integer, DateTime, ForeignKey, Enum as SAEnum
from sqlalchemy.dialects.postgresql import UUID as PGUUID, JSONB
from sqlalchemy.orm import relationship
from datetime import datetime
import uuid

from ..core.database import Base


class RoomModel(Base):
    __tablename__ = "rooms"

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False, unique=True, index=True)
    description = Column(String(500), nullable=True)
    password_hash = Column(String(255), nullable=False)
    access_token = Column(String(64), nullable=False, unique=True, index=True)
    status = Column(String(20), nullable=False, default="active")
    created_by = Column(String(255), nullable=False)
    max_members = Column(Integer, nullable=False, default=50)
    message_retention = Column(Integer, nullable=False, default=0)
    allow_anonymous = Column(Boolean, nullable=False, default=False)
    allow_media_upload = Column(Boolean, nullable=False, default=True)
    media_max_size = Column(Integer, nullable=False, default=52428800)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    members = relationship("RoomMemberModel", back_populates="room", cascade="all, delete-orphan")
    messages = relationship("MessageModel", back_populates="room", cascade="all, delete-orphan")


class RoomMemberModel(Base):
    __tablename__ = "room_members"

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(PGUUID(as_uuid=True), ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(String(255), nullable=False, index=True)
    username = Column(String(100), nullable=False)
    user_type = Column(String(20), nullable=False, default="human")
    role = Column(String(20), nullable=False, default="member")
    status = Column(String(20), nullable=False, default="online")
    a2a_endpoint = Column(String(500), nullable=True)
    agent_card_url = Column(String(500), nullable=True)
    # agent_id: 服务端为 agent 分发的全局唯一 UUID（仅 user_type=agent 时有值）
    agent_id = Column(String(255), nullable=True, index=True)
    joined_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    last_active_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    room = relationship("RoomModel", back_populates="members")
