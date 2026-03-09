from sqlalchemy import Column, String, DateTime
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from datetime import datetime
import uuid

from ..core.database import Base


class UserModel(Base):
    __tablename__ = "users"

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(String(50), nullable=False, unique=True, index=True)
    username = Column(String(50), nullable=False, unique=True, index=True)
    password_hash = Column(String(255), nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
