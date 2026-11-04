# syntax=docker/dockerfile:1
# CTranslate2 (faster-whisper) требует CUDA 12 + cuDNN 9; torch не нужен.

# ---------- web: сборка Web UI (Node есть только в этой стадии) ----------
FROM node:26-slim AS web
WORKDIR /web
# слой зависимостей кэшируется, пока не меняются package.json/package-lock.json
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
RUN npm run build

# ---------- builder: зависимости и пакет в /opt/venv ----------
FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04 AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3.12 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /bin/uv

ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_PYTHON=python3.12 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /app

# слой зависимостей кэшируется, пока не меняются pyproject.toml/uv.lock
COPY pyproject.toml uv.lock .python-version /app/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project

COPY src /app/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable

# ---------- runtime: только Python и готовое окружение ----------
FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04

# tzdata — база часовых поясов: без неё TZ из .env игнорируется и логи идут в UTC
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3.12 tzdata \
    && rm -rf /var/lib/apt/lists/*

# каталоги кэша и данных создаются от app, чтобы volume'ы hf-cache и gateway-data унаследовали владельца
RUN useradd -m app \
    && mkdir -p /home/app/.cache/huggingface /data \
    && chown -R app:app /home/app/.cache /data

COPY --from=builder /opt/venv /opt/venv
COPY models.yaml /app/models.yaml
COPY --from=web /web/dist /app/web

ENV PATH=/opt/venv/bin:$PATH \
    HF_HOME=/home/app/.cache/huggingface \
    PYTHONUNBUFFERED=1 \
    AIGW_WEB_DIR=/app/web \
    AIGW_DATA_DIR=/data

WORKDIR /app
USER app
EXPOSE 8000

# строго один воркер: каждый воркер загрузил бы свою копию модели в VRAM
CMD ["uvicorn", "ai_gateway.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
