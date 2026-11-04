# ai_gateway

Локальный роутер моделей с **OpenAI-совместимым API**. Этап 1 — распознавание речи на
[faster-whisper](https://github.com/SYSTRAN/faster-whisper): модели загружаются в память по
первому запросу и выгружаются после TTL простоя, поэтому VRAM свободна, пока шлюз не нужен.
Этап 2 — чат с LLM через [Ollama](https://ollama.com) (`/v1/chat/completions`, SSE-стриминг,
tool calling, картинки, рассуждения модели); память Ollama управляется её собственным `keep_alive`.
Этап 3 — Web UI на `http://<host>:8000/`: распознавание файлов (аудио и видео, в том числе на
гигабайты), записи с микрофона и чат с LLM.

## Эндпоинты

| Метод и путь | Назначение |
|---|---|
| `POST /v1/audio/transcriptions` | распознавание (multipart: `file`, `model`, `language`, `prompt`, `temperature`, `response_format`, `timestamp_granularities[]`) |
| `POST /v1/chat/completions` | чат (JSON по схеме OpenAI; `stream: true` — SSE); модели с `backend: ollama` |
| `GET /v1/models` | модели и алиасы из реестра |
| `GET /health` | состояние сервиса и моделей, `"ollama": "ok" \| "unavailable"` (без авторизации) |
| `GET /ui/config` | настройки для Web UI: лимит загрузки, модели с типом, языки, нужен ли ключ (без авторизации) |
| `GET /` | Web UI (статика из `AIGW_WEB_DIR`, если каталог есть) |

`response_format`: `json` (по умолчанию), `text`, `verbose_json`, `srt`, `vtt`.
`timestamp_granularities[]=word` добавляет `words` в `verbose_json`.
Ошибки — в формате OpenAI: `{"error": {"message", "type", "param", "code"}}`;
нехватка памяти или ошибка загрузки модели — `503 model_unavailable` с заголовком `Retry-After: 30`.

## Запуск на Mac (разработка, CPU)

Шлюз запускается вне Docker, Ollama — в Docker (Metal в контейнерах недоступен, модели работают на CPU).

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

В `models.dev.yaml` — модели `tiny` и `base` (`whisper-1` → `whisper-base`, TTL 120 с) и
LLM `qwen3-0.6b` (tools + reasoning) и `qwen2.5vl-3b` (vision).
Первый запрос скачивает веса с Hugging Face. Через ~2 минуты простоя в логе появится
`Модель whisper-base выгружена`.

Ollama для чата (нужна только для запросов к LLM; шлюз и Whisper работают и без неё):

```bash
docker run -d --name ollama-dev -p 127.0.0.1:11434:11434 -v ollama-dev:/root/.ollama ollama/ollama:0.40.8
docker exec ollama-dev ollama pull qwen3:0.6b
docker exec ollama-dev ollama pull qwen2.5vl:3b     # vision, нужен только для теста с картинкой
docker stop ollama-dev                              # остановка (`docker start ollama-dev` — запуск снова)
```

Для `qwen2.5vl:3b` виртуальной машине Docker Desktop нужно не менее ~6 ГБ памяти
(Settings → Resources → Memory). Шлюз по умолчанию ходит на `http://localhost:11434`.

```bash
curl http://localhost:8000/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model": "qwen3-0.6b", "messages": [{"role": "user", "content": "Привет!"}]}'
```

Тесты и проверки:

```bash
uv run pytest                    # юнит- и API-тесты, без моделей и GPU
uv run pytest -m integration     # реальные whisper tiny/base на CPU и Ollama (если запущена) через OpenAI SDK
uv run ruff check . && uv run ruff format --check . && uv run mypy
```

## Web UI

Открывается на `http://<host>:8000/` (в Docker-образе UI собран и включён).

- **Распознавание.** Файл кнопкой или перетаскиванием, выбор модели и языка; результат — плеер,
  полный текст с копированием, сегменты с таймкодами (клик перематывает плеер), подсветка
  текущего слова и перемотка по клику на слово, скачивание `txt` / `srt` / `vtt` / `json`.
- **Большие видео.** Файл до `AIGW_MAX_UPLOAD_MB` уходит на сервер как есть. Из видео больше лимита
  браузер сам извлекает аудиодорожку (ffmpeg.wasm, без перекодирования, файл не читается в память
  целиком — проверено на 4,95 ГБ) и отправляет только её. Аудиофайл больше лимита не отправляется.
- **Микрофон** — «записал → отправил». Браузеры дают микрофон только на `localhost` или по `https`:
  на самой машине со шлюзом он работает, с другого устройства по `http://<IP>:8000` кнопка неактивна.
  Обход для Chrome на ноутбуке: `chrome://flags/#unsafely-treat-insecure-origin-as-secure` →
  добавить `http://<IP>:8000` → перезапустить браузер.
- **Чат.** Выбор модели, стриминг, «Стоп», Markdown с подсветкой кода, свёрнутые «Размышления»,
  `reasoning_effort` (`none` выключает мышление у qwen3), картинки (кнопка, вставка из буфера,
  перетаскивание; уменьшаются до 2048 px), системный промпт, `temperature`, `max_tokens`,
  правка сообщения и перегенерация.
- **Истории нет:** перезагрузка страницы теряет результат и диалог (браузер спросит подтверждение).
- Если задан `AIGW_API_KEY`, UI спросит ключ и запомнит его в браузере; неверный ключ спросит снова.

Разработка фронтенда (Node 26+; шлюз запущен как выше на `:8000`):

```bash
cd web
npm ci
npm run dev                      # http://localhost:5173, /v1 /health /ui проксируются на :8000
npm test                         # юнит- и компонентные тесты (Vitest), без сети
npm run lint && npm run typecheck
npm run build                    # web/dist — его раздаёт шлюз (AIGW_WEB_DIR=web/dist)
npx playwright install chromium  # однократно
npm run test:e2e                 # сборка + реальный шлюз на :8765 (whisper на CPU, лимит 1 МиБ);
                                 # чат-тест пропускается, если ollama-dev не запущена
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
   docker compose exec ollama ollama pull qwen3:14b
   ```
   Имя при `ollama pull` должно совпадать с полем `model` записи в `models.yaml` (`qwen3:14b` для
   `qwen3-14b`); при другой модели поправьте `models.yaml` и скачайте её.

> **Безопасность.** Порт `8000` публикуется на все интерфейсы машины, то есть доступен из
> локальной сети, а авторизация по умолчанию выключена. Если сеть не доверенная — задайте в `.env`
> `AIGW_API_KEY`, тогда для `/v1/*` нужен заголовок `Authorization: Bearer <ключ>`
> (`/health` остаётся открытым). Чтобы шлюз был виден только с этой машины, замените в
> `docker-compose.yml` `"8000:8000"` на `"127.0.0.1:8000:8000"`.

**Первый запрос на GPU медленный:** веса скачиваются с Hugging Face (`large-v3-turbo` — около
1,6 ГБ, `large-v3` — около 3 ГБ) и загружаются в VRAM. Повторные запросы, пока модель не
выгружена по TTL, идут без этой задержки.

Контейнер `ollama` (закреплённая версия образа, GPU делится со шлюзом) порты наружу не публикует:
шлюз — единственная точка входа. Модели Ollama лежат в volume `ollama-models`; отладка —
`docker compose exec ollama ollama ps|pull|list`. Шлюз стартует и без Ollama (`/health` покажет
`"ollama": "unavailable"`, распознавание продолжит работать).

Веса Whisper кэшируются в volume `hf-cache`, реестр `models.yaml` монтируется только для чтения —
после его правки достаточно `docker compose restart gateway`.
uvicorn работает строго с одним воркером: каждый воркер загрузил бы свою копию модели в VRAM.

## Использование

OpenAI SDK:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://<host>:8000/v1", api_key="sk-local"
)  # любой ASCII; если задан AIGW_API_KEY — его значение
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

## Чат (`/v1/chat/completions`)

Тело запроса — по схеме OpenAI Chat Completions; поле `model` обязательно (имя или алиас из
`models.yaml`, модель должна быть с `backend: ollama`). Неизвестные поля передаются в Ollama, кроме `keep_alive`: он отбрасывается, время простоя
модели задаёт только `OLLAMA_KEEP_ALIVE` контейнера.

Без стрима:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://<host>:8000/v1", api_key="sk-local"
)  # любой ASCII; если задан AIGW_API_KEY — его значение
resp = client.chat.completions.create(
    model="qwen3-14b",
    messages=[{"role": "user", "content": "Объясни, что такое KV-кэш, в двух предложениях."}],
)
print(resp.choices[0].message.content)
# рассуждения модели приходят отдельным полем reasoning_content
print(getattr(resp.choices[0].message, "reasoning_content", None))
```

Со стримом (SSE, в конце `data: [DONE]`):

```python
stream = client.chat.completions.create(
    model="qwen3-14b",
    messages=[{"role": "user", "content": "Расскажи короткую историю."}],
    stream=True,
)
for chunk in stream:
    if chunk.choices:
        print(chunk.choices[0].delta.content or "", end="", flush=True)
```

Tool call (полный цикл):

```python
import json

tools = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Погода в городе",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }
]
messages = [{"role": "user", "content": "Какая погода в Казани?"}]
first = client.chat.completions.create(model="qwen3-14b", messages=messages, tools=tools)
call = first.choices[0].message.tool_calls[0]
messages.append(first.choices[0].message.model_dump(exclude_none=True))
messages.append(
    {
        "role": "tool",
        "tool_call_id": call.id,
        "content": json.dumps({"temp_c": 7, "sky": "облачно"}),
    }
)
final = client.chat.completions.create(model="qwen3-14b", messages=messages, tools=tools)
print(final.choices[0].message.content)
```

Особенности:

- Рассуждения модели (qwen3 и подобные) возвращаются в `reasoning_content` (и в `message`, и в `delta`).
- Картинки — только как base64 data URL в части `image_url`:
  `{"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}`. Ссылки `http(s)://`
  не принимаются (`400 invalid_image_url`). Для картинок нужна vision-модель (в dev — `qwen2.5vl-3b`).
- Роль `developer` заменяется на `system`.
- Тело запроса ограничено `AIGW_MAX_UPLOAD_MB` (картинки в base64 занимают место).
- Если ошибка случается посреди стрима, шлюз присылает событие `data: {"error": {...}}` и закрывает
  поток без `[DONE]` — OpenAI SDK бросает `APIError`.

Ошибки чата (формат OpenAI, как и везде):

| `code` | HTTP | Когда |
|---|---|---|
| `model_not_supported` | 400 | модель не того типа для эндпоинта (LLM в `/v1/audio/transcriptions` и наоборот) |
| `invalid_image_url` | 400 | `image_url` не base64 data URL |
| `invalid_request_error` | 400 | пустой `model`, неподдерживаемая часть `content`, ошибка валидации; отказ Ollama 400 (модель не поддерживает tools/картинки) |
| `model_not_found` | 404 | неизвестная модель |
| `request_too_large` | 413 | тело запроса больше `AIGW_MAX_UPLOAD_MB` |
| `model_unavailable` | 503 + `Retry-After: 30` | Ollama недоступна, нехватка памяти, очередь переполнена, модель не скачана (в сообщении — `ollama pull`) |
| `upstream_error` | 502 | прочие ошибки Ollama (детали — в логе шлюза) |
| `upstream_timeout` | 504 | Ollama не отвечает дольше `AIGW_OLLAMA_READ_TIMEOUT` |

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
`AIGW_MODELS_FILE`, `AIGW_DEFAULT_TTL`, `AIGW_SWEEP_INTERVAL`, `AIGW_LOG_LEVEL`,
`AIGW_OLLAMA_URL` (по умолчанию `http://localhost:11434`; в compose — `http://ollama:11434`),
`AIGW_OLLAMA_READ_TIMEOUT` (макс. пауза между байтами ответа Ollama, по умолчанию 300 с).
Настройки контейнера `ollama` в `.env` (подставляются compose): `OLLAMA_KEEP_ALIVE` (простой до
выгрузки модели, `10m`), `OLLAMA_NUM_PARALLEL` (`1`), `OLLAMA_CONTEXT_LENGTH` (`16384`),
`OLLAMA_FLASH_ATTENTION` (`1`), `OLLAMA_KV_CACHE_TYPE` (`q8_0`).
Оценка памяти для `qwen3:14b` (q4) при контексте 16k: веса ~9 ГБ + KV-кэш ~1,6 ГБ + Whisper ~2 ГБ ≈ 13 ГБ из 16 ГБ.
`AIGW_WEB_DIR` — каталог собранного Web UI (по умолчанию `web/dist`, в образе `/app/web`);
нет каталога — UI не раздаётся, API работает как обычно.
`TZ` (например, `Europe/Moscow`) задаёт часовой пояс контейнера для времени в логах; без него — UTC.

## Чек-лист проверки на GPU

- [ ] `docker compose exec gateway nvidia-smi` — карта видна в контейнере.
- [ ] Первый запрос: в логе (`docker compose logs -f gateway`) — `Устройство: cuda, compute_type: float16`
      и `Модель … загружена за N с`.
- [ ] Повторный запрос заметно быстрее первого (модель уже в памяти).
- [ ] После TTL простоя — `Модель … выгружена`, а потребление памяти в `nvidia-smi` падает.
      До нуля оно не опускается: процесс шлюза держит CUDA-контекст и кэш аллокатора
      CTranslate2 (обычно несколько сотен МБ) — это нормально.

## Чек-лист приёмки чата на GPU

- [ ] `git pull`, в `.env` дописаны переменные `OLLAMA_*` из `.env.example`,
      `docker compose up -d --build`; `docker compose exec ollama nvidia-smi` видит GPU.
- [ ] `docker compose exec ollama ollama pull qwen3:14b`; `curl.exe http://localhost:8000/health`
      возвращает `"ollama": "ok"`.
- [ ] OpenAI SDK: ответ без стрима, со стримом, полный цикл tool call; в ответе есть `reasoning_content`.
- [ ] Распознавание и чат по очереди идут без 503; в `nvidia-smi` обе модели в памяти, суммарно < 16 ГБ.
- [ ] После простоя `OLLAMA_KEEP_ALIVE` `docker compose exec ollama ollama ps` пуст, память в
      `nvidia-smi` упала.

## Чек-лист приёмки Web UI на GPU

- [ ] `git pull`, `docker compose up -d --build`; `http://localhost:8000/` открывает UI,
      `curl.exe http://localhost:8000/health` и OpenAI SDK работают как раньше.
- [ ] UI открывается с ноутбука по `http://<IP>:8000/`.
- [ ] Аудиофайл и видео меньше `AIGW_MAX_UPLOAD_MB` распознаются; клик по таймкоду перематывает
      плеер; скачиваются `txt`, `srt`, `vtt`, `json`.
- [ ] Видео 2–4 ГБ: идёт «Извлечение аудио из видео…», затем загрузка небольшой дорожки и текст.
- [ ] Микрофон на `localhost:8000` записывает и распознаётся; по `http://<IP>:8000` кнопка
      неактивна с подсказкой (или работает после флага Chrome).
- [ ] Чат: стрим, «Стоп» (в логе шлюза `итог=client_disconnected`), «Размышления», картинка на
      vision-модели, правка сообщения и «Перегенерировать».
- [ ] С `AIGW_API_KEY` в `.env` UI спрашивает ключ; с неверным ключом спрашивает снова.
