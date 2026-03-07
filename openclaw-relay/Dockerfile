FROM python:3.11-slim

WORKDIR /app

# 安装系统依赖（gcc 用于编译某些 Python 包，curl 用于健康检查）
RUN apt-get update && apt-get install -y \
    gcc \
    curl \
    && rm -rf /var/lib/apt/lists/*

# 先复制依赖文件，利用 Docker 层缓存
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 复制项目文件
COPY pyproject.toml alembic.ini README.md ./
COPY alembic/ ./alembic/
COPY src/ ./src/

# 创建非 root 用户
RUN useradd -m -u 1000 openclaw && chown -R openclaw:openclaw /app
USER openclaw

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000"]
