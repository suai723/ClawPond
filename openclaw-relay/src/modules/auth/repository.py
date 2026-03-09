from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from ...models.user import UserModel


class UserRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def get_by_username(self, username: str) -> UserModel | None:
        result = await self.session.execute(
            select(UserModel).where(UserModel.username == username)
        )
        return result.scalar_one_or_none()

    async def get_by_user_id(self, user_id: str) -> UserModel | None:
        result = await self.session.execute(
            select(UserModel).where(UserModel.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def create(self, user_id: str, username: str, password_hash: str) -> UserModel:
        user = UserModel(
            user_id=user_id,
            username=username,
            password_hash=password_hash,
        )
        self.session.add(user)
        await self.session.flush()
        return user
