from typing import List, Optional
from uuid import UUID
from fastapi import APIRouter, HTTPException, Query, status, Body
from fastapi.responses import JSONResponse, Response

from ...schemas.room import (
    RoomCreate, RoomCreateRequest, RoomUpdate, RoomResponse, RoomListResponse,
    RoomJoinRequest, RoomLeaveRequest, RoomMemberResponse
)
from .service import RoomService

router = APIRouter()

# 默认实例，可由 main.py 通过 setup_room_router 替换
room_service = RoomService()


def setup_room_router(service: RoomService):
    """注入共享的 RoomService 实例"""
    global room_service
    room_service = service


@router.post("", response_model=RoomResponse, status_code=status.HTTP_201_CREATED)
async def create_room(request: RoomCreateRequest):
    """
    创建新房间
    """
    try:
        room_data = RoomCreate(**request.model_dump(exclude={"user_id", "username"}))
        room = await room_service.create_room(room_data, request.user_id, request.username)
        
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
            last_message_at=None
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.get("", response_model=RoomListResponse)
async def list_rooms(
    room_status: Optional[str] = Query(default="active", alias="status"),
    page: int = 1,
    page_size: int = 20
):
    """
    获取房间列表
    """
    try:
        rooms, total = await room_service.list_rooms(
            status=room_status,
            page=page,
            page_size=page_size
        )
        
        room_responses = []
        for room in rooms:
            room_responses.append(RoomResponse(
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
                last_message_at=None
            ))
        
        return RoomListResponse(
            rooms=room_responses,
            total=total,
            page=page,
            page_size=page_size
        )
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.get("/{room_id}", response_model=RoomResponse)
async def get_room(room_id: UUID):
    """
    获取房间详情
    """
    room = await room_service.get_room(room_id)
    if not room:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
    
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
        last_message_at=None
    )


@router.put("/{room_id}", response_model=RoomResponse)
async def update_room(
    room_id: UUID,
    room_data: RoomUpdate,
    user_id: str = Body(...)
):
    """
    更新房间信息
    """
    try:
        room = await room_service.update_room(room_id, room_data, user_id)
        if not room:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
        
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
            last_message_at=None
        )
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.delete("/{room_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_room(
    room_id: UUID,
    user_id: str = Body(...)
):
    """
    删除房间
    """
    try:
        success = await room_service.delete_room(room_id, user_id)
        if not success:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found")
        
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.post("/{room_id}/join", response_model=RoomMemberResponse)
async def join_room(
    room_id: UUID,
    join_data: RoomJoinRequest
):
    """
    加入房间
    """
    try:
        member = await room_service.join_room(room_id, join_data)
        
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
            agent_card_url=member.agent_card_url
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.post("/{room_id}/leave", status_code=status.HTTP_204_NO_CONTENT)
async def leave_room(
    room_id: UUID,
    leave_data: RoomLeaveRequest
):
    """
    离开房间
    """
    try:
        success = await room_service.leave_room(room_id, leave_data.user_id)
        if not success:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found in room")
        
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.get("/{room_id}/members", response_model=List[RoomMemberResponse])
async def get_room_members(room_id: UUID):
    """
    获取房间成员列表
    """
    members = await room_service.get_members(room_id)
    
    return [
        RoomMemberResponse(
            id=member.id,
            user_id=member.user_id,
            username=member.username,
            user_type=member.user_type,
            role=member.role,
            status=member.status,
            joined_at=member.joined_at,
            last_active_at=member.last_active_at,
            a2a_endpoint=member.a2a_endpoint,
            agent_card_url=member.agent_card_url
        )
        for member in members
    ]


@router.get("/{room_id}/members/{user_id}", response_model=RoomMemberResponse)
async def get_room_member(room_id: UUID, user_id: str):
    """
    获取特定房间成员
    """
    member = await room_service.get_member(room_id, user_id)
    if not member:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Member not found")
    
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
        agent_card_url=member.agent_card_url
    )


@router.post("/{room_id}/validate", response_model=dict)
async def validate_room_access(
    room_id: UUID,
    password: str = Body(..., embed=True)
):
    """
    验证房间访问权限
    """
    valid = await room_service.validate_access(room_id, password)
    return {"valid": valid}