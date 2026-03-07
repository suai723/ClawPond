from sqlalchemy import Column, String, Integer, DateTime, ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID as PGUUID, JSONB, ARRAY
from sqlalchemy.orm import relationship
from datetime import datetime
import uuid

from ..core.database import Base


class MessageModel(Base):
    __tablename__ = "messages"

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(PGUUID(as_uuid=True), ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    message_id = Column(Integer, nullable=False, index=True)
    sender_id = Column(String(255), nullable=False, index=True)
    sender_name = Column(String(100), nullable=False)
    text = Column(Text, nullable=False, default="")
    type = Column(String(20), nullable=False, default="text")
    status = Column(String(20), nullable=False, default="sent")
    mentions = Column(JSONB, nullable=False, default=list)
    attachments = Column(JSONB, nullable=False, default=list)
    reply_to = Column(Integer, nullable=True)
    reply_preview = Column(String(200), nullable=True)
    tool_calls = Column(JSONB, nullable=False, default=list)
    tool_results = Column(JSONB, nullable=False, default=dict)
    metadata_ = Column("metadata", JSONB, nullable=False, default=dict)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    edited_at = Column(DateTime, nullable=True)
    deleted_at = Column(DateTime, nullable=True)

    room = relationship("RoomModel", back_populates="messages")
