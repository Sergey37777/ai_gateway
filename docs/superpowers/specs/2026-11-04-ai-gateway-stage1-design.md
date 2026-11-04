# ai_gateway — Этап 1: шлюз + Whisper

**Дата:** 2026-11-04
**Статус:** спецификация на ревью

## 1. Цель и контекст

`ai_gateway` — локальный роутер моделей с OpenAI-совместимым HTTP API. Один сервис
принимает запросы и направляет их нужному бэкенду по имени модели.

**Что сказал пользователь:**
- Нужен роутер различных моделей; первая модель — Whisper от OpenAI (распознавание речи).
- Позже — модели из Ollama.
- Развёртывание на своей машине в Docker; GPU с 16 ГБ VRAM.
- Целевая машина: **Windows + NVIDIA** (Docker Desktop, WSL2-бэкенд).
- API — **OpenAI-совместимый**.
- VRAM — **загрузка моделей по требованию + выгрузка по TTL простоя**.
- Аудио бывает и короткое, и длинное: сначала синхронный эндпоинт, фоновые задачи — отдельным этапом.
- Стек: **Python + FastAPI** (подтверждено).

**Допущения:**
- Сервис для одного пользователя / локальной сети; простая опциональная авторизация по Bearer-ключу.
- Разработка ведётся на macOS без GPU; там сервис работает на CPU вне Docker.

**Критерии успеха этапа 1:**
1. `docker compose up` на Windows-машине поднимает шлюз, контейнер видит GPU.
2. Официальный OpenAI SDK (`base_url=http://<host>:8000/v1`) успешно вызывает
   `client.audio.transcriptions.create(model="whisper-1", file=...)` и получает текст.
3. Модель выгружается из VRAM после TTL простоя (видно в логах и `nvidia-smi`).
4. Все юнит- и API-тесты проходят на Mac без GPU; интеграционный тест проходит на CPU с моделью `tiny`.

## 2. Этапы (roadmap)

| Этап | Содержание | В этой спецификации |
|---|---|---|
| 1 | Каркас шлюза, Whisper, `POST /v1/audio/transcriptions`, `GET /v1/models`, `GET /health`, Docker с GPU | **да, детально** |
| 2 | Бэкенд Ollama, `POST /v1/chat/completions` (+ streaming SSE), сервис `ollama` в compose | только интерфейсы |
| 3 | Фоновые задачи для длинного аудио (`POST /v1/jobs/transcriptions` + статус) | нет |

Интерфейсы этапа 1 (протоколы бэкендов, реестр моделей, `ModelManager`) проектируются так,
чтобы этап 2 добавлялся без изменения существующего кода, кроме регистрации нового бэкенда и роутера.

## 3. Архитектура

Выбран подход **A**: собственный FastAPI-шлюз; Whisper работает в процессе шлюза
(faster-whisper); Ollama (этап 2) — отдельный контейнер, шлюз ходит к ней по HTTP.

```
клиент ──► ai_gateway (FastAPI, GPU) ──┬─► WhisperBackend (faster-whisper, в процессе)
          /v1/audio/transcriptions     └─► OllamaBackend ──HTTP──► ollama (этап 2)
          /v1/models, /health
```

Отклонённые альтернативы:
- **B** — тонкий шлюз + готовый Whisper-сервер (speaches): зависимость от стороннего проекта,
  сложнее управлять параметрами и VRAM.
- **C** — LiteLLM Proxy: тяжёлая зависимость, неудобно встраивать свою логику VRAM и задач.

### 3.1. Структура проекта

```
ai_gateway/
├── pyproject.toml            # uv (PEP 621 + dependency-groups), сборка uv_build
├── uv.lock
├── .python-version           # 3.12
├── Dockerfile
├── docker-compose.yml
├── models.yaml               # реестр моделей (GPU)
├── models.dev.yaml           # реестр для разработки на CPU
├── .env.example
├── .gitattributes            # eol=lf (клонирование на Windows)
├── CLAUDE.md
├── README.md
├── src/ai_gateway/
│   ├── main.py               # create_app(), lifespan, middleware
│   ├── config.py             # Settings (pydantic-settings), загрузка models.yaml
│   ├── registry.py           # ModelRegistry: имя/алиас → ModelSpec
│   ├── lifecycle.py          # ModelManager: загрузка, TTL, блокировки, семафоры
│   ├── errors.py             # GatewayError + обработчики в формате OpenAI
│   ├── formatting.py         # json / text / verbose_json / srt / vtt
│   ├── backends/
│   │   ├── base.py           # протоколы бэкендов, типы результата
│   │   └── whisper.py        # WhisperBackend
│   └── api/
│       ├── deps.py           # зависимости FastAPI (manager, registry, auth)
│       ├── audio.py          # POST /v1/audio/transcriptions
│       ├── models.py         # GET /v1/models
│       └── health.py         # GET /health
└── tests/
    ├── fixtures/             # короткий wav-сэмпл с речью
    ├── fakes.py              # FakeTranscriptionBackend, FakeClock
    ├── test_lifecycle.py
    ├── test_formatting.py
    ├── test_registry.py
    ├── test_api_audio.py
    ├── test_api_misc.py
    └── test_integration_whisper.py   # маркер integration
```

Python **3.12** (а не 3.13 как в `simple_ai_agent`) — самые надёжные готовые колёса CUDA-стека
(ctranslate2 и пр.); в Ubuntu 24.04 он системный. Менеджер пакетов — **uv**: на Mac он сам ставит
Python 3.12 по `.python-version`, в Docker использует системный.

### 3.2. Поток запроса

1. Клиент: `POST /v1/audio/transcriptions` (multipart: `file`, `model`, …).
2. Проверка API-ключа (если `AIGW_API_KEY` задан).
3. `ModelRegistry.resolve(model)` → `ModelSpec` (алиасы разворачиваются; неизвестное имя → 404).
4. Файл потоково пишется во временный файл с проверкой лимита размера (→ 413).
5. `async with manager.acquire(spec.name) as backend:` — загрузка при необходимости, семафор.
6. `await asyncio.to_thread(backend.transcribe, path, options)` — инференс вне event loop.
7. `formatting.render(result, response_format)` → ответ в формате OpenAI.
8. Временный файл удаляется в `finally`.

## 4. Компоненты

### 4.1. Протоколы бэкендов (`backends/base.py`)

```python
class LoadableBackend(Protocol):
    def load(self) -> None: ...      # блокирующая загрузка весов на устройство
    def unload(self) -> None: ...    # освобождение памяти

class TranscriptionBackend(LoadableBackend, Protocol):
    def transcribe(self, audio_path: Path, options: TranscriptionOptions) -> TranscriptionResult: ...
```

- `TranscriptionOptions`: `language: str | None`, `prompt: str | None`, `temperature: float`,
  `word_timestamps: bool`, `vad_filter: bool`.
- `TranscriptionResult`: `text`, `language`, `duration` (сек), `segments: list[Segment]`,
  `words: list[Word] | None`.
- `Segment`: `id, start, end, text, avg_logprob, compression_ratio, no_speech_prob, temperature`.
- `Word`: `word, start, end`.

Этап 2 добавит `ChatBackend` (асинхронный, без `load/unload` на стороне шлюза — памятью
управляет Ollama через `keep_alive`).

### 4.2. WhisperBackend (`backends/whisper.py`)

- Обёртка над `faster_whisper.WhisperModel(model, device, compute_type, download_root?)`.
- Веса скачиваются с Hugging Face при первой загрузке; кэш — volume `hf-cache`.
- `transcribe` вызывает `model.transcribe(...)`, полностью материализует генератор сегментов
  и собирает `TranscriptionResult`. `vad_filter` берётся из конфигурации модели (по умолчанию `true`).
- Декодирование аудио — PyAV внутри faster-whisper (mp3, wav, m4a, ogg, webm, flac);
  системный ffmpeg не нужен. Ошибка декодирования → `GatewayError(400, "invalid_audio")`.
- `unload`: `del self._model`, `self._model = None`, `gc.collect()`.
- Определение устройства: `AIGW_DEVICE=auto` → `cuda`, если `ctranslate2.get_cuda_device_count() > 0`,
  иначе `cpu`. `AIGW_COMPUTE_TYPE=auto` → `float16` на `cuda`, `int8` на `cpu`.

### 4.3. ModelManager (`lifecycle.py`)

Состояние на модель (`_Slot`): `backend`, `loaded: bool`, `last_used: float`, `active: int`,
`load_lock: asyncio.Lock`, `semaphore: asyncio.Semaphore(max_concurrency)`.

- `acquire(name)` — `asynccontextmanager`:
  1. `active += 1` (сразу, чтобы выгрузка не тронула модель, ожидающую в очереди).
  2. Под `load_lock`: если не загружена — `await asyncio.to_thread(backend.load)`;
     ошибка загрузки (в т.ч. CUDA OOM) → `GatewayError(503, "model_unavailable")` с `Retry-After: 30`.
  3. `async with semaphore:` — `yield backend`.
  4. `finally`: `active -= 1`, `last_used = clock()`; если `ttl == 0` и `active == 0` — выгрузить.
- `sweep()` — выгружает модели с `loaded and active == 0 and ttl > 0 and clock() - last_used > ttl`.
  Выгрузка выполняется под `load_lock` модели.
- Фоновая задача (запускается/останавливается в lifespan) вызывает `sweep()` раз в
  `AIGW_SWEEP_INTERVAL` секунд (по умолчанию 30).
- `ttl == -1` — никогда не выгружать.
- `status()` — список `(name, loaded, active, idle_seconds)` для `/health`.
- `shutdown()` — выгрузить всё при остановке.
- Часы (`clock: Callable[[], float]`, по умолчанию `time.monotonic`) инжектируются для тестов.
- Межпроцессного учёта VRAM с Ollama нет: полагаемся на TTL и `keep_alive` Ollama.

### 4.4. Реестр моделей (`registry.py`, `models.yaml`)

```yaml
default_transcription: whisper-large-v3-turbo
aliases:
  whisper-1: whisper-large-v3-turbo
models:
  whisper-large-v3:
    backend: whisper
    model: large-v3
    ttl: 600
    max_concurrency: 1
    vad_filter: true
  whisper-large-v3-turbo:
    backend: whisper
    model: large-v3-turbo
    ttl: 600
```

- `ModelSpec` (pydantic): `name`, `backend: Literal["whisper"]` (этап 2 расширит до `"ollama"`),
  `model: str`, `ttl: int = default_ttl`, `max_concurrency: int = 1`, `vad_filter: bool = True`.
- Валидация при старте: алиасы и `default_transcription` ссылаются на существующие модели,
  `ttl >= -1`, `max_concurrency >= 1`. Ошибка конфигурации → сервис не стартует с понятным сообщением.
- Фабрика бэкендов: `backend` → класс (`{"whisper": WhisperBackend}`).
- Если поле `model` в запросе пустое — используется `default_transcription`.

### 4.5. Конфигурация (`config.py`)

`Settings` (pydantic-settings, префикс `AIGW_`, читает `.env`):

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `AIGW_DEVICE` | `auto` | `auto` / `cuda` / `cpu` |
| `AIGW_COMPUTE_TYPE` | `auto` | `auto` / `float16` / `int8_float16` / `int8` / … |
| `AIGW_API_KEY` | — | если задан, требуется `Authorization: Bearer <key>` |
| `AIGW_MAX_UPLOAD_MB` | `200` | лимит размера файла |
| `AIGW_MODELS_FILE` | `models.yaml` | путь к реестру |
| `AIGW_DEFAULT_TTL` | `600` | TTL по умолчанию, сек |
| `AIGW_SWEEP_INTERVAL` | `30` | период проверки простоя, сек |
| `AIGW_LOG_LEVEL` | `INFO` | уровень логов loguru |

## 5. HTTP API

### 5.1. `POST /v1/audio/transcriptions`

multipart/form-data, поля как в OpenAI:

| Поле | Тип | Примечание |
|---|---|---|
| `file` | файл | обязательно |
| `model` | str | имя или алиас; пусто → `default_transcription` |
| `language` | str | ISO-639-1, опционально |
| `prompt` | str | опционально |
| `temperature` | float | по умолчанию 0 |
| `response_format` | str | `json` (по умолч.) / `text` / `verbose_json` / `srt` / `vtt` |
| `timestamp_granularities[]` | list[str] | `segment` / `word`; влияет только на `verbose_json` |

Ответы:
- `json` → `{"text": "..."}`
- `text` → `text/plain`
- `verbose_json` → `{"task": "transcribe", "language", "duration", "text", "segments": [...], "words": [...]?}`;
  `words` присутствует только при `word` в `timestamp_granularities[]` (тогда `word_timestamps=True`).
- `srt` / `vtt` → `text/plain` с субтитрами (формат времени `HH:MM:SS,mmm` / `HH:MM:SS.mmm`).

`language` в `verbose_json` — полное английское название языка, как у OpenAI (`"russian"`),
по таблице кодов Whisper.

### 5.2. `GET /v1/models`

`{"object": "list", "data": [{"id", "object": "model", "created": 0, "owned_by": "ai_gateway"}]}` —
все модели и алиасы из реестра.

### 5.3. `GET /health`

`{"status": "ok", "device": "cuda", "models": [{"name", "loaded", "active", "idle_seconds"}]}`.
Не требует авторизации.

## 6. Обработка ошибок

Единый `GatewayError(status, code, message, param=None, headers=None)`; обработчики FastAPI
превращают его, `RequestValidationError` и необработанные исключения в формат OpenAI:
`{"error": {"message", "type", "param", "code"}}`.

| Ситуация | HTTP | `type` | `code` |
|---|---|---|---|
| Неизвестная модель | 404 | `invalid_request_error` | `model_not_found` |
| Неверный параметр / валидация | 400 | `invalid_request_error` | `invalid_request_error` |
| Аудио не декодируется | 400 | `invalid_request_error` | `invalid_audio` |
| Файл больше лимита | 413 | `invalid_request_error` | `file_too_large` |
| Неверный/нет API-ключа | 401 | `authentication_error` | `invalid_api_key` |
| OOM / ошибка загрузки модели | 503 | `server_error` | `model_unavailable` (+ `Retry-After: 30`) |
| Прочее | 500 | `server_error` | `internal_error` (трейсбек только в лог) |

**Логирование (loguru):** middleware присваивает `request_id` (UUID4 или входящий `X-Request-ID`),
кладёт его в контекст логов и возвращает в заголовке `X-Request-ID`. Логируются: загрузка/выгрузка
моделей с длительностью; на каждое распознавание — модель, длительность аудио, время обработки.

## 7. Тестирование

pytest + pytest-asyncio + httpx (`ASGITransport`). Тесты 1–3 не требуют faster-whisper-моделей и GPU.

1. **`test_lifecycle.py`** (FakeTranscriptionBackend + FakeClock): ленивая загрузка; параллельные
   `acquire` загружают модель ровно один раз; выгрузка по TTL; `ttl=0` и `ttl=-1`; модель с активным
   запросом не выгружается; семафор ограничивает параллельность; ошибка `load` → 503 и слот
   остаётся незагруженным; `shutdown` выгружает всё.
2. **`test_formatting.py`**: `json`, `text`, `verbose_json` (с `words` и без), `srt`, `vtt`
   на фикстуре сегментов; округление и формат времени.
3. **`test_registry.py`**: алиасы, модель по умолчанию, ошибки валидации конфигурации.
4. **`test_api_audio.py` / `test_api_misc.py`** (фейковый бэкенд через переопределение зависимостей):
   все коды ошибок из раздела 6; авторизация вкл/выкл; алиас `whisper-1`; `X-Request-ID`;
   `/v1/models`; `/health`.
5. **`test_integration_whisper.py`** (маркер `integration`, по умолчанию пропускается,
   `pytest -m integration`): реальная модель `tiny` на CPU, короткий wav-сэмпл с речью из
   `tests/fixtures/`; вызов через официальный OpenAI SDK:
   `AsyncOpenAI(base_url="http://test/v1", api_key="x", http_client=httpx.AsyncClient(transport=ASGITransport(app)))`.
6. **Ручная проверка на GPU** (чек-лист в README): `nvidia-smi` в контейнере, curl-запрос,
   время ответа, выгрузка после TTL в логах.

## 8. Docker

### 8.1. `Dockerfile` (multi-stage)
- **builder:** тот же базовый CUDA-образ (одинаковые пути и ABI Python), бинарник uv копируется
  из `ghcr.io/astral-sh/uv:<точная версия>`; `uv sync --locked --no-dev --no-editable` ставит
  зависимости и сам пакет в `/opt/venv` (`UV_PROJECT_ENVIRONMENT`), используя системный Python
  (`UV_PYTHON_DOWNLOADS=never`).
- **runtime:** `nvidia/cuda:12.x-cudnn-runtime-ubuntu24.04` (CUDA 12 + cuDNN 9 для CTranslate2;
  точный тег проверяется при реализации), системный Python 3.12, копируется только `/opt/venv` (uv в рантайме не нужен).
- Непривилегированный пользователь `app`, `HF_HOME=/home/app/.cache/huggingface`.
- `CMD uvicorn ai_gateway.main:app --host 0.0.0.0 --port 8000 --workers 1` —
  **ровно один воркер**, иначе каждый загрузит свою копию модели в VRAM.

### 8.2. `docker-compose.yml`
- Сервис `gateway`: build `.`, порт `8000:8000`, `env_file: .env`,
  volume `hf-cache:/home/app/.cache/huggingface`, `./models.yaml:/app/models.yaml:ro`,
  GPU через `deploy.resources.reservations.devices` (`driver: nvidia`, `count: all`, `capabilities: [gpu]`),
  healthcheck на `/health`, `restart: unless-stopped`.
- Этап 2 добавит сервис `ollama` (`ollama/ollama`, тот же GPU, volume `ollama-models`).

### 8.3. Windows
- Docker Desktop с WSL2-бэкендом и актуальный драйвер NVIDIA на Windows; Container Toolkit не нужен.
- Проверка: `docker run --rm --gpus all nvidia/cuda:12.x-base-ubuntu24.04 nvidia-smi`.
- `.gitattributes` (`eol=lf`) исключает проблемы с CRLF.

### 8.4. Mac (разработка)
Без Docker: `uv sync && uv run uvicorn ai_gateway.main:app --reload`, в `.env` —
`AIGW_DEVICE=cpu` и `AIGW_MODELS_FILE=models.dev.yaml` (в репозитории; модели `tiny` и `base`,
алиас `whisper-1` → `base`).

## 9. Зависимости

Основные: `fastapi`, `uvicorn[standard]`, `python-multipart`, `pydantic-settings`, `pyyaml`,
`faster-whisper`, `loguru`.
Dev (`[dependency-groups] dev`): `pytest`, `pytest-asyncio`, `httpx`, `openai`, `ruff`.

## 10. Вне рамок этапа 1

- Ollama и `/v1/chat/completions` (этап 2).
- Фоновые задачи и вебхуки для длинного аудио (этап 3).
- `/v1/audio/translations`, диаризация, стриминг распознавания, TTS.
- Межпроцессный учёт VRAM, метрики Prometheus, несколько GPU, многопользовательская авторизация.
