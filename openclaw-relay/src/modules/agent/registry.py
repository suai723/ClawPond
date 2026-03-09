import asyncio
import bcrypt
import secrets
from typing import Dict, Optional, List, Tuple
from uuid import UUID, uuid4
import structlog
import httpx
from datetime import datetime

from .pg_repository import AgentRepository, AgentRecord

logger = structlog.get_logger()


class AgentCard:
    """AgentCard 模型（简化版）"""
    def __init__(
        self,
        name: str,
        endpoint: str,
        description: str = "",
        skills: List[str] = None,
        capabilities: Dict[str, bool] = None
    ):
        self.name = name
        self.endpoint = endpoint
        self.description = description
        self.skills = skills or []
        self.capabilities = capabilities or {
            "streaming": True,
            "pushNotifications": False
        }
        self.last_checked = datetime.utcnow()
        self.status = "online"

    def to_dict(self) -> Dict:
        return {
            "name": self.name,
            "endpoint": self.endpoint,
            "description": self.description,
            "skills": self.skills,
            "capabilities": self.capabilities,
            "status": self.status,
            "last_checked": self.last_checked.isoformat()
        }


class AgentInfo:
    """Agent 内存信息对象"""
    def __init__(
        self,
        agent_id: str,
        name: str,
        endpoint: str,
        agent_card: AgentCard,
        room_id: Optional[UUID] = None
    ):
        self.agent_id = agent_id
        self.name = name
        self.endpoint = endpoint
        self.agent_card = agent_card
        self.room_id = room_id
        self.registered_at = datetime.utcnow()
        self.last_active = datetime.utcnow()
        self.status = "online"
        self.call_count = 0
        # 凭据 hash（从 DB 加载或注册时写入）
        self.agent_secret_hash: Optional[str] = None

    def to_dict(self) -> Dict:
        return {
            "agent_id": self.agent_id,
            "name": self.name,
            "endpoint": self.endpoint,
            "room_id": str(self.room_id) if self.room_id else None,
            "status": self.status,
            "registered_at": self.registered_at.isoformat(),
            "last_active": self.last_active.isoformat(),
            "call_count": self.call_count,
            "agent_card": self.agent_card.to_dict()
        }


def _record_to_info(record: AgentRecord) -> AgentInfo:
    """将 DB 记录转换为内存对象"""
    agent_card = AgentCard(
        name=record.name,
        endpoint=record.endpoint or "",
        description=record.description or "",
        skills=record.skills or [],
    )
    info = AgentInfo(
        agent_id=record.agent_id,
        name=record.name,
        endpoint=record.endpoint or "",
        agent_card=agent_card,
    )
    info.agent_secret_hash = record.agent_secret_hash
    info.status = record.status
    return info


class AgentRegistry:
    """Agent 注册表（内存缓存 + DB 持久化）"""

    def __init__(self):
        self._agents: Dict[str, AgentInfo] = {}
        self._agents_by_room: Dict[UUID, List[str]] = {}
        self._lock = asyncio.Lock()
        self._http_client = httpx.AsyncClient(timeout=30.0)
        self._repo = AgentRepository()

    # ------------------------------------------------------------------
    # 注册与凭据管理
    # ------------------------------------------------------------------

    async def create_agent(
        self,
        name: str,
        endpoint: Optional[str] = None,
        description: str = "",
        skills: List[str] = None,
    ) -> Tuple[AgentInfo, str]:
        """新 Agent 注册：生成 agent_id + agent_secret，写入 DB，更新内存缓存。
        返回 (AgentInfo, plain_secret)，plain_secret 仅此次明文返回。"""
        existing = await self._repo.get_by_name(name)
        if existing:
            raise ValueError(f"Agent name '{name}' is already registered.")

        agent_id = str(uuid4())
        plain_secret = secrets.token_urlsafe(32)
        secret_hash = bcrypt.hashpw(plain_secret.encode(), bcrypt.gensalt()).decode()

        await self._repo.create(
            agent_id=agent_id,
            name=name,
            agent_secret_hash=secret_hash,
            endpoint=endpoint,
            description=description,
            skills=skills or [],
        )

        agent_card = AgentCard(
            name=name,
            endpoint=endpoint or "",
            description=description,
            skills=skills or [],
        )
        agent_info = AgentInfo(
            agent_id=agent_id,
            name=name,
            endpoint=endpoint or "",
            agent_card=agent_card,
        )
        agent_info.agent_secret_hash = secret_hash

        async with self._lock:
            self._agents[agent_id] = agent_info

        logger.info("agent_created", agent_id=agent_id, name=name)
        return agent_info, plain_secret

    async def verify_agent(self, agent_id: str, plain_secret: str) -> Optional[AgentInfo]:
        """验证 Agent 凭据。优先查内存缓存（含 hash），未命中则 fallback DB。"""
        agent_info = self._agents.get(agent_id)
        if agent_info and agent_info.agent_secret_hash:
            if bcrypt.checkpw(plain_secret.encode(), agent_info.agent_secret_hash.encode()):
                return agent_info
            return None

        # 内存未命中（如重启后未完全恢复），回查 DB
        record = await self._repo.get_by_id(agent_id)
        if not record:
            return None
        if not bcrypt.checkpw(plain_secret.encode(), record.agent_secret_hash.encode()):
            return None

        # 加载到内存缓存
        info = _record_to_info(record)
        async with self._lock:
            self._agents[agent_id] = info
        return info

    async def restore_from_db(self) -> int:
        """启动时从 agents 表恢复内存缓存，返回恢复的数量。"""
        records = await self._repo.list_all()
        count = 0
        for record in records:
            info = _record_to_info(record)
            async with self._lock:
                self._agents[record.agent_id] = info
            count += 1
        if count:
            logger.info("agents_restored_from_db", count=count)
        return count

    async def add_agent_to_room(self, agent_id: str, room_id: UUID):
        """Agent 加入房间后更新内存的 room 索引。"""
        async with self._lock:
            info = self._agents.get(agent_id)
            if not info:
                return
            # 从旧房间移除
            old_room = info.room_id
            if old_room and old_room in self._agents_by_room:
                if agent_id in self._agents_by_room[old_room]:
                    self._agents_by_room[old_room].remove(agent_id)
                    if not self._agents_by_room[old_room]:
                        del self._agents_by_room[old_room]
            # 加入新房间
            info.room_id = room_id
            if room_id not in self._agents_by_room:
                self._agents_by_room[room_id] = []
            if agent_id not in self._agents_by_room[room_id]:
                self._agents_by_room[room_id].append(agent_id)

    # ------------------------------------------------------------------
    # 注销
    # ------------------------------------------------------------------

    async def unregister_agent(self, agent_id: str) -> bool:
        """注销 Agent：从内存和 DB 中删除。"""
        async with self._lock:
            if agent_id not in self._agents:
                return False
            agent_info = self._agents.pop(agent_id)
            if agent_info.room_id:
                room_agents = self._agents_by_room.get(agent_info.room_id)
                if room_agents and agent_id in room_agents:
                    room_agents.remove(agent_id)
                    if not room_agents:
                        del self._agents_by_room[agent_info.room_id]

        await self._repo.delete(agent_id)
        logger.info("agent_unregistered", agent_id=agent_id)
        return True

    # ------------------------------------------------------------------
    # 查询
    # ------------------------------------------------------------------

    async def get_agent(self, agent_id: str) -> Optional[AgentInfo]:
        return self._agents.get(agent_id)

    async def get_agent_by_name_in_room(self, name: str, room_id: UUID) -> Optional[AgentInfo]:
        agent_ids = self._agents_by_room.get(room_id, [])
        for aid in agent_ids:
            info = self._agents.get(aid)
            if info and info.name.lower() == name.lower():
                return info
        return None

    async def list_agents(self) -> List[AgentInfo]:
        return list(self._agents.values())

    async def list_agents_in_room(self, room_id: UUID) -> List[AgentInfo]:
        agent_ids = self._agents_by_room.get(room_id, [])
        return [self._agents[aid] for aid in agent_ids if aid in self._agents]

    # ------------------------------------------------------------------
    # 状态更新
    # ------------------------------------------------------------------

    async def update_agent_status(self, agent_id: str, status: str) -> bool:
        async with self._lock:
            if agent_id not in self._agents:
                return False
            self._agents[agent_id].status = status
            self._agents[agent_id].last_active = datetime.utcnow()
        await self._repo.update_status(agent_id, status)
        return True

    # ------------------------------------------------------------------
    # A2A HTTP 调用
    # ------------------------------------------------------------------

    async def call_agent(
        self,
        agent_id: str,
        message: str,
        context: Dict = None
    ) -> Dict:
        """通过 A2A HTTP 协议调用 Agent"""
        agent_info = await self.get_agent(agent_id)
        if not agent_info:
            raise ValueError(f"Agent {agent_id} not found")

        await self.update_agent_status(agent_id, "processing")
        agent_info.call_count += 1

        task_id = f"task-{datetime.utcnow().timestamp()}-{agent_id}"

        logger.info(
            "calling_agent_a2a",
            agent_id=agent_id,
            agent_name=agent_info.name,
            endpoint=agent_info.endpoint,
            message=message[:100],
        )

        try:
            payload = {
                "id": task_id,
                "message": {
                    "role": "user",
                    "parts": [{"text": message}],
                },
                "metadata": context or {},
            }

            response = await self._http_client.post(
                f"{agent_info.endpoint}/tasks/send",
                json=payload,
                timeout=30.0,
            )
            response.raise_for_status()
            result = response.json()

            await self.update_agent_status(agent_id, "online")
            logger.info("agent_a2a_response", agent_id=agent_id, task_id=task_id)
            return result

        except Exception as e:
            await self.update_agent_status(agent_id, "error")
            logger.error("agent_a2a_call_failed", agent_id=agent_id, error=str(e))
            raise

    async def ping_agent(self, agent_id: str) -> bool:
        """Ping Agent 检查连通性"""
        agent_info = await self.get_agent(agent_id)
        if not agent_info:
            return False
        try:
            response = await self._http_client.get(
                f"{agent_info.endpoint}/health",
                timeout=5.0
            )
            is_online = response.status_code == 200
            await self.update_agent_status(agent_id, "online" if is_online else "offline")
            return is_online
        except Exception as e:
            await self.update_agent_status(agent_id, "offline")
            logger.warning("agent_ping_failed", agent_id=agent_id, error=str(e))
            return False

    async def cleanup(self):
        await self._http_client.aclose()

    def __del__(self):
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self.cleanup())
        except RuntimeError:
            pass
