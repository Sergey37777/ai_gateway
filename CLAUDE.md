# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Статус проекта

`ai_gateway` — локальный роутер моделей с **OpenAI-совместимым API**. Этапы 1 (шлюз + Whisper),
2 (Ollama + `/v1/chat/completions`) и 3 (Web UI на React в `web/`) готовы; пословные таймкоды в UI
(3.1) и **этап 4** — фоновые задачи и история распознаваний в PostgreSQL. Спецификации —
`docs/superpowers/specs/2026-11-04-ai-gateway-stage{1,2,3,4}-design.md` и
`…-word-timestamps-design.md`; они источник истины по API, форматам ответов, кодам ошибок и тестам.
Если код расходится со спецификацией — сначала уточнить у пользователя, а не молча менять одно
под другое.

Roadmap (решения по будущим этапам — `docs/roadmap.md`): этап 5 — диалоги чата в истории;
дальше — разметка спикеров. Не реализовывать функциональность следующих этапов без запроса.

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
uv run pytest -m postgres                                # хранилище/миграции на PostgreSQL (testcontainers)
uv run pytest -m integration                             # реальный whisper `tiny` на CPU + PostgreSQL + OpenAI SDK
docker compose -f compose.dev.yaml up -d                 # dev-PostgreSQL 17 на 127.0.0.1:55432 (для uvicorn и e2e)
uv run ruff check . && uv run ruff format .
uv run mypy                                              # strict, конфиг в pyproject.toml
docker compose up --build                                # на целевой машине с GPU
```

Web UI (`web/`, Node 26+, npm; зависимости — только `npm install` в `web/`, `package-lock.json` коммитится):

```bash
cd web && npm ci
npm run dev                  # Vite на :5173, /v1 /api /health /ui проксируются на шлюз :8000
npm test                     # Vitest + Testing Library (jsdom), без сети
npx vitest run src/chat      # часть тестов
npm run lint                 # oxlint --type-aware + prettier --check
npm run typecheck            # tsc -b (TypeScript 7)
npm run test:e2e             # Playwright: сборка + реальный шлюз на :8765 (CPU, лимит 1 МиБ, БД aigw_e2e в dev-PostgreSQL)
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
- **Ollama (этап 2)** — отдельный процесс: в продакшне нативно на Windows-хосте (шлюз из контейнера
  ходит на `host.docker.internal:11434`), на Mac — контейнер `ollama-dev`; её памятью управляет её
  `keep_alive`, шлюз не пытается учитывать VRAM между процессами.
- **Этап 4 — задачи и история:** `jobs.py` (`TranscriptionService.execute()` — единый исполнитель:
  фоновые задачи берёт `Worker` по одной FIFO, синхронный `/v1/audio/transcriptions` идёт сразу через
  `run_sync` под `asyncio.shield`), `store.py` (протокол `TranscriptionStore` + SQLAlchemy 2.0 async /
  psycopg 3; в тестах — `InMemoryTranscriptionStore`), `db/` (ORM, движок, миграции Alembic внутри
  пакета — применяются при старте), `files.py` (`AIGW_DATA_DIR`: `uploads/`, `audio/`),
  `backends/opus.py` (Opus/WebM для плеера). **Прогресс и флаг отмены — в памяти процесса**
  (`RunState`), не в БД. Бэкенд распознавания получает `TranscriptionHooks` (ход и остановка между
  сегментами). Собственный API — `/api/transcriptions…`, не `/v1/`.
- **`errors.py`** — все ошибки отдаются в формате OpenAI `{"error": {message, type, param, code}}`
  через `GatewayError`; OOM/ошибка загрузки модели → 503 `model_unavailable` + `Retry-After`.
- Конфигурация: env с префиксом `AIGW_` (`config.py`, pydantic-settings) + реестр моделей
  `models.yaml`, который валидируется при старте.
- **Web UI** — SPA из `web/dist` (`AIGW_WEB_DIR`), монтируется в `web.py` на `/` **после** всех
  роутеров; нет каталога — UI не раздаётся. UI берёт лимит, модели и языки из `GET /ui/config`
  (без авторизации), распознаёт через XHR (ради прогресса загрузки), чатится через npm `openai`.
  Видео больше `AIGW_MAX_UPLOAD_MB` браузер режет сам (ffmpeg.wasm, WORKERFS, `-c copy` → `.mka`).
  Логика UI — в чистых модулях (`plan`, `exports`, `state`, `request`…), компоненты только связывают
  её с DOM; API в компонентах подменяется через проп `deps`.

## Стиль

- Python: type hints везде, `mypy --strict` для всех модулей `src/`, без `Any` без причины
  (если нужен — комментарий почему). Библиотеки без стабов (`faster_whisper`, `ctranslate2`, `av`)
  изолированы в `backends/` — типизированные обёртки, наружу их типы не протекают.
- TypeScript (UI): `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`, без `any`;
  JSON разбирается через type guard (`api/json.ts`), а не `as`. Линтер — oxlint с type-aware
  правилами (typescript-eslint не поддерживает TS 7).
- UI по LAN открывается по `http` (не secure context): без `crypto.randomUUID`, `navigator.clipboard`
  только с fallback, микрофон — только на `localhost`/`https`.

## Важные ограничения

- uvicorn запускается **строго с одним воркером** — каждый воркер грузил бы свою копию модели в VRAM
  (и воркер очереди, прогресс задач живут в этом же процессе).
- PostgreSQL на Mac — только в контейнере (`postgres:17-alpine`, уже скачан); перед скачиванием
  новых Docker-образов проверять `docker images`.
- Docker-образ основан на `nvidia/cuda:12.x-cudnn-runtime-ubuntu24.04`: CTranslate2 требует
  CUDA 12 + cuDNN 9. torch в зависимостях не нужен.
- Совместимость с OpenAI SDK — ключевое требование: интеграционный тест ходит через `AsyncOpenAI`.
