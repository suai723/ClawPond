from typing import List, Optional
from uuid import UUID
from fastapi import APIRouter, HTTPException, Query, status, Body
from fastapi.responses import JSONResponse, Response

from ...schemas.room import (
    RoomCreate, RoomCreateRequest, RoomUpdate, RoomResponse, RoomListResponse,
    RoomCreateResponse, RoomJoinRequest, RoomLeaveRequest, RoomMemberResponse,
    RoomPasswordRequest, RoomUpdateRequest, RoomMembersRequest,
)
from ...schemas.message import MessageCreate, MessageFilter
from .service import RoomService

router = APIRouter()

# 默认实例，可由 main.py 通过 setup_room_router 替换
room_service = RoomService()
message_service = None


def setup_room_router(service: RoomService):
    """注入共享的 RoomService 实例"""
    global room_service
    room_service = service


def setup_room_message_service(svc):
    """注入共享的 MessageService 实例（避免循环依赖）"""
    global message_service
    message_service = svc


def _room_response(room) -> RoomResponse:
    return RoomResponse(
        id=room.id,
        name=room.name,
        description=room.description,
        max_members=room.max_members,
        message_retention=room.message_retention,
        allow_anonymous=room.allow_anonymous,
        allow_media_upload=room.allow_media_upload,
        media_max_size=room.media_max_size,
        status=room.status,
        created_at=room.created_at,
        updated_at=room.updated_at,
        created_by=room.created_by,
        member_count=room.member_count,
        last_message_at=None,
    )


def _member_response(member) -> RoomMemberResponse:
    return RoomMemberResponse(
        id=member.id,
        user_id=member.user_id,
        username=member.username,
        user_type=member.user_type,
        role=member.role,
        status=member.status,
        joined_at=member.joined_at,
        last_active_at=member.last_active_at,
        a2a_endpoint=member.a2a_endpoint,
        agent_card_url=member.agent_card_url,
        agent_id=getattr(member, "agent_id", None),
    )


# ---------------------------------------------------------------------------
# 公开端点（无需密码）
# ---------------------------------------------------------------------------

@router.post("", response_model=RoomCreateResponse, status_code=status.HTTP_201_CREATED)
async def create_room(request: RoomCreateRequest):
    """创建新房间，服务端自动生成密码并一次性返回"""
    try:
        room_data = RoomCreate(**request.model_dump(exclude={"user_id", "username"}))
        room, plain_password = await room_service.create_room(
            room_data, request.user_id, request.username
        )
        return RoomCreateResponse(
            **_room_response(room).model_dump(),
            plain_password=plain_password,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.get("", response_model=RoomListResponse)
async def list_rooms(
    room_status: Optional[str] = Query(default="active", alias="status"),
    page: int = 1,
    page_size: int = 20,
):
    """获取房间列表"""
    import traceback
    try:
        rooms, total = await room_service.list_rooms(
            status=room_status,
            page=page,
            page_size=page_size,
        )
        return RoomListResponse(
            rooms=[_room_response(r) for r in rooms],
            total=total,
            page=page,
            page_size=page_size,
        )
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal server error: {type(e).__name__}: {e}")


@router.get("/messages")
async def get_messages_endpoint(
    password: str = Query(..., description="房间 access_token"),
    limit: int = Query(default=20, ge=1, le=100),
    start_message_id: Optional[int] = Query(default=None),
):
    """获取房间消息历史 — 通过 password（access_token）定位房间"""
    if message_service is None:
        raise HTTPException(status_code=500, detail="Message service not initialized")
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
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/messages", status_code=201)
async def create_message_endpoint(body: dict):
    """通过 HTTP 发送消息 — body 需包含 password（access_token）"""
    if message_service is None:
        raise HTTPException(status_code=500, detail="Message service not initialized")
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
        return message.to_dict()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{room_id}", response_model=RoomResponse)
async def get_room(room_id: UUID):
    """获取房间详情（公开信息，供列表展示用）"""
    room = await room_service.get_room(room_id)
    if not room:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
    return _room_response(room)


# ---------------------------------------------------------------------------
# 密码鉴权端点（所有操作通过 access_token 定位房间）
# ---------------------------------------------------------------------------

@router.post("/join", response_model=RoomMemberResponse)
async def join_room(join_data: RoomJoinRequest):
    """加入房间 — 通过 password（access_token）定位房间"""
    try:
        room = await room_service.get_room_by_password(join_data.password)
        if not room:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Room not found or invalid password",
            )
        if join_data.room_id and str(room.id) != join_data.room_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Password does not match the specified room",
            )
        member = await room_service.join_room(room.id, join_data)
        return _member_response(member)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.post("/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_room(leave_data: RoomLeaveRequest):
    """离开房间 — 通过 password（access_token）定位房间"""
    try:
        room = await room_service.get_room_by_password(leave_data.password)
        if not room:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Room not found or invalid password",
            )
        success = await room_service.leave_room(room.id, leave_data.user_id)
        if not success:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found in room")
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.put("", response_model=RoomResponse)
async def update_room(request: RoomUpdateRequest):
    """更新房间 — 通过 password（access_token）定位房间"""
    try:
        room = await room_service.get_room_by_password(request.password)
        if not room:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Room not found or invalid password",
            )
        updated = await room_service.update_room(room.id, request.update, request.user_id)
        if not updated:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
        return _room_response(updated)
    except HTTPException:
        raise
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
async def delete_room(request: RoomPasswordRequest):
    """删除房间 — 通过 password（access_token）定位房间"""
    try:
        room = await room_service.get_room_by_password(request.password)
        if not room:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Room not found or invalid password",
            )
        success = await room_service.delete_room(room.id, request.user_id)
        if not success:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except HTTPException:
        raise
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except Exception:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.post("/members", response_model=List[RoomMemberResponse])
async def get_room_members(request: RoomMembersRequest):
    """获取房间成员列表 — 通过 password（access_token）定位房间"""
    room = await room_service.get_room_by_password(request.password)
    if not room:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Room not found or invalid password",
        )
    members = await room_service.get_members(room.id)
    return [_member_response(m) for m in members]


@router.post("/validate", response_model=dict)
async def validate_room_access(password: str = Body(..., embed=True)):
    """验证房间密码是否有效"""
    room = await room_service.get_room_by_password(password)
    return {"valid": room is not None, "room_id": str(room.id) if room else None}
