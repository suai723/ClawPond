from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import json
from contextlib import asynccontextmanager
import structlog

from .core.database import init_db, close_db
from .modules.room.service import RoomService
from .modules.message.service import MessageService
from .modules.websocket.manager import WebSocketManager
from .modules.agent.registry import AgentRegistry
from .modules.room.router import router as room_router, setup_room_router
from .modules.agent.router import router as agent_router, setup_agent_router
from .modules.auth.router import router as auth_router
from .modules.mcp.server import setup_mcp_server, setup_message_service
from .schemas.message import MessageCreate, MessageFilter

# 创建服务实例
room_service = RoomService()
message_service = MessageService(room_service)
agent_registry = AgentRegistry()
ws_manager = WebSocketManager(room_service, message_service)

logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    logger.info("openclaw_relay_starting")

    await init_db()
    logger.info("database_connected")

    setup_room_router(room_service)
    message_service.set_agent_registry(agent_registry)
    message_service.set_broadcast_callback(ws_manager.broadcast_to_room)
    message_service.set_ws_connected_check(ws_manager.is_connected)
    setup_agent_router(agent_registry, room_service)

    # 从 agents 表恢复内存缓存（含 secret_hash，可直接校验 WS 凭据）
    try:
        restored = await agent_registry.restore_from_db()
        logger.info("agent_registry_restored", count=restored)
    except Exception as e:
        logger.warning("agent_restore_failed", error=str(e))

    logger.info("services_initialized")
    yield

    logger.info("openclaw_relay_shutting_down")
    await agent_registry.cleanup()
    await close_db()
    logger.info("database_disconnected")


# MCP Server（在 lifespan 外初始化，因为需要 app 挂载）
mcp_server = setup_mcp_server(room_service, agent_registry)
setup_message_service(message_service)

app = FastAPI(
    title="OpenClaw Multi-Agent Relay Service",
    version="0.1.0",
    description="A multi-agent collaboration platform with A2A protocol support and MCP registration",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/mcp", mcp_server.sse_app())

app.include_router(auth_router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(room_router, prefix="/api/v1/rooms", tags=["rooms"])
app.include_router(agent_router, prefix="/api/v1/agents", tags=["agents"])


@app.get("/")
async def root():
    return {
        "name": "OpenClaw Relay Service",
        "version": "0.1.0",
        "description": "Multi-agent collaboration platform",
        "endpoints": {
            "rooms": "/api/v1/rooms",
            "agents": "/api/v1/agents",
            "websocket_human": "/ws?token=<jwt>",
            "websocket_agent": "/ws?agent_id=<id>&agent_secret=<secret>&user_type=agent",
            "mcp": "/mcp",
            "docs": "/docs",
            "redoc": "/redoc",
        },
    }


@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "service": "openclaw-relay",
        "timestamp": asyncio.get_event_loop().time(),
    }


@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    # 人类用户
    token: str = Query(""),
    # Agent 用户（新认证方式：agent_id + agent_secret）
    agent_id: str = Query(""),
    agent_secret: str = Query(""),
    # 通用参数
    user_type: str = Query("human"),
    # 旧式非认证参数（保留向后兼容，仅 user_type 非 human/agent 时使用）
    user_id: str = Query(""),
    username: str = Query(""),
):
    """WebSocket 端点

    - 人类用户：/ws?token=<jwt>
    - Agent 用户：/ws?agent_id=<id>&agent_secret=<secret>&user_type=agent
    """
    from .core.security import decode_token as _decode_token

    resolved_user_id = ""
    resolved_username = ""

    try:
        if user_type == "human":
            if not token:
                await websocket.close(code=4001, reason="Authentication required")
                return
            try:
                payload = _decode_token(token)
                resolved_user_id = payload["sub"]
                resolved_username = payload["username"]
            except Exception:
                await websocket.close(code=4001, reason="Invalid token")
                return

        elif user_type == "agent":
            if not agent_id or not agent_secret:
                await websocket.close(code=4000, reason="agent_id and agent_secret required")
                return
            agent_info = await agent_registry.verify_agent(agent_id, agent_secret)
            if not agent_info:
                await websocket.close(code=4001, reason="Invalid agent credentials")
                return
            resolved_user_id = f"agent-{agent_id}"
            resolved_username = agent_info.name

        else:
            # 向后兼容：system 等类型，要求明确传 user_id 和 username
            if not user_id or not username:
                await websocket.close(code=4000, reason="user_id and username required")
                return
            resolved_user_id = user_id
            resolved_username = username

        connected = await ws_manager.connect(
            websocket=websocket,
            user_id=resolved_user_id,
            username=resolved_username,
            user_type=user_type,
        )

        if not connected:
            return

        while True:
            try:
                data = await websocket.receive_json()
                response = await ws_manager.handle_message(resolved_user_id, data)
                if response:
                    await websocket.send_json(response)
            except WebSocketDisconnect:
                logger.info("websocket_disconnected", user_id=resolved_user_id)
                break
            except json.JSONDecodeError:
                logger.warning("invalid_json", user_id=resolved_user_id)
                await websocket.send_json({"error": "Invalid JSON"})
            except Exception as e:
                logger.error("websocket_error", user_id=resolved_user_id, error=str(e))
                await websocket.send_json({"error": "Internal server error"})

    except Exception as e:
        logger.error("websocket_endpoint_error", error=str(e))
    finally:
        try:
            if resolved_user_id:
                await ws_manager.disconnect(resolved_user_id)
        except Exception as e:
            logger.error("disconnect_error", error=str(e))


@app.post("/api/v1/rooms/messages", status_code=201)
async def create_message_endpoint(body: dict):
    """通过 HTTP 发送消息 — body 需包含 password（access_token）"""
    password = body.get("password", "")
    if not password:
        raise HTTPException(status_code=400, detail="Room password required")

    room = await room_service.get_room_by_password(password)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found or invalid password")

    try:
        data = MessageCreate(
            room_id=room.id,
            sender_id=body.get("sender_id", ""),
            sender_name=body.get("sender_name", ""),
            text=body.get("text", ""),
            type=body.get("type", "text"),
            mentions=body.get("mentions", []),
            reply_to=body.get("reply_to"),
            metadata=body.get("metadata"),
        )
        message = await message_service.send_message(data)

        await ws_manager.broadcast_to_room(
            room.id,
            {"event": "message", "data": message.to_dict()},
        )

        return message.to_dict()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("create_message_http_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/rooms/messages")
async def get_messages_endpoint(
    password: str = Query(..., description="房间 access_token"),
    limit: int = Query(default=20, ge=1, le=100),
    start_message_id: int = Query(default=None),
):
    """获取房间消息历史 — 通过 password（access_token）定位房间"""
    room = await room_service.get_room_by_password(password)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found or invalid password")

    try:
        messages = await message_service.get_messages(
            MessageFilter(
                room_id=room.id,
                limit=limit,
                start_message_id=start_message_id,
            )
        )
        return {
            "messages": [msg.to_dict() for msg in messages],
            "total": len(messages),
            "room_id": str(room.id),
        }
    except Exception as e:
        logger.error("get_messages_http_error", error=str(e))
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "src.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
