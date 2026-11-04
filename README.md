# ai_gateway

Локальный роутер моделей с **OpenAI-совместимым API**. Этап 1 — распознавание речи на
[faster-whisper](https://github.com/SYSTRAN/faster-whisper): модели загружаются в память по
первому запросу и выгружаются после TTL простоя, поэтому VRAM свободна, пока шлюз не нужен.

## Эндпоинты

| Метод и путь | Назначение |
|---|---|
| `POST /v1/audio/transcriptions` | распознавание (multipart: `file`, `model`, `language`, `prompt`, `temperature`, `response_format`, `timestamp_granularities[]`) |
| `GET /v1/models` | модели и алиасы из реестра |
| `GET /health` | состояние сервиса и моделей (без авторизации) |

`response_format`: `json` (по умолчанию), `text`, `verbose_json`, `srt`, `vtt`.
`timestamp_granularities[]=word` добавляет `words` в `verbose_json`.
Ошибки — в формате OpenAI: `{"error": {"message", "type", "param", "code"}}`;
нехватка памяти или ошибка загрузки модели — `503 model_unavailable` с заголовком `Retry-After: 30`.

## Запуск на Mac (разработка, CPU, без Docker)

```bash
uv sync
cat > .env <<'EOF'
AIGW_DEVICE=cpu
AIGW_MODELS_FILE=models.dev.yaml
AIGW_DEFAULT_TTL=60
AIGW_SWEEP_INTERVAL=10
EOF
uv run uvicorn ai_gateway.main:app --reload
```

```bash
curl -F file=@tests/fixtures/hello.wav -F model=whisper-1 http://localhost:8000/v1/audio/transcriptions
```

В `models.dev.yaml` — модели `tiny` и `base` (`whisper-1` → `whisper-base`, TTL 120 с).
Первый запрос скачивает веса с Hugging Face. Через ~2 минуты простоя в логе появится
`Модель whisper-base выгружена`.

Тесты и проверки:

```bash
uv run pytest                    # юнит- и API-тесты, без моделей и GPU
uv run pytest -m integration     # реальная модель tiny/base на CPU через OpenAI SDK
uv run ruff check . && uv run ruff format --check . && uv run mypy
```

## Развёртывание на Windows + NVIDIA (Docker Desktop)

1. Установить актуальный драйвер NVIDIA для Windows и Docker Desktop с бэкендом **WSL2**
   (NVIDIA Container Toolkit на Windows ставить не нужно).
2. Проверить, что контейнеры видят GPU:
   ```powershell
   docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi
   ```
3. В каталоге проекта:
   ```powershell
   copy .env.example .env
   docker compose up -d --build
   ```

Веса моделей кэшируются в volume `hf-cache`, реестр `models.yaml` монтируется только для чтения —
после его правки достаточно `docker compose restart gateway`.
uvicorn работает строго с одним воркером: каждый воркер загрузил бы свою копию модели в VRAM.

## Использование

OpenAI SDK:

```python
from openai import OpenAI

client = OpenAI(base_url="http://<host>:8000/v1", api_key="не-используется-или-AIGW_API_KEY")
with open("speech.mp3", "rb") as f:
    result = client.audio.transcriptions.create(model="whisper-1", file=f)
print(result.text)
```

curl:

```bash
curl http://<host>:8000/v1/audio/transcriptions \
  -H "Authorization: Bearer $AIGW_API_KEY" \
  -F file=@speech.mp3 -F model=whisper-1 -F response_format=srt
```

Заголовок `Authorization` нужен, только если задан `AIGW_API_KEY`.

## Реестр моделей (`models.yaml`)

```yaml
default_transcription: whisper-large-v3-turbo   # модель, если поле model пустое
aliases:
  whisper-1: whisper-large-v3-turbo             # имя OpenAI → модель шлюза
models:
  whisper-large-v3:
    backend: whisper
    model: large-v3          # имя модели faster-whisper или путь
    ttl: 600                 # простой до выгрузки, сек; -1 — никогда, 0 — сразу после запроса
    max_concurrency: 1       # одновременных распознаваний на модель
    vad_filter: true         # вырезать тишину (Silero VAD)
```

Без `ttl` у модели берётся `AIGW_DEFAULT_TTL`. Реестр проверяется при старте: алиасы и модель по
умолчанию должны ссылаться на существующие модели, иначе сервис не запустится.

## Переменные окружения

См. `.env.example`: `AIGW_DEVICE`, `AIGW_COMPUTE_TYPE`, `AIGW_API_KEY`, `AIGW_MAX_UPLOAD_MB`,
`AIGW_MODELS_FILE`, `AIGW_DEFAULT_TTL`, `AIGW_SWEEP_INTERVAL`, `AIGW_LOG_LEVEL`.

## Чек-лист проверки на GPU

- [ ] `docker compose exec gateway nvidia-smi` — карта видна в контейнере.
- [ ] Первый запрос: в логе (`docker compose logs -f gateway`) — `Устройство: cuda, compute_type: float16`
      и `Модель … загружена за N с`.
- [ ] Повторный запрос заметно быстрее первого (модель уже в памяти).
- [ ] После TTL простоя — `Модель … выгружена`, а потребление памяти в `nvidia-smi` падает.
