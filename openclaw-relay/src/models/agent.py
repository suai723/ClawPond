from sqlalchemy import Column, String, DateTime, Text
from sqlalchemy.dialects.postgresql import JSONB
from datetime import datetime

from ..core.database import Base


class AgentModel(Base):
    __tablename__ = "agents"

    agent_id = Column(String(255), primary_key=True)
    name = Column(String(100), nullable=False, unique=True, index=True)
    agent_secret_hash = Column(String(255), nullable=False)
    endpoint = Column(String(512), nullable=True)
    description = Column(Text, nullable=True)
    skills = Column(JSONB, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    last_active_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    status = Column(String(20), nullable=False, default="online")
