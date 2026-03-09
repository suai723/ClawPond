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

    # 初始化数据库连接
    await init_db()
    logger.info("database_connected")

    # 将共享实例注入到各路由模块
    setup_room_router(room_service)
    # 注入 agent_registry 到 message_service
    message_service.set_agent_registry(agent_registry)

    # 注入广播回调（让 MessageService 能广播 Agent 回复）
    message_service.set_broadcast_callback(ws_manager.broadcast_to_room)

    # 注入 WS 连接检查：若 Agent 已通过 WebSocket 在线，跳过 HTTP A2A 调用
    message_service.set_ws_connected_check(ws_manager.is_connected)

    # 注入依赖到 agent router
    setup_agent_router(agent_registry, room_service)

    # 从数据库恢复 Agent 注册（防止 relay 重启后 AgentRegistry 清空）
    try:
        agent_members = await room_service.get_all_agent_members()
        restored_count = 0
        for member in agent_members:
            try:
                # 使用 DB 中存储的 agent_id，保持 ID 稳定；若旧数据无 agent_id 则生成新的
                await agent_registry.register_agent(
                    name=member.username,
                    endpoint=member.a2a_endpoint or "ws-only",
                    room_id=member.room_id,
                    agent_id=member.agent_id or None,  # None → registry 会生成新 UUID
                )
                restored_count += 1
            except Exception:
                pass  # 防御性：跳过恢复失败的 agent
        if restored_count:
            logger.info("agents_restored_from_db", count=restored_count)
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

# 创建 FastAPI 应用
app = FastAPI(
    title="OpenClaw Multi-Agent Relay Service",
    version="0.1.0",
    description="A multi-agent collaboration platform with A2A protocol support and MCP registration",
    lifespan=lifespan,
)

# 配置 CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 挂载 MCP Server（SSE 端点）
app.mount("/mcp", mcp_server.sse_app())

# 注册路由
app.include_router(auth_router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(room_router, prefix="/api/v1/rooms", tags=["rooms"])
app.include_router(agent_router, prefix="/api/v1/agents", tags=["agents"])


@app.get("/")
async def root():
    """根路由"""
    return {
        "name": "OpenClaw Relay Service",
        "version": "0.1.0",
        "description": "Multi-agent collaboration platform",
        "endpoints": {
            "rooms": "/api/v1/rooms",
            "agents": "/api/v1/agents",
            "websocket": "/ws?password=<access_token>",
            "mcp": "/mcp",
            "docs": "/docs",
            "redoc": "/redoc",
        },
    }


@app.get("/health")
async def health_check():
    """健康检查"""
    return {
        "status": "healthy",
        "service": "openclaw-relay",
        "timestamp": asyncio.get_event_loop().time(),
    }


@app.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    password: str = Query(""),
    user_id: str = Query(""),
    username: str = Query(""),
    user_type: str = Query("human"),
    role: str = Query("member"),
    token: str = Query(""),
):
    """WebSocket 端点 — 通过 password（access_token）定位房间"""
    from .core.security import decode_token as _decode_token

    room_uuid = None
    try:
        # 通过密码查找房间
        if not password:
            await websocket.close(code=4000, reason="Room password required")
            return

        room = await room_service.get_room_by_password(password)
        if not room:
            await websocket.close(code=4004, reason="Room not found or invalid password")
            return
        room_uuid = room.id

        # 人类用户必须携带有效 JWT token
        if user_type == "human":
            if not token:
                await websocket.close(code=4001, reason="Authentication required")
                return
            try:
                payload = _decode_token(token)
                user_id = payload["sub"]
                username = payload["username"]
            except Exception:
                await websocket.close(code=4001, reason="Invalid token")
                return

        connected = await ws_manager.connect(
            websocket=websocket,
            room_id=room_uuid,
            user_id=user_id,
            username=username,
            user_type=user_type,
            role=role,
        )

        if not connected:
            return

        while True:
            try:
                data = await websocket.receive_json()
                response = await ws_manager.handle_message(room_uuid, user_id, data)
                if response:
                    await websocket.send_json(response)
            except WebSocketDisconnect:
                logger.info("websocket_disconnected", room_id=str(room_uuid), user_id=user_id)
                break
            except json.JSONDecodeError:
                logger.warning("invalid_json", room_id=str(room_uuid), user_id=user_id)
                await websocket.send_json({"error": "Invalid JSON"})
            except Exception as e:
                logger.error("websocket_error", room_id=str(room_uuid), user_id=user_id, error=str(e))
                await websocket.send_json({"error": "Internal server error"})

    except Exception as e:
        logger.error("websocket_endpoint_error", error=str(e))
    finally:
        if room_uuid is not None:
            try:
                await ws_manager.disconnect(room_uuid, user_id)
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

        # 广播给所有 WebSocket 连接
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
