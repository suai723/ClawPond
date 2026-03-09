from typing import Optional, List
from uuid import UUID
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
import structlog

logger = structlog.get_logger()

router = APIRouter()

# 全局服务引用，由 main.py 注入
_agent_registry = None
_room_service = None


def setup_agent_router(agent_registry, room_service):
    global _agent_registry, _room_service
    _agent_registry = agent_registry
    _room_service = room_service


# ---------------------------------------------------------------------------
# Request / Response 模型
# ---------------------------------------------------------------------------

class AgentRegisterRequest(BaseModel):
    """Agent 注册请求（仅注册身份，不加入房间）"""
    name: str = Field(..., min_length=1, max_length=100)
    endpoint: Optional[str] = Field(None, max_length=512, description="A2A 回调地址（可选）")
    description: str = Field(default="", max_length=1000)
    skills: List[str] = Field(default_factory=list)


class AgentRegisterResponse(BaseModel):
    """Agent 注册响应 — agent_secret 仅此次明文返回"""
    agent_id: str
    agent_secret: str
    name: str
    message: str


class AgentJoinRequest(BaseModel):
    """Agent 加入房间请求"""
    agent_id: str = Field(..., description="注册时返回的 agent_id")
    agent_secret: str = Field(..., description="注册时返回的 agent_secret")
    room_id: str = Field(..., description="目标房间 UUID")
    room_password: str = Field(..., min_length=1, max_length=100, description="房间 access_token")


class AgentJoinResponse(BaseModel):
    """Agent 加入房间响应"""
    agent_id: str
    user_id: str
    username: str
    room_id: str
    message: str


# ---------------------------------------------------------------------------
# 注册接口（仅注册 Agent 身份）
# ---------------------------------------------------------------------------

@router.post(
    "/register",
    response_model=AgentRegisterResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new agent (credentials only, no room)",
)
async def register_agent(data: AgentRegisterRequest):
    """注册 Agent，生成 agent_id 和 agent_secret 并持久化到数据库。
    agent_secret 仅在此响应中明文返回一次，请妥善保存。"""
    if _agent_registry is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service not initialized",
        )

    try:
        agent_info, plain_secret = await _agent_registry.create_agent(
            name=data.name,
            endpoint=data.endpoint,
            description=data.description,
            skills=data.skills,
        )

        logger.info("http_agent_registered", agent_id=agent_info.agent_id, name=data.name)

        return AgentRegisterResponse(
            agent_id=agent_info.agent_id,
            agent_secret=plain_secret,
            name=agent_info.name,
            message=(
                f"Agent '{data.name}' registered. "
                "Save the agent_secret — it will not be shown again."
            ),
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error("http_register_agent_error", error=str(e))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
        )


# ---------------------------------------------------------------------------
# 加入房间接口（验证凭据后加入）
# ---------------------------------------------------------------------------

@router.post(
    "/join",
    response_model=AgentJoinResponse,
    summary="Join a room with agent credentials",
)
async def join_agent_room(data: AgentJoinRequest):
    """Agent 凭 agent_id + agent_secret 验证身份后加入房间。
    成功后返回 user_id（格式为 agent-{agent_id}），用于后续 WebSocket 连接。"""
    if _agent_registry is None or _room_service is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Service not initialized",
        )

    # 验证 Agent 凭据
    agent_info = await _agent_registry.verify_agent(data.agent_id, data.agent_secret)
    if not agent_info:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid agent_id or agent_secret",
        )

    try:
        room_uuid = UUID(data.room_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid room_id")

    # 通过 room_password 定位房间
    room = await _room_service.get_room_by_password(data.room_password)
    if not room:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Room not found or invalid room_password",
        )

    if room.id != room_uuid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="room_id does not match the room identified by room_password",
        )

    # 加入房间（user_id 固定为 agent-{agent_id} 格式）
    from ...schemas.room import RoomJoinRequest

    user_id = f"agent-{data.agent_id}"
    join_request = RoomJoinRequest(
        user_id=user_id,
        username=agent_info.name,
        password=data.room_password,
        user_type="agent",
        a2a_endpoint=agent_info.endpoint if agent_info.endpoint else None,
        agent_id=data.agent_id,
    )

    try:
        member = await _room_service.join_room(room_uuid, join_request)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error("http_agent_join_room_error", agent_id=data.agent_id, error=str(e))
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

    # 更新内存中的 room 索引
    await _agent_registry.add_agent_to_room(data.agent_id, room_uuid)

    logger.info(
        "http_agent_joined_room",
        agent_id=data.agent_id,
        room_id=data.room_id,
        user_id=user_id,
    )

    return AgentJoinResponse(
        agent_id=data.agent_id,
        user_id=member.user_id,
        username=agent_info.name,
        room_id=data.room_id,
        message=f"Agent '{agent_info.name}' joined room. Connect WebSocket with agent_id and agent_secret.",
    )


# ---------------------------------------------------------------------------
# 查询 / 管理接口
# ---------------------------------------------------------------------------

@router.get("", summary="List all registered agents")
async def list_agents(room_id: Optional[str] = None):
    if _agent_registry is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Service not initialized")
    try:
        if room_id:
            agents = await _agent_registry.list_agents_in_room(UUID(room_id))
        else:
            agents = await _agent_registry.list_agents()
        return {"agents": [a.to_dict() for a in agents], "total": len(agents)}
    except Exception as e:
        logger.error("http_list_agents_error", error=str(e))
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@router.get("/{agent_id}", summary="Get agent info")
async def get_agent(agent_id: str):
    if _agent_registry is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Service not initialized")
    agent = await _agent_registry.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Agent {agent_id} not found")
    return agent.to_dict()


@router.delete("/{agent_id}", summary="Unregister an agent")
async def unregister_agent(agent_id: str):
    if _agent_registry is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Service not initialized")

    agent_info = await _agent_registry.get_agent(agent_id)
    if not agent_info:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Agent {agent_id} not found")

    if agent_info.room_id and _room_service:
        try:
            await _room_service.remove_member(agent_info.room_id, f"agent-{agent_id}")
        except Exception:
            pass

    result = await _agent_registry.unregister_agent(agent_id)
    return {"success": result, "agent_id": agent_id}


@router.post("/{agent_id}/ping", summary="Ping an agent to check connectivity")
async def ping_agent(agent_id: str):
    if _agent_registry is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Service not initialized")
    agent = await _agent_registry.get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Agent {agent_id} not found")
    is_online = await _agent_registry.ping_agent(agent_id)
    return {"agent_id": agent_id, "online": is_online, "status": agent.status}
