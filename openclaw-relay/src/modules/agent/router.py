from typing import Optional, List
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
import structlog

logger = structlog.get_logger()

router = APIRouter()

# 全局 registry 引用，由 main.py 注入
_agent_registry = None
_room_service = None


def setup_agent_router(agent_registry, room_service):
    """注入服务依赖"""
    global _agent_registry, _room_service
    _agent_registry = agent_registry
    _room_service = room_service


class AgentRegisterRequest(BaseModel):
    """Agent 注册请求"""
    name: str = Field(..., min_length=1, max_length=100)
    endpoint: str = Field(..., min_length=1, max_length=512)
    room_id: str = Field(..., description="目标房间 UUID")
    room_password: str = Field(..., min_length=4, max_length=100)
    description: str = Field(default="", max_length=1000)
    skills: List[str] = Field(default_factory=list)


class AgentRegisterResponse(BaseModel):
    agent_id: str
    user_id: str
    name: str
    room_id: str
    message: str


@router.post(
    "/register",
    response_model=AgentRegisterResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register an agent to a chatroom",
)
async def register_agent(data: AgentRegisterRequest):
    """通过 HTTP API 注册 Agent（MCP 的备选方案）"""
    if _agent_registry is None or _room_service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service not initialized",
        )

    try:
        from uuid import UUID
        from ...schemas.room import RoomJoinRequest

        room_uuid = UUID(data.room_id)

        # 先注册到 AgentRegistry，获取服务端分发的 UUID
        agent_info = await _agent_registry.register_agent(
            name=data.name,
            endpoint=data.endpoint,
            room_id=room_uuid,
            description=data.description,
            skills=data.skills,
        )

        # 用 agent_id (UUID) 构造 user_id，加入房间
        join_request = RoomJoinRequest(
            user_id=f"agent-{agent_info.agent_id}",
            username=data.name,
            password=data.room_password,
            user_type="agent",
            a2a_endpoint=data.endpoint,
            agent_id=agent_info.agent_id,
        )
        member = await _room_service.join_room(room_uuid, join_request)

        logger.info(
            "http_agent_registered",
            agent_id=agent_info.agent_id,
            name=data.name,
            room_id=data.room_id,
        )

        return AgentRegisterResponse(
            agent_id=agent_info.agent_id,
            user_id=member.user_id,
            name=data.name,
            room_id=data.room_id,
            message=f"Agent '{data.name}' registered. Users can @{data.name} in the room.",
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error("http_register_agent_error", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.get("", summary="List all registered agents")
async def list_agents(room_id: Optional[str] = None):
    """列出所有已注册的 Agent"""
    if _agent_registry is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service not initialized",
        )

    try:
        if room_id:
            from uuid import UUID
            agents = await _agent_registry.list_agents_in_room(UUID(room_id))
        else:
            agents = await _agent_registry.list_agents()

        return {
            "agents": [agent.to_dict() for agent in agents],
            "total": len(agents),
        }
    except Exception as e:
        logger.error("http_list_agents_error", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


@router.get("/{agent_id}", summary="Get agent info")
async def get_agent(agent_id: str):
    """获取 Agent 详情"""
    if _agent_registry is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service not initialized",
        )

    agent = await _agent_registry.get_agent(agent_id)
    if not agent:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Agent {agent_id} not found",
        )
    return agent.to_dict()


@router.delete("/{agent_id}", summary="Unregister an agent")
async def unregister_agent(agent_id: str):
    """注销 Agent"""
    if _agent_registry is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service not initialized",
        )

    agent_info = await _agent_registry.get_agent(agent_id)
    if not agent_info:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Agent {agent_id} not found",
        )

    # 从房间移除
    if agent_info.room_id and _room_service:
        try:
            await _room_service.remove_member(agent_info.room_id, f"agent-{agent_info.agent_id}")
        except Exception:
            pass

    result = await _agent_registry.unregister_agent(agent_id)
    return {"success": result, "agent_id": agent_id}


@router.post("/{agent_id}/ping", summary="Ping an agent to check connectivity")
async def ping_agent(agent_id: str):
    """检查 Agent 是否在线"""
    if _agent_registry is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service not initialized",
        )

    agent = await _agent_registry.get_agent(agent_id)
    if not agent:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Agent {agent_id} not found",
        )

    is_online = await _agent_registry.ping_agent(agent_id)
    return {"agent_id": agent_id, "online": is_online, "status": agent.status}
