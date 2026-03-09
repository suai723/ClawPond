import os
import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import engine_from_config, pool
from alembic import context

# 将项目根目录加入 sys.path，使 src 包可被导入
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.core.database import Base
from src.models import RoomModel, RoomMemberModel, MessageModel, UserModel  # noqa: F401 确保模型被注册

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

# 从环境变量读取数据库URL（将 asyncpg 替换为 psycopg2/同步驱动供 alembic 使用）
def get_sync_url() -> str:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    url = os.environ.get(
        "DATABASE_URL",
        "postgresql+asyncpg://admin:123456@192.168.31.106:6432/relay"
    )
    # alembic 需要同步驱动，将 asyncpg 替换为 psycopg2
    return url.replace("postgresql+asyncpg://", "postgresql+psycopg2://")


def run_migrations_offline() -> None:
    url = get_sync_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = get_sync_url()

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
