import uuid
from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from .repository import UserRepository
from ...core.security import hash_password, verify_password, create_access_token
from ...schemas.auth import RegisterRequest, LoginRequest, TokenResponse


class AuthService:
    async def register(self, request: RegisterRequest, session: AsyncSession) -> TokenResponse:
        repo = UserRepository(session)

        existing = await repo.get_by_username(request.username)
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="用户名已存在",
            )

        user_id = f"user-{uuid.uuid4().hex[:12]}"
        password_hash = hash_password(request.password)

        user = await repo.create(
            user_id=user_id,
            username=request.username,
            password_hash=password_hash,
        )

        token = create_access_token(user.user_id, user.username)
        return TokenResponse(
            access_token=token,
            user_id=user.user_id,
            username=user.username,
        )

    async def login(self, request: LoginRequest, session: AsyncSession) -> TokenResponse:
        repo = UserRepository(session)

        user = await repo.get_by_username(request.username)
        if not user or not verify_password(request.password, user.password_hash):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="用户名或密码错误",
            )

        token = create_access_token(user.user_id, user.username)
        return TokenResponse(
            access_token=token,
            user_id=user.user_id,
            username=user.username,
        )

    async def get_current_user(self, user_id: str, session: AsyncSession) -> dict:
        repo = UserRepository(session)
        user = await repo.get_by_user_id(user_id)
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="用户不存在",
            )
        return {
            "user_id": user.user_id,
            "username": user.username,
            "created_at": user.created_at.isoformat(),
        }
