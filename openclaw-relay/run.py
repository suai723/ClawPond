#!/usr/bin/env python3
"""
OpenClaw Relay MVP 运行脚本
"""
import asyncio
import sys
import os

# 添加src目录到Python路径
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

# 尝试导入必要的包
try:
    import uvicorn
    import fastapi
    print("✓ FastAPI 可用")
except ImportError as e:
    print(f"✗ 缺少依赖: {e}")
    print("请安装依赖: pip install fastapi uvicorn websockets")
    sys.exit(1)

def check_dependencies():
    """检查依赖"""
    dependencies = [
        ("structlog", "日志记录"),
        ("bcrypt", "密码加密"),
        ("pydantic", "数据验证"),
    ]
    
    missing = []
    for dep, desc in dependencies:
        try:
            __import__(dep)
            print(f"✓ {dep}: {desc}")
        except ImportError:
            missing.append((dep, desc))
    
    if missing:
        print("\n缺少依赖:")
        for dep, desc in missing:
            print(f"  - {dep}: {desc}")
        print("可以使用 'pip install structlog bcrypt pydantic' 安装")
    
    return len(missing) == 0

async def test_services():
    """测试服务功能"""
    from src.modules.room.service import RoomService
    from src.modules.message.service import MessageService
    from src.schemas.room import RoomCreate, RoomJoinRequest
    from src.schemas.message import MessageCreate
    import uuid
    
    print("\n=== 测试服务功能 ===")
    
    # 创建房间服务
    room_service = RoomService()
    
    # 创建房间
    print("1. 创建房间...")
    room_data = RoomCreate(
        name="test-room",
        password="test123",
        description="测试房间",
        max_members=10
    )
    
    try:
        room = await room_service.create_room(room_data, "user-001", "小王")
        print(f"   房间创建成功: {room.name} (ID: {room.id})")
    except Exception as e:
        print(f"   房间创建失败: {e}")
        return False
    
    # 加入房间
    print("2. 加入房间...")
    join_data = RoomJoinRequest(
        user_id="user-002",
        username="小李",
        password="test123"
    )
    
    try:
        member = await room_service.join_room(room.id, join_data)
        print(f"   加入房间成功: {member.username} (ID: {member.id})")
    except Exception as e:
        print(f"   加入房间失败: {e}")
        return False
    
    # 创建消息服务
    message_service = MessageService(room_service)
    
    # 发送消息
    print("3. 发送消息...")
    message_data = MessageCreate(
        room_id=room.id,
        sender_id="user-001",
        sender_name="小王",
        text="大家好，这是第一条消息！",
        mentions=["小李"]
    )
    
    try:
        message = await message_service.send_message(message_data)
        print(f"   消息发送成功: ID={message.message_id}, 内容={message.text[:30]}...")
    except Exception as e:
        print(f"   消息发送失败: {e}")
        return False
    
    # 获取消息
    print("4. 获取消息...")
    from src.schemas.message import MessageFilter
    
    filter_params = MessageFilter(room_id=room.id, limit=5)
    messages = await message_service.get_messages(filter_params)
    
    if messages:
        print(f"   获取到 {len(messages)} 条消息:")
        for msg in messages:
            print(f"     - {msg.sender_name}: {msg.text[:30]}...")
    else:
        print("   没有消息")
    
    # 获取房间成员
    print("5. 获取房间成员...")
    members = await room_service.get_members(room.id)
    print(f"   房间成员 ({len(members)} 人):")
    for member in members:
        print(f"     - {member.username} ({member.role})")
    
    return True

def main():
    """主函数"""
    print("=== OpenClaw Relay MVP 启动 ===")
    
    # 检查依赖
    if not check_dependencies():
        print("\n请先安装缺少的依赖")
        return
    
    # 测试服务
    print("\n")
    if asyncio.run(test_services()):
        print("\n✓ 所有服务测试通过！")
    else:
        print("\n✗ 服务测试失败")
        return
    
    # 启动服务器
    print("\n=== 启动服务器 ===")
    print("服务器将在 http://localhost:8000 启动")
    print("API文档: http://localhost:8000/docs")
    print("WebSocket端点: ws://localhost:8000/ws/{room_id}")
    print("\n按 Ctrl+C 停止服务器")
    
    try:
        uvicorn.run(
            "src.main:app",
            host="0.0.0.0",
            port=8000,
            reload=True,
            log_level="info"
        )
    except KeyboardInterrupt:
        print("\n服务器已停止")
    except Exception as e:
        print(f"\n服务器启动失败: {e}")

if __name__ == "__main__":
    main()