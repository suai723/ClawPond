from typing import Optional, List
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ...core.database import db_manager
from ...models.agent import AgentModel


@dataclass
class AgentRecord:
    """Agent 数据库记录（值对象，与 AgentInfo 内存对象分离）"""
    agent_id: str
    name: str
    agent_secret_hash: str
    endpoint: Optional[str]
    description: Optional[str]
    skills: Optional[list]
    created_at: datetime
    last_active_at: datetime
    status: str


def _model_to_record(m: AgentModel) -> AgentRecord:
    return AgentRecord(
        agent_id=m.agent_id,
        name=m.name,
        agent_secret_hash=m.agent_secret_hash,
        endpoint=m.endpoint,
        description=m.description,
        skills=m.skills,
        created_at=m.created_at,
        last_active_at=m.last_active_at,
        status=m.status,
    )


class AgentRepository:
    """agents 表的 CRUD 操作"""

    async def create(
        self,
        agent_id: str,
        name: str,
        agent_secret_hash: str,
        endpoint: Optional[str] = None,
        description: Optional[str] = None,
        skills: Optional[list] = None,
    ) -> AgentRecord:
        async with db_manager.get_session() as session:
            model = AgentModel(
                agent_id=agent_id,
                name=name,
                agent_secret_hash=agent_secret_hash,
                endpoint=endpoint,
                description=description,
                skills=skills or [],
                created_at=datetime.utcnow(),
                last_active_at=datetime.utcnow(),
                status="online",
            )
            session.add(model)
            try:
                await session.flush()
            except IntegrityError:
                raise ValueError(f"Agent name '{name}' is already registered.")
            return _model_to_record(model)

    async def get_by_id(self, agent_id: str) -> Optional[AgentRecord]:
        async with db_manager.get_session() as session:
            model = await session.get(AgentModel, agent_id)
            return _model_to_record(model) if model else None

    async def get_by_name(self, name: str) -> Optional[AgentRecord]:
        async with db_manager.get_session() as session:
            stmt = select(AgentModel).where(AgentModel.name == name)
            result = await session.execute(stmt)
            model = result.scalar_one_or_none()
            return _model_to_record(model) if model else None

    async def list_all(self) -> List[AgentRecord]:
        async with db_manager.get_session() as session:
            stmt = select(AgentModel).order_by(AgentModel.created_at)
            rows = (await session.execute(stmt)).scalars().all()
            return [_model_to_record(r) for r in rows]

    async def delete(self, agent_id: str) -> bool:
        async with db_manager.get_session() as session:
            model = await session.get(AgentModel, agent_id)
            if not model:
                return False
            await session.delete(model)
            return True

    async def update_status(self, agent_id: str, status: str) -> bool:
        async with db_manager.get_session() as session:
            model = await session.get(AgentModel, agent_id)
            if not model:
                return False
            model.status = status
            model.last_active_at = datetime.utcnow()
            return True

    async def update_last_active(self, agent_id: str) -> bool:
        async with db_manager.get_session() as session:
            model = await session.get(AgentModel, agent_id)
            if not model:
                return False
            model.last_active_at = datetime.utcnow()
            return True
