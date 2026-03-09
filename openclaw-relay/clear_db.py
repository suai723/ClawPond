#!/usr/bin/env python3
"""
清空数据库脚本

清除所有业务数据（保留表结构），可选择是否保留用户和 Agent 账号。

用法:
    python clear_db.py              # 清空所有业务数据（保留用户和 Agent）
    python clear_db.py --all        # 清空全部数据（包括用户和 Agent）
    python clear_db.py --dry-run    # 只显示将要删除的记录数，不实际删除
"""
import asyncio
import argparse
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from sqlalchemy import text
from src.core.database import db_manager


# 表清理顺序（先清子表，再清父表，避免外键约束错误）
# messages 和 room_members 引用 rooms，所以先删它们
BUSINESS_TABLES = [
    "messages",
    "room_members",
    "rooms",
]

ACCOUNT_TABLES = [
    "users",
    "agents",
]


async def get_row_counts(session, tables: list[str]) -> dict[str, int]:
    """查询各表的行数"""
    counts = {}
    for table in tables:
        result = await session.execute(text(f"SELECT COUNT(*) FROM {table}"))
        counts[table] = result.scalar()
    return counts


async def truncate_tables(session, tables: list[str]) -> None:
    """使用 TRUNCATE 清空指定表（CASCADE 处理外键）"""
    if not tables:
        return
    table_list = ", ".join(tables)
    await session.execute(text(f"TRUNCATE TABLE {table_list} RESTART IDENTITY CASCADE"))


async def main(clear_all: bool = False, dry_run: bool = False) -> None:
    await db_manager.init()

    tables_to_clear = BUSINESS_TABLES + (ACCOUNT_TABLES if clear_all else [])

    async with db_manager.get_session() as session:
        print("=" * 50)
        print("当前各表数据量：")
        all_tables = BUSINESS_TABLES + ACCOUNT_TABLES
        counts = await get_row_counts(session, all_tables)
        for table, count in counts.items():
            marker = "  [将清空]" if table in tables_to_clear else "  [保留]"
            print(f"  {table:<20} {count:>8} 条{marker}")
        print("=" * 50)

        if dry_run:
            print("[dry-run] 未做任何修改。")
            return

        total = sum(counts[t] for t in tables_to_clear)
        if total == 0:
            print("所有目标表均为空，无需清理。")
            return

        scope = "全部数据（含用户和 Agent）" if clear_all else "业务数据（保留用户和 Agent）"
        confirm = input(f"\n即将清空 {scope}，共 {total} 条记录。确认？[y/N] ").strip().lower()
        if confirm != "y":
            print("已取消。")
            return

        # TRUNCATE 在同一事务内执行，db_manager.get_session() 会自动 commit
        # 由于 TRUNCATE 是 DDL，部分数据库驱动不能在同一事务内 commit，
        # 这里用 AUTOCOMMIT 连接直接执行更安全。
        await session.execute(text("COMMIT"))  # 结束当前事务块
        for table in tables_to_clear:
            await session.execute(text(f"TRUNCATE TABLE {table} RESTART IDENTITY CASCADE"))
            print(f"  已清空: {table}")

        print(f"\n清空完成，共删除 {total} 条记录。")

    await db_manager.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="清空数据库数据")
    parser.add_argument(
        "--all",
        action="store_true",
        help="同时清空用户(users)和 Agent(agents)表，默认仅清空业务数据",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="只显示行数统计，不实际删除",
    )
    args = parser.parse_args()

    asyncio.run(main(clear_all=args.all, dry_run=args.dry_run))
