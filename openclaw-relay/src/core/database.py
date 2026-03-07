from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import MetaData
from contextlib import asynccontextmanager

from .config import get_settings

settings = get_settings()


class Base(DeclarativeBase):
    """SQLAlchemy基类"""
    metadata = MetaData()


class DatabaseManager:
    """数据库管理器"""
    
    def __init__(self):
        self.engine = None
        self.session_factory = None
    
    async def init(self):
        """初始化数据库连接"""
        if self.engine is None:
            self.engine = create_async_engine(
                settings.database_url,
                echo=settings.debug,
                pool_pre_ping=True,
                pool_size=20,
                max_overflow=30,
                pool_timeout=30,
            )
            self.session_factory = async_sessionmaker(
                self.engine,
                class_=AsyncSession,
                expire_on_commit=False,
            )
    
    async def close(self):
        """关闭数据库连接"""
        if self.engine:
            await self.engine.dispose()
            self.engine = None
            self.session_factory = None
    
    @asynccontextmanager
    async def get_session(self) -> AsyncGenerator[AsyncSession, None]:
        """获取数据库会话"""
        if self.session_factory is None:
            await self.init()
        
        async with self.session_factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise
            finally:
                await session.close()


# 全局数据库管理器实例
db_manager = DatabaseManager()


async def init_db():
    """初始化数据库"""
    await db_manager.init()


async def close_db():
    """关闭数据库"""
    await db_manager.close()


def get_db() -> AsyncGenerator[AsyncSession, None]:
    """依赖注入获取数据库会话"""
    return db_manager.get_session()