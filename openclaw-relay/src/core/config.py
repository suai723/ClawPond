from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # 应用配置
    app_name: str = "OpenClaw Relay"
    app_version: str = "0.1.0"
    debug: bool = False
    
    # 服务器配置
    host: str = "0.0.0.0"
    port: int = 8000
    
    # 数据库配置
    database_url: str = "postgresql+asyncpg://relay:password@localhost:5432/relay"
    
    # Redis配置
    redis_url: str = "redis://localhost:6379/0"
    
    # A2A配置
    a2a_enabled: bool = True
    a2a_port: int = 9000
    a2a_heartbeat_interval: int = 30
    
    # WebSocket配置
    ws_heartbeat_interval: int = 30
    ws_max_connections: int = 1000
    
    # 安全配置
    jwt_secret: str
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60
    
    # 房间配置
    room_max_members: int = 50
    room_message_retention_days: int = 7
    
    # Agent配置
    agent_max_concurrent_calls: int = 5
    agent_call_timeout: int = 30
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    return Settings()