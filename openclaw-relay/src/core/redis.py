import redis.asyncio as redis
from typing import Optional
import structlog

from .config import get_settings

logger = structlog.get_logger()
settings = get_settings()


class RedisManager:
    """Redis管理器"""
    
    def __init__(self):
        self.client: Optional[redis.Redis] = None
    
    async def init(self):
        """初始化Redis连接"""
        if self.client is None:
            self.client = redis.from_url(
                settings.redis_url,
                encoding="utf-8",
                decode_responses=True,
                max_connections=20,
            )
            logger.info("redis_connected")
    
    async def close(self):
        """关闭Redis连接"""
        if self.client:
            await self.client.aclose()
            self.client = None
            logger.info("redis_disconnected")
    
    async def get_client(self) -> redis.Redis:
        """获取Redis客户端"""
        if self.client is None:
            await self.init()
        return self.client
    
    async def ping(self) -> bool:
        """测试Redis连接"""
        try:
            client = await self.get_client()
            return await client.ping()
        except Exception as e:
            logger.error("redis_ping_failed", error=str(e))
            return False


# 全局Redis管理器实例
redis_manager = RedisManager()


async def init_redis():
    """初始化Redis"""
    await redis_manager.init()


async def close_redis():
    """关闭Redis"""
    await redis_manager.close()


async def get_redis() -> redis.Redis:
    """依赖注入获取Redis客户端"""
    return await redis_manager.get_client()