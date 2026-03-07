import asyncio
from typing import Dict, Optional, List
from uuid import UUID, uuid4
import structlog
import httpx
from datetime import datetime

logger = structlog.get_logger()


class AgentCard:
    """AgentCard模型（简化版）"""
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
    
    def to_dict(self) -> Dict[str, any]:
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
    """Agent信息"""
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
    
    def to_dict(self) -> Dict[str, any]:
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


class AgentRegistry:
    """Agent注册表"""
    
    def __init__(self):
        self._agents: Dict[str, AgentInfo] = {}  # agent_id (UUID str) -> AgentInfo
        self._agents_by_room: Dict[UUID, List[str]] = {}  # room_id -> [agent_id]
        self._lock = asyncio.Lock()
        self._http_client = httpx.AsyncClient(timeout=30.0)
    
    async def register_agent(
        self,
        name: str,
        endpoint: str,
        room_id: Optional[UUID] = None,
        description: str = "",
        skills: List[str] = None,
        capabilities: Dict[str, bool] = None,
        agent_id: Optional[str] = None,
    ) -> AgentInfo:
        """注册Agent。agent_id 由服务端生成 UUID（或恢复时传入已有 ID）"""
        # agent_id 由服务端分发，全局唯一；agentName 仅在同一 room 内唯一
        if agent_id is None:
            agent_id = str(uuid4())
        
        async with self._lock:
            # 创建AgentCard
            agent_card = AgentCard(
                name=name,
                endpoint=endpoint,
                description=description,
                skills=skills,
                capabilities=capabilities
            )
            
            # 创建AgentInfo
            agent_info = AgentInfo(
                agent_id=agent_id,
                name=name,
                endpoint=endpoint,
                agent_card=agent_card,
                room_id=room_id
            )
            
            # 存储
            self._agents[agent_id] = agent_info
            
            if room_id:
                if room_id not in self._agents_by_room:
                    self._agents_by_room[room_id] = []
                if agent_id not in self._agents_by_room[room_id]:
                    self._agents_by_room[room_id].append(agent_id)
            
            logger.info(
                "agent_registered",
                agent_id=agent_id,
                name=name,
                endpoint=endpoint,
                room_id=str(room_id) if room_id else None
            )
            
            return agent_info
    
    async def unregister_agent(self, agent_id: str) -> bool:
        """注销Agent"""
        async with self._lock:
            if agent_id not in self._agents:
                return False
            
            agent_info = self._agents[agent_id]
            
            # 从房间索引中移除
            if agent_info.room_id:
                room_agents = self._agents_by_room.get(agent_info.room_id)
                if room_agents and agent_id in room_agents:
                    room_agents.remove(agent_id)
                    if not room_agents:
                        del self._agents_by_room[agent_info.room_id]
            
            # 从主存储中移除
            del self._agents[agent_id]
            
            logger.info("agent_unregistered", agent_id=agent_id)
            return True
    
    async def get_agent(self, agent_id: str) -> Optional[AgentInfo]:
        """获取Agent信息（按 UUID）"""
        return self._agents.get(agent_id)
    
    async def get_agent_by_name_in_room(self, name: str, room_id: UUID) -> Optional[AgentInfo]:
        """在指定房间内按 agentName 查找 Agent（用于后备 @mention 解析）"""
        agent_ids = self._agents_by_room.get(room_id, [])
        for aid in agent_ids:
            info = self._agents.get(aid)
            if info and info.name.lower() == name.lower():
                return info
        return None

    async def list_agents(self) -> List[AgentInfo]:
        """获取所有Agent列表"""
        return list(self._agents.values())
    
    async def list_agents_in_room(self, room_id: UUID) -> List[AgentInfo]:
        """获取房间内的所有Agent"""
        agent_ids = self._agents_by_room.get(room_id, [])
        return [self._agents[agent_id] for agent_id in agent_ids if agent_id in self._agents]
    
    async def update_agent_status(self, agent_id: str, status: str) -> bool:
        """更新Agent状态"""
        async with self._lock:
            if agent_id not in self._agents:
                return False
            
            self._agents[agent_id].status = status
            self._agents[agent_id].last_active = datetime.utcnow()
            return True
    
    async def call_agent(
        self,
        agent_id: str,
        message: str,
        context: Dict[str, any] = None
    ) -> Dict[str, any]:
        """调用Agent（A2A HTTP 协议）"""
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
            # A2A tasks/send 请求体
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

            logger.info(
                "agent_a2a_response",
                agent_id=agent_id,
                task_id=task_id,
                status=result.get("status"),
            )

            return result

        except Exception as e:
            await self.update_agent_status(agent_id, "error")
            logger.error("agent_a2a_call_failed", agent_id=agent_id, error=str(e))
            raise
    
    async def ping_agent(self, agent_id: str) -> bool:
        """Ping Agent检查连通性"""
        agent_info = await self.get_agent(agent_id)
        if not agent_info:
            return False
        
        try:
            # 尝试访问Agent端点
            response = await self._http_client.get(
                f"{agent_info.endpoint}/health",
                timeout=5.0
            )
            
            is_online = response.status_code == 200
            status = "online" if is_online else "offline"
            await self.update_agent_status(agent_id, status)
            
            return is_online
            
        except Exception as e:
            await self.update_agent_status(agent_id, "offline")
            logger.warning("agent_ping_failed", agent_id=agent_id, error=str(e))
            return False
    
    async def cleanup(self):
        """清理资源"""
        await self._http_client.aclose()
    
    def __del__(self):
        """析构函数"""
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self.cleanup())
        except RuntimeError:
            pass