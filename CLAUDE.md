# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Статус проекта

`ai_gateway` — локальный роутер моделей с **OpenAI-совместимым API**. Сейчас идёт **этап 1**
(шлюз + Whisper); код ещё пишется по спецификации
`docs/superpowers/specs/2026-11-04-ai-gateway-stage1-design.md` — она источник истины по API,
форматам ответов, кодам ошибок и тестам. Если код расходится со спецификацией — сначала уточнить
у пользователя, а не молча менять одно под другое.

Roadmap (решения по будущим этапам — `docs/roadmap.md`): этап 2 — бэкенд Ollama +
`/v1/chat/completions` (SSE); этап 3 — Web UI на React (распознавание файлов/видео/микрофона + чат);
этап 4 — фоновые задачи для длинного аудио. Не реализовывать функциональность следующих этапов без запроса.

Документация, комментарии и сообщения коммитов — на русском.

## Документация

- `docs/` **не в git** (в `.gitignore`), хранится только локально — не коммитить и не ссылаться
  на него в коде/README как на часть репозитория.
- Спеки итераций: `docs/superpowers/specs/`, планы: `docs/superpowers/plans/`.
  Прогресс отмечается чекбоксами в плане: выполненный шаг — `- [x]`.

## Окружения

- **Разработка:** macOS без GPU — сервис запускается вне Docker на CPU
  (`AIGW_DEVICE=cpu`, `AIGW_MODELS_FILE=models.dev.yaml` с моделями `tiny`/`base`).
- **Продакшн:** Windows + NVIDIA, Docker Desktop (WSL2), 16 ГБ VRAM, которые шлюз делит с Ollama.
  Отсюда `.gitattributes` с `eol=lf` — не ломать.

## Команды

Стек: Python 3.12 (`.python-version`, uv ставит его сам), uv, FastAPI, faster-whisper, loguru, pytest.
Зависимости — только через `uv add` / `uv add --dev`; `uv.lock` коммитится.

```bash
uv sync
uv run uvicorn ai_gateway.main:app --reload              # локальный запуск (CPU)
uv run pytest                                            # юнит- и API-тесты (без моделей и GPU)
uv run pytest tests/test_lifecycle.py::test_name         # один тест
uv run pytest -m integration                             # реальный whisper `tiny` на CPU + OpenAI SDK
uv run ruff check . && uv run ruff format .
uv run mypy                                              # strict, конфиг в pyproject.toml
docker compose up --build                                # на целевой машине с GPU
```

## Архитектура

Путь запроса: `api/*` → `ModelRegistry.resolve()` (имя/алиас → `ModelSpec`, например
`whisper-1` → модель по умолчанию) → `ModelManager.acquire()` → бэкенд → `formatting.render()`.

- **`backends/`** — бэкенды реализуют протоколы из `backends/base.py`
  (`load`/`unload` + `transcribe`). Новый тип модели = новый класс + запись в `build_backend()`
  (`backends/__init__.py`) + расширение `ModelSpec.backend` + записи в `models.yaml`; существующий код при этом не меняется.
- **`lifecycle.py` / `ModelManager`** — единственное место, которое управляет VRAM:
  ленивая загрузка под per-model lock, `asyncio.Semaphore(max_concurrency)` на модель,
  фоновая выгрузка по TTL (`-1` — никогда, `0` — сразу после запроса). Счётчик `active`
  увеличивается до ожидания семафора, чтобы sweep не выгрузил модель из-под очереди.
  Часы инжектируются (`clock`) — тесты используют `FakeClock`, а не `sleep`.
- Блокирующие вызовы (`load`, `transcribe`) идут через `asyncio.to_thread` — event loop
  не блокировать.
- **Ollama (этап 2)** — отдельный контейнер; её памятью управляет её `keep_alive`, шлюз
  не пытается учитывать VRAM между процессами.
- **`errors.py`** — все ошибки отдаются в формате OpenAI `{"error": {message, type, param, code}}`
  через `GatewayError`; OOM/ошибка загрузки модели → 503 `model_unavailable` + `Retry-After`.
- Конфигурация: env с префиксом `AIGW_` (`config.py`, pydantic-settings) + реестр моделей
  `models.yaml`, который валидируется при старте.

## Стиль

- Python: type hints везде, `mypy --strict` для всех модулей `src/`, без `Any` без причины
  (если нужен — комментарий почему). Библиотеки без стабов (`faster_whisper`, `ctranslate2`, `av`)
  изолированы в `backends/` — типизированные обёртки, наружу их типы не протекают.
- TypeScript (будущий UI): `strict` в `tsconfig`, без `any` без причины.

## Важные ограничения

- uvicorn запускается **строго с одним воркером** — каждый воркер грузил бы свою копию модели в VRAM.
- Docker-образ основан на `nvidia/cuda:12.x-cudnn-runtime-ubuntu24.04`: CTranslate2 требует
  CUDA 12 + cuDNN 9. torch в зависимостях не нужен.
- Совместимость с OpenAI SDK — ключевое требование: интеграционный тест ходит через `AsyncOpenAI`.
