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
    """WebSocket连接信息"""
    def __init__(
        self,
        websocket: WebSocket,
        user_id: str,
        username: str,
        user_type: str,
        room_id: UUID,
        role: str = "member",
        agent_id: Optional[str] = None,
    ):
        self.websocket = websocket
        self.user_id = user_id
        self.username = username
        self.user_type = user_type
        self.room_id = room_id
        self.role = role
        self.agent_id = agent_id  # 服务端分发的 UUID（仅 agent 有值）
        self.connected_at = datetime.utcnow()
        self.last_active_at = datetime.utcnow()
        self.message_count = 0
    
    def to_dict(self) -> Dict[str, any]:
        """转换为字典"""
        d = {
            "user_id": self.user_id,
            "username": self.username,
            "user_type": self.user_type,
            "role": self.role,
            "connected_at": self.connected_at.isoformat(),
            "last_active_at": self.last_active_at.isoformat(),
            "message_count": self.message_count,
        }
        if self.agent_id:
            d["agent_id"] = self.agent_id
        return d


class WebSocketManager:
    """WebSocket连接管理器"""
    
    def __init__(
        self,
        room_service: RoomService,
        message_service: MessageService
    ):
        self.room_service = room_service
        self.message_service = message_service
        
        # 连接存储结构: room_id -> {user_id: ConnectionInfo}
        self.connections: Dict[str, Dict[str, ConnectionInfo]] = {}
        self._lock = asyncio.Lock()
    
    async def connect(
        self,
        websocket: WebSocket,
        room_id: UUID,
        user_id: str,
        username: str,
        user_type: str = "human",
        role: str = "member"
    ) -> bool:
        """建立WebSocket连接"""
        try:
            await websocket.accept()
            
            # 验证用户是否在房间中
            member = await self.room_service.get_member(room_id, user_id)
            if not member:
                logger.warning("user_not_in_room", room_id=str(room_id), user_id=user_id)
                await websocket.close(code=4001, reason="User not in room")
                return False
            
            # 从 DB 成员记录中取 agent_id（仅 agent 有值）
            agent_id = getattr(member, 'agent_id', None)

            room_key = str(room_id)
            old_ws_to_close = None

            # 在锁内只做状态修改，不发任何网络消息（避免死锁）
            async with self._lock:
                if room_key not in self.connections:
                    self.connections[room_key] = {}

                # 记录旧连接待关闭
                if user_id in self.connections[room_key]:
                    old_ws_to_close = self.connections[room_key][user_id].websocket

                connection = ConnectionInfo(
                    websocket=websocket,
                    user_id=user_id,
                    username=username,
                    user_type=user_type,
                    room_id=room_id,
                    role=role,
                    agent_id=agent_id,
                )
                self.connections[room_key][user_id] = connection

            # 锁外处理旧连接关闭
            if old_ws_to_close:
                try:
                    await old_ws_to_close.close(code=4002, reason="New connection established")
                except Exception:
                    pass

            # 锁外更新成员状态
            await self.room_service.update_member_status(
                room_id, user_id, MemberStatus.ONLINE
            )

            logger.info(
                "websocket_connected",
                room_id=room_key,
                user_id=user_id,
                username=username
            )

            # 锁外广播成员加入事件，agent 携带 agent_id
            member_joined_data: Dict[str, any] = {
                "user_id": user_id,
                "username": username,
                "user_type": user_type,
                "role": role,
                "online": True,
            }
            if agent_id:
                member_joined_data["agent_id"] = agent_id

            await self.broadcast_to_room(
                room_id,
                {"event": "memberJoined", "data": member_joined_data},
                exclude_user_id=user_id
            )

            # 锁外发送 connected 事件，包含 agent_id（供插件自我识别）
            connected_data: Dict[str, any] = {
                "room_id": str(room_id),
                "user_id": user_id,
                "username": username,
                "online_members": await self.get_online_members(room_id),
            }
            if agent_id:
                connected_data["agent_id"] = agent_id

            await self.send_to_user(
                room_id, user_id,
                {"event": "connected", "data": connected_data}
            )

            return True
                
        except Exception as e:
            logger.error("websocket_connect_error", error=str(e))
            try:
                await websocket.close(code=4000, reason="Internal server error")
            except Exception:
                pass
            return False
    
    async def disconnect(
        self,
        room_id: UUID,
        user_id: str
    ):
        """断开WebSocket连接"""
        room_key = str(room_id)
        disconnected_username = None

        # 在锁内只做状态修改
        async with self._lock:
            if room_key in self.connections and user_id in self.connections[room_key]:
                connection = self.connections[room_key].pop(user_id)
                disconnected_username = connection.username

                if not self.connections[room_key]:
                    del self.connections[room_key]

        if disconnected_username is None:
            return

        # 锁外做 IO 操作
        await self.room_service.update_member_status(
            room_id, user_id, MemberStatus.OFFLINE
        )

        logger.info(
            "websocket_disconnected",
            room_id=room_key,
            user_id=user_id
        )

        # 锁外广播成员离开事件
        await self.broadcast_to_room(
            room_id,
            {
                "event": "memberLeft",
                "data": {
                    "user_id": user_id,
                    "username": disconnected_username,
                    "online": False,
                }
            },
            exclude_user_id=user_id
        )
    
    async def send_to_user(
        self,
        room_id: UUID,
        user_id: str,
        message: Dict[str, any]
    ) -> bool:
        """向指定用户发送消息"""
        try:
            room_key = str(room_id)

            # 在锁内只获取连接引用，不做网络 I/O
            async with self._lock:
                if room_key not in self.connections:
                    return False
                if user_id not in self.connections[room_key]:
                    return False
                connection = self.connections[room_key][user_id]

            # 在锁外执行网络发送，避免持锁时 I/O 阻塞
            try:
                await connection.websocket.send_json(message)
                async with self._lock:
                    # 更新活跃时间（连接可能已被替换，需再次确认）
                    if (room_key in self.connections
                            and user_id in self.connections[room_key]
                            and self.connections[room_key][user_id] is connection):
                        self.connections[room_key][user_id].last_active_at = datetime.utcnow()
                return True
            except Exception as e:
                logger.error(
                    "send_to_user_failed",
                    room_id=room_key,
                    user_id=user_id,
                    error=str(e)
                )
                # 锁外调用 disconnect，避免死锁
                await self.disconnect(room_id, user_id)
                return False

        except Exception as e:
            logger.error("send_to_user_error", error=str(e))
            return False
    
    async def broadcast_to_room(
        self,
        room_id: UUID,
        message: Dict[str, any],
        exclude_user_id: Optional[str] = None
    ):
        """广播消息给房间内所有在线用户"""
        room_key = str(room_id)
        
        async with self._lock:
            if room_key not in self.connections:
                return
            
            connections = list(self.connections[room_key].items())
            
        # 在锁外发送消息，避免阻塞
        tasks = []
        for user_id, connection in connections:
            if user_id == exclude_user_id:
                continue
            
            tasks.append(self.send_to_user(room_id, user_id, message))
        
        # 并行发送
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
    
    async def handle_message(
        self,
        room_id: UUID,
        user_id: str,
        data: Dict[str, any]
    ) -> Dict[str, any]:
        """处理WebSocket消息"""
        logger.info(
            "ws_raw_message_received",
            room_id=str(room_id),
            user_id=user_id,
            raw=json.dumps(data, ensure_ascii=False, default=str),
        )
        method = data.get("method")
        
        if method == "sendMessage":
            return await self._handle_send_message(room_id, user_id, data.get("params", {}))
        elif method == "ping":
            return {"method": "pong"}
        elif method == "getOnlineMembers":
            return {
                "method": "onlineMembers",
                "data": await self.get_online_members(room_id)
            }
        elif method == "getRecentMessages":
            limit = data.get("params", {}).get("limit", 20)
            messages = await self.message_service.get_recent_messages(room_id, limit)
            return {
                "method": "recentMessages",
                "data": [msg.to_dict() for msg in messages]
            }
        else:
            return {
                "error": "Unknown method",
                "method": method
            }
    
    async def _handle_send_message(
        self,
        room_id: UUID,
        user_id: str,
        params: Dict[str, any]
    ) -> Dict[str, any]:
        """处理发送消息请求"""
        # 获取用户信息
        member = await self.room_service.get_member(room_id, user_id)
        if not member:
            return {"error": "User not in room"}
        
        # 创建消息
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
            # 发送消息
            message = await self.message_service.send_message(message_data)
            
            # 广播消息给房间内所有用户
            await self.broadcast_to_room(
                room_id,
                {
                    "event": "message",
                    "data": message.to_dict()
                }
            )
            
            # 记录消息发送
            room_key = str(room_id)
            if room_key in self.connections and user_id in self.connections[room_key]:
                self.connections[room_key][user_id].message_count += 1
            
            return {
                "method": "messageSent",
                "data": message.to_dict()
            }
            
        except Exception as e:
            logger.error("send_message_failed", error=str(e))
            return {"error": str(e)}
    
    async def get_online_members(self, room_id: UUID) -> List[Dict[str, any]]:
        """获取在线成员列表"""
        room_key = str(room_id)
        
        async with self._lock:
            if room_key not in self.connections:
                return []
            
            return [
                connection.to_dict()
                for connection in self.connections[room_key].values()
            ]
    
    async def get_connection_count(self, room_id: UUID) -> int:
        """获取房间连接数"""
        room_key = str(room_id)
        
        async with self._lock:
            if room_key not in self.connections:
                return 0
            
            return len(self.connections[room_key])
    
    async def get_total_connection_count(self) -> int:
        """获取总连接数"""
        async with self._lock:
            total = 0
            for connections in self.connections.values():
                total += len(connections)
            return total

    def is_connected(self, room_id: UUID, user_id: str) -> bool:
        """检查指定用户是否有活跃的 WebSocket 连接（同步，供 MessageService 注入使用）"""
        return user_id in self.connections.get(str(room_id), {})
    
    async def send_system_message(
        self,
        room_id: UUID,
        text: str,
        metadata: Optional[Dict[str, any]] = None
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
            
            # 广播系统消息
            await self.broadcast_to_room(
                room_id,
                {
                    "event": "systemMessage",
                    "data": message.to_dict()
                }
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
        message_id: int
    ):
        """通知被提及的用户"""
        await self.send_to_user(
            room_id,
            mentioned_user_id,
            {
                "event": "mentioned",
                "data": {
                    "room_id": str(room_id),
                    "mentioner_id": mentioner_id,
                    "mentioner_name": mentioner_name,
                    "message_text": message_text[:100] + "..." if len(message_text) > 100 else message_text,
                    "message_id": message_id,
                    "timestamp": datetime.utcnow().isoformat(),
                }
            }
        )