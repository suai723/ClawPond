import asyncio
from typing import Dict, Set, List, Optional
from uuid import UUID
from fastapi import WebSocket
import json
import structlog
from datetime import datetime

from ...modules.room.service import RoomService
from ...modules.message.service import MessageService
from ...modules.room.repository import RoomMember, MemberStatus

logger = structlog.get_logger()


class ConnectionInfo:
    """WebSocket连接信息（与房间无关，单用户单连接）"""
    def __init__(
        self,
        websocket: WebSocket,
        user_id: str,
        username: str,
        user_type: str,
    ):
        self.websocket = websocket
        self.user_id = user_id
        self.username = username
        self.user_type = user_type
        self.connected_at = datetime.utcnow()
        self.last_active_at = datetime.utcnow()
        self.message_count = 0


class WebSocketManager:
    """WebSocket连接管理器（每用户/Agent 维护单条全局连接，服务端按房间订阅分发消息）"""

    def __init__(
        self,
        room_service: RoomService,
        message_service: MessageService
    ):
        self.room_service = room_service
        self.message_service = message_service

        # user_id → ConnectionInfo（每用户单连接）
        self.user_connections: Dict[str, ConnectionInfo] = {}
        # user_id → Set[room_id str]（用户已订阅的房间集合）
        self.user_rooms: Dict[str, Set[str]] = {}
        # room_id str → Set[user_id str]（房间内在线用户，用于广播）
        self.room_users: Dict[str, Set[str]] = {}
        # room_id str → user_id str → {"role": str, "agent_id": str|None}
        self.room_member_meta: Dict[str, Dict[str, Dict]] = {}

        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # 连接生命周期
    # ------------------------------------------------------------------

    async def connect(
        self,
        websocket: WebSocket,
        user_id: str,
        username: str,
        user_type: str = "human",
    ) -> bool:
        """建立 WebSocket 连接（不加入任何房间，仅完成身份确认）"""
        try:
            await websocket.accept()

            old_ws_to_close = None

            async with self._lock:
                if user_id in self.user_connections:
                    old_ws_to_close = self.user_connections[user_id].websocket

                connection = ConnectionInfo(
                    websocket=websocket,
                    user_id=user_id,
                    username=username,
                    user_type=user_type,
                )
                self.user_connections[user_id] = connection

                if user_id not in self.user_rooms:
                    self.user_rooms[user_id] = set()

            # 锁外关闭旧连接，避免持锁执行 IO
            if old_ws_to_close:
                try:
                    await old_ws_to_close.close(code=4002, reason="New connection established")
                except Exception:
                    pass

            logger.info("websocket_connected", user_id=user_id, username=username)

            # 发送 connected 事件确认身份
            await self.send_to_user(user_id, {
                "event": "connected",
                "data": {"user_id": user_id, "username": username},
            })

            return True

        except Exception as e:
            logger.error("websocket_connect_error", error=str(e))
            try:
                await websocket.close(code=4000, reason="Internal server error")
            except Exception:
                pass
            return False

    async def disconnect(self, user_id: str):
        """断开连接，自动退出所有已订阅房间"""
        username = None
        rooms_to_leave: List[str] = []

        async with self._lock:
            conn = self.user_connections.pop(user_id, None)
            if conn:
                username = conn.username

            rooms_to_leave = list(self.user_rooms.pop(user_id, set()))

            for room_key in rooms_to_leave:
                if room_key in self.room_users:
                    self.room_users[room_key].discard(user_id)
                    if not self.room_users[room_key]:
                        del self.room_users[room_key]
                if room_key in self.room_member_meta:
                    self.room_member_meta[room_key].pop(user_id, None)
                    if not self.room_member_meta[room_key]:
                        del self.room_member_meta[room_key]

        if not username:
            return

        logger.info("websocket_disconnected", user_id=user_id)

        # 对每个已订阅房间执行状态更新和广播
        for room_key in rooms_to_leave:
            try:
                room_id = UUID(room_key)
                await self.room_service.update_member_status(
                    room_id, user_id, MemberStatus.OFFLINE
                )
                await self.broadcast_to_room(
                    room_id,
                    {
                        "event": "memberLeft",
                        "data": {
                            "room_id": room_key,
                            "user_id": user_id,
                            "username": username,
                            "online": False,
                        },
                    },
                    exclude_user_id=user_id,
                )
            except Exception as e:
                logger.error("disconnect_room_cleanup_error", room_id=room_key, error=str(e))

    # ------------------------------------------------------------------
    # 房间订阅管理
    # ------------------------------------------------------------------

    async def handle_join_room(self, user_id: str, password: str) -> Dict:
        """处理加入房间请求，订阅房间消息"""
        if not password:
            return {"event": "error", "data": {"message": "Room password required"}}

        room = await self.room_service.get_room_by_password(password)
        if not room:
            return {"event": "error", "data": {"message": "Room not found or invalid password"}}

        room_id = room.id
        room_key = str(room_id)

        member = await self.room_service.get_member(room_id, user_id)
        if not member:
            return {"event": "error", "data": {"message": "User not in room"}}

        agent_id = getattr(member, "agent_id", None)
        role = str(getattr(member, "role", "member"))

        async with self._lock:
            conn = self.user_connections.get(user_id)
            if not conn:
                return {"event": "error", "data": {"message": "Not connected"}}

            user_type = conn.user_type
            username = conn.username

            # 已订阅则幂等返回
            already_joined = room_key in self.user_rooms.get(user_id, set())

            if room_key not in self.room_users:
                self.room_users[room_key] = set()
            self.room_users[room_key].add(user_id)

            if user_id not in self.user_rooms:
                self.user_rooms[user_id] = set()
            self.user_rooms[user_id].add(room_key)

            if room_key not in self.room_member_meta:
                self.room_member_meta[room_key] = {}
            self.room_member_meta[room_key][user_id] = {
                "role": role,
                "agent_id": str(agent_id) if agent_id else None,
            }

        await self.room_service.update_member_status(room_id, user_id, MemberStatus.ONLINE)

        if not already_joined:
            member_joined_data: Dict = {
                "room_id": room_key,
                "user_id": user_id,
                "username": username,
                "user_type": user_type,
                "role": role,
                "online": True,
            }
            if agent_id:
                member_joined_data["agent_id"] = str(agent_id)

            await self.broadcast_to_room(
                room_id,
                {"event": "memberJoined", "data": member_joined_data},
                exclude_user_id=user_id,
            )

        logger.info("room_joined", room_id=room_key, user_id=user_id)

        room_joined_data: Dict = {
            "room_id": room_key,
            "room_name": room.name,
            "online_members": await self.get_online_members(room_id),
        }
        if agent_id:
            room_joined_data["agent_id"] = str(agent_id)

        return {"event": "roomJoined", "data": room_joined_data}

    async def handle_leave_room(self, user_id: str, room_id_str: str) -> Dict:
        """处理离开房间请求，取消订阅"""
        if not room_id_str:
            return {"event": "error", "data": {"message": "room_id required"}}

        try:
            room_id = UUID(room_id_str)
        except ValueError:
            return {"event": "error", "data": {"message": "Invalid room_id"}}

        room_key = room_id_str
        username = None

        async with self._lock:
            conn = self.user_connections.get(user_id)
            if conn:
                username = conn.username

            if room_key in self.room_users:
                self.room_users[room_key].discard(user_id)
                if not self.room_users[room_key]:
                    del self.room_users[room_key]

            if user_id in self.user_rooms:
                self.user_rooms[user_id].discard(room_key)

            if room_key in self.room_member_meta:
                self.room_member_meta[room_key].pop(user_id, None)
                if not self.room_member_meta[room_key]:
                    del self.room_member_meta[room_key]

        await self.room_service.update_member_status(room_id, user_id, MemberStatus.OFFLINE)

        if username:
            await self.broadcast_to_room(
                room_id,
                {
                    "event": "memberLeft",
                    "data": {
                        "room_id": room_key,
                        "user_id": user_id,
                        "username": username,
                        "online": False,
                    },
                },
                exclude_user_id=user_id,
            )

        logger.info("room_left", room_id=room_key, user_id=user_id)
        return {"event": "roomLeft", "data": {"room_id": room_key}}

    # ------------------------------------------------------------------
    # 消息收发
    # ------------------------------------------------------------------

    async def send_to_user(self, user_id: str, message: Dict) -> bool:
        """向指定用户发送消息（无需指定房间）"""
        try:
            async with self._lock:
                conn = self.user_connections.get(user_id)
                if not conn:
                    return False

            try:
                await conn.websocket.send_json(message)
                async with self._lock:
                    if (
                        user_id in self.user_connections
                        and self.user_connections[user_id] is conn
                    ):
                        self.user_connections[user_id].last_active_at = datetime.utcnow()
                return True
            except Exception as e:
                logger.error("send_to_user_failed", user_id=user_id, error=str(e))
                await self.disconnect(user_id)
                return False

        except Exception as e:
            logger.error("send_to_user_error", error=str(e))
            return False

    async def broadcast_to_room(
        self,
        room_id: UUID,
        message: Dict,
        exclude_user_id: Optional[str] = None,
    ):
        """广播消息给房间内所有在线用户"""
        room_key = str(room_id)

        async with self._lock:
            user_ids = list(self.room_users.get(room_key, set()))

        tasks = []
        for uid in user_ids:
            if uid == exclude_user_id:
                continue
            tasks.append(self.send_to_user(uid, message))

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def handle_message(self, user_id: str, data: Dict) -> Optional[Dict]:
        """分发处理 WebSocket 消息"""
        logger.info(
            "ws_raw_message_received",
            user_id=user_id,
            raw=json.dumps(data, ensure_ascii=False, default=str),
        )
        method = data.get("method")
        params = data.get("params", {})

        if method == "joinRoom":
            return await self.handle_join_room(user_id, params.get("password", ""))

        elif method == "leaveRoom":
            return await self.handle_leave_room(user_id, params.get("room_id", ""))

        elif method == "sendMessage":
            room_id_str = params.get("room_id", "")
            if not room_id_str:
                return {"error": "room_id required"}
            try:
                room_id = UUID(room_id_str)
            except ValueError:
                return {"error": "Invalid room_id"}
            if not self.is_connected(room_id, user_id):
                return {"error": "Not joined in room"}
            return await self._handle_send_message(room_id, user_id, params)

        elif method == "ping":
            return {"method": "pong"}

        elif method == "getOnlineMembers":
            room_id_str = params.get("room_id", "")
            if not room_id_str:
                return {"error": "room_id required"}
            try:
                room_id = UUID(room_id_str)
            except ValueError:
                return {"error": "Invalid room_id"}
            return {
                "method": "onlineMembers",
                "data": await self.get_online_members(room_id),
            }

        elif method == "getRecentMessages":
            room_id_str = params.get("room_id", "")
            if not room_id_str:
                return {"error": "room_id required"}
            try:
                room_id = UUID(room_id_str)
            except ValueError:
                return {"error": "Invalid room_id"}
            limit = params.get("limit", 20)
            messages = await self.message_service.get_recent_messages(room_id, limit)
            return {
                "method": "recentMessages",
                "data": [msg.to_dict() for msg in messages],
            }

        else:
            return {"error": "Unknown method", "method": method}

    async def _handle_send_message(
        self,
        room_id: UUID,
        user_id: str,
        params: Dict,
    ) -> Dict:
        """处理发送消息请求"""
        member = await self.room_service.get_member(room_id, user_id)
        if not member:
            return {"error": "User not in room"}

        from ...schemas.message import MessageCreate

        message_data = MessageCreate(
            room_id=room_id,
            sender_id=user_id,
            sender_name=member.username,
            text=params.get("text", ""),
            mentions=params.get("mentions", []),
            reply_to=params.get("reply_to"),
            attachments=params.get("attachments"),
            metadata=params.get("metadata"),
        )

        try:
            message = await self.message_service.send_message(message_data)

            await self.broadcast_to_room(
                room_id,
                {"event": "message", "data": message.to_dict()},
            )

            room_key = str(room_id)
            async with self._lock:
                if user_id in self.user_connections:
                    self.user_connections[user_id].message_count += 1

            return {"method": "messageSent", "data": message.to_dict()}

        except Exception as e:
            logger.error("send_message_failed", error=str(e))
            return {"error": str(e)}

    # ------------------------------------------------------------------
    # 查询工具
    # ------------------------------------------------------------------

    async def get_online_members(self, room_id: UUID) -> List[Dict]:
        """获取房间在线成员列表"""
        room_key = str(room_id)

        async with self._lock:
            user_ids = list(self.room_users.get(room_key, set()))
            result = []
            for uid in user_ids:
                conn = self.user_connections.get(uid)
                if not conn:
                    continue
                meta = self.room_member_meta.get(room_key, {}).get(uid, {})
                d: Dict = {
                    "user_id": conn.user_id,
                    "username": conn.username,
                    "user_type": conn.user_type,
                    "role": meta.get("role", "member"),
                    "connected_at": conn.connected_at.isoformat(),
                    "last_active_at": conn.last_active_at.isoformat(),
                    "message_count": conn.message_count,
                }
                agent_id = meta.get("agent_id")
                if agent_id:
                    d["agent_id"] = agent_id
                result.append(d)
        return result

    async def get_connection_count(self, room_id: UUID) -> int:
        """获取房间连接数"""
        room_key = str(room_id)
        async with self._lock:
            return len(self.room_users.get(room_key, set()))

    async def get_total_connection_count(self) -> int:
        """获取总连接数（按用户计）"""
        async with self._lock:
            return len(self.user_connections)

    def is_connected(self, room_id: UUID, user_id: str) -> bool:
        """检查用户是否已订阅该房间且 WebSocket 在线（同步，供 MessageService 注入使用）"""
        room_key = str(room_id)
        return (
            user_id in self.room_users.get(room_key, set())
            and user_id in self.user_connections
        )

    # ------------------------------------------------------------------
    # 系统消息 / 提及通知
    # ------------------------------------------------------------------

    async def send_system_message(
        self,
        room_id: UUID,
        text: str,
        metadata: Optional[Dict] = None,
    ):
        """发送系统消息"""
        from ...schemas.message import MessageCreate

        message_data = MessageCreate(
            room_id=room_id,
            sender_id="system",
            sender_name="System",
            text=text,
            type="system",
            metadata=metadata or {},
        )

        try:
            message = await self.message_service.send_message(message_data)
            await self.broadcast_to_room(
                room_id,
                {"event": "systemMessage", "data": message.to_dict()},
            )
        except Exception as e:
            logger.error("send_system_message_failed", error=str(e))

    async def notify_mention(
        self,
        room_id: UUID,
        mentioned_user_id: str,
        mentioner_id: str,
        mentioner_name: str,
        message_text: str,
        message_id: int,
    ):
        """通知被提及的用户"""
        await self.send_to_user(
            mentioned_user_id,
            {
                "event": "mentioned",
                "data": {
                    "room_id": str(room_id),
                    "mentioner_id": mentioner_id,
                    "mentioner_name": mentioner_name,
                    "message_text": (
                        message_text[:100] + "..."
                        if len(message_text) > 100
                        else message_text
                    ),
                    "message_id": message_id,
                    "timestamp": datetime.utcnow().isoformat(),
                },
            },
        )
