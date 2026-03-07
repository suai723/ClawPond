"""
MCP Server for OpenClaw Relay Service
Allows OpenClaw Agents to register and discover chatrooms via MCP protocol.
"""
from typing import Optional, List, Dict, Any
from mcp.server.fastmcp import FastMCP
import structlog

logger = structlog.get_logger()

# 全局服务引用，由 main.py 注入
_room_service = None
_agent_registry = None


def setup_mcp_server(room_service, agent_registry) -> FastMCP:
    """初始化并配置 MCP Server，注入服务依赖"""
    global _room_service, _agent_registry
    _room_service = room_service
    _agent_registry = agent_registry

    mcp = FastMCP(
        name="OpenClaw Relay",
        instructions=(
            "This is the OpenClaw Multi-Agent Relay Service. "
            "Use register_agent to join a chatroom with your A2A endpoint. "
            "Use list_rooms to discover available rooms. "
            "Messages directed to you via @mention will be forwarded to your A2A endpoint."
        ),
    )

    @mcp.tool()
    async def list_rooms(page: int = 1, page_size: int = 20) -> Dict[str, Any]:
        """List all active chatrooms available for agents to join.

        Args:
            page: Page number (default: 1)
            page_size: Number of rooms per page (default: 20)

        Returns:
            Dictionary with rooms list and pagination info
        """
        if _room_service is None:
            return {"error": "Service not initialized"}

        try:
            rooms, total = await _room_service.list_rooms(page=page, page_size=page_size)
            return {
                "rooms": [
                    {
                        "id": str(room.id),
                        "name": room.name,
                        "description": room.description,
                        "member_count": room.member_count,
                        "max_members": room.max_members,
                        "status": room.status,
                        "created_at": room.created_at.isoformat(),
                    }
                    for room in rooms
                ],
                "total": total,
                "page": page,
                "page_size": page_size,
            }
        except Exception as e:
            logger.error("mcp_list_rooms_error", error=str(e))
            return {"error": str(e)}

    @mcp.tool()
    async def register_agent(
        name: str,
        endpoint: str,
        room_id: str,
        room_password: str,
        description: str = "",
        skills: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """Register an OpenClaw Agent to a chatroom.

        The agent will join the room as a member and its A2A endpoint will be
        stored. When a user @mentions the agent in the chatroom, the relay will
        forward the message to the agent's A2A endpoint.

        Args:
            name: Unique agent name (used in @mentions, e.g. "MyAgent" → @MyAgent)
            endpoint: Agent's A2A HTTP endpoint base URL (e.g. "http://localhost:9001")
            room_id: UUID of the room to join
            room_password: Password for the room
            description: Human-readable description of the agent's capabilities
            skills: List of skill names the agent supports

        Returns:
            Dictionary with agent_id, user_id and registration status
        """
        if _room_service is None or _agent_registry is None:
            return {"error": "Service not initialized"}

        try:
            from uuid import UUID
            from ...schemas.room import RoomJoinRequest

            room_uuid = UUID(room_id)

            # 先注册到 AgentRegistry，获取服务端分发的 UUID
            agent_info = await _agent_registry.register_agent(
                name=name,
                endpoint=endpoint,
                room_id=room_uuid,
                description=description,
                skills=skills or [],
            )

            # 用 agent_id (UUID) 构造 user_id，以 agent 身份加入房间
            join_request = RoomJoinRequest(
                user_id=f"agent-{agent_info.agent_id}",
                username=name,
                password=room_password,
                user_type="agent",
                a2a_endpoint=endpoint,
                agent_id=agent_info.agent_id,
            )
            member = await _room_service.join_room(room_uuid, join_request)

            logger.info(
                "mcp_agent_registered",
                agent_id=agent_info.agent_id,
                name=name,
                room_id=room_id,
            )

            return {
                "success": True,
                "agent_id": agent_info.agent_id,
                "user_id": member.user_id,
                "name": name,
                "room_id": room_id,
                "message": (
                    f"Agent '{name}' registered successfully. "
                    f"Users can mention you with @{name} in the chatroom."
                ),
            }
        except ValueError as e:
            logger.warning("mcp_register_agent_validation_error", error=str(e))
            return {"error": str(e), "success": False}
        except Exception as e:
            logger.error("mcp_register_agent_error", error=str(e))
            return {"error": str(e), "success": False}

    @mcp.tool()
    async def unregister_agent(agent_id: str) -> Dict[str, Any]:
        """Unregister an agent from the relay service.

        Args:
            agent_id: The agent_id returned during registration

        Returns:
            Success status
        """
        if _agent_registry is None:
            return {"error": "Service not initialized"}

        try:
            # 获取 agent 信息（用于离开房间）
            agent_info = await _agent_registry.get_agent(agent_id)
            if not agent_info:
                return {"error": f"Agent {agent_id} not found", "success": False}

            # 从房间移除成员
            if agent_info.room_id and _room_service:
                try:
                    await _room_service.remove_member(
                        agent_info.room_id, f"agent-{agent_info.agent_id}"
                    )
                except Exception:
                    pass

            # 从注册表注销
            result = await _agent_registry.unregister_agent(agent_id)
            return {"success": result, "agent_id": agent_id}
        except Exception as e:
            logger.error("mcp_unregister_agent_error", error=str(e))
            return {"error": str(e), "success": False}

    @mcp.tool()
    async def list_agents(room_id: Optional[str] = None) -> Dict[str, Any]:
        """List registered agents.

        Args:
            room_id: Optional room UUID to filter agents by room

        Returns:
            List of agent information
        """
        if _agent_registry is None:
            return {"error": "Service not initialized"}

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
            logger.error("mcp_list_agents_error", error=str(e))
            return {"error": str(e)}

    @mcp.tool()
    async def get_room_messages(
        room_id: str, limit: int = 20, start_message_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """Retrieve recent messages from a chatroom.

        Args:
            room_id: UUID of the room
            limit: Maximum number of messages to return (default: 20)
            start_message_id: Fetch messages after this ID (for pagination)

        Returns:
            List of messages with sender info
        """
        if _room_service is None:
            return {"error": "Service not initialized"}

        # 此工具需要 message_service，通过全局注入获取
        global _message_service
        if _message_service is None:
            return {"error": "Message service not initialized"}

        try:
            from uuid import UUID
            from ...schemas.message import MessageFilter

            room_uuid = UUID(room_id)
            messages = await _message_service.get_messages(
                MessageFilter(
                    room_id=room_uuid,
                    limit=limit,
                    start_message_id=start_message_id,
                )
            )

            return {
                "messages": [msg.to_dict() for msg in messages],
                "total": len(messages),
                "room_id": room_id,
            }
        except Exception as e:
            logger.error("mcp_get_messages_error", error=str(e))
            return {"error": str(e)}

    return mcp


def setup_message_service(message_service):
    """注入 message_service（独立函数，避免循环依赖）"""
    global _message_service
    _message_service = message_service


_message_service = None
