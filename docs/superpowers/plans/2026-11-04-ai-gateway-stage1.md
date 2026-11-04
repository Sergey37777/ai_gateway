# ai_gateway — Этап 1 (шлюз + Whisper): план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenAI-совместимый шлюз на FastAPI с эндпоинтом `POST /v1/audio/transcriptions` на faster-whisper, ленивой загрузкой моделей и выгрузкой из VRAM по TTL, упакованный в Docker с GPU.

**Architecture:** `api/*` → `ModelRegistry.resolve()` (имя/алиас → `ModelSpec`) → `ModelManager.acquire()` (загрузка, семафор, TTL) → `WhisperBackend.transcribe()` в `asyncio.to_thread` → `formatting.render()`. Все ошибки — `GatewayError` в формате OpenAI. Приложение собирается фабрикой `create_app()` с возможностью внедрить реестр/менеджер (для тестов с фейковым бэкендом).

**Tech Stack:** Python 3.12, Poetry, FastAPI, uvicorn, python-multipart, pydantic-settings, PyYAML, faster-whisper, loguru; pytest, pytest-asyncio, httpx, openai, ruff; Docker (`nvidia/cuda` + cuDNN 9).

**Spec:** `docs/superpowers/specs/2026-11-04-ai-gateway-stage1-design.md`

## Global Constraints

- Python: в Docker — системный 3.12 Ubuntu 24.04; `requires-python = ">=3.12,<3.14"` (чтобы на Mac работал и 3.13).
- Пакет — src-layout: `src/ai_gateway`, Poetry `packages = [{ include = "ai_gateway", from = "src" }]`.
- Env-префикс `AIGW_`; значения по умолчанию — ровно из таблицы спецификации §4.5.
- Формат ошибок: `{"error": {"message", "type", "param", "code"}}`; коды и статусы — ровно из таблицы §6.
- uvicorn — строго `--workers 1`.
- Документация, комментарии, сообщения коммитов — на русском, с префиксами `feat:`/`test:`/`docs:`/`chore:`.
- Коммиты: в конце сообщения строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Глобальный git user на Mac не настроен — если `git config user.email` пуст, коммитить с `git -c user.name="Ляпин Сергей" -c user.email="96964492+Sergey37777@users.noreply.github.com" commit ...`.
- Тесты, кроме `-m integration`, не должны скачивать модели и вызывать настоящий `WhisperModel` (импорт пакета `faster_whisper` допустим).
- Все тесты — `async def` (pytest-asyncio, `asyncio_mode = "auto"`), HTTP-клиент — `httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")`.

## Review Focus

1. **Клиент оборвал соединение / запрос отменён, пока ждёт семафор или загрузку** — `active` должен вернуться к 0, семафор освободиться, модель потом выгружается по TTL. → тест `test_cancelled_acquire_releases_slot` в Task 4.
2. **Пустой файл (0 байт)** — ожидается 400 `invalid_audio`, а не 500 из глубины PyAV. → тест `test_empty_file_is_invalid_audio` в Task 5.
3. **Неизвестный код языка (`language=xx`)** — faster-whisper бросает `ValueError`; ожидается 400 `invalid_request_error` с `param="language"`. → тест `test_unknown_language_rejected` в Task 5.
4. **CUDA OOM не при загрузке, а во время `transcribe`** (длинное аудио, рядом Ollama) — ожидается 503 `model_unavailable` + `Retry-After`, а не 500. → тест `test_oom_during_transcribe_is_503` в Task 5.
5. **Временный файл при ошибке распознавания** — не должен оставаться на диске (длинные файлы быстро забьют диск контейнера). → тест `test_temp_file_removed_on_error` в Task 5.

---

### Task 1: Каркас проекта и конфигурация

**Files:**
- Create: `pyproject.toml`, `src/ai_gateway/__init__.py`, `src/ai_gateway/config.py`, `tests/__init__.py`, `tests/test_config.py`

**Interfaces:**
- Produces:
  - `class Settings(BaseSettings)` — поля `device: Literal["auto","cuda","cpu"] = "auto"`, `compute_type: str = "auto"`, `api_key: str | None = None`, `max_upload_mb: int = 200`, `models_file: Path = Path("models.yaml")`, `default_ttl: int = 600`, `sweep_interval: float = 30.0`, `log_level: str = "INFO"`; `model_config = SettingsConfigDict(env_prefix="AIGW_", env_file=".env", extra="ignore")`.
  - `def resolve_device(device: str, cuda_device_count: int) -> Literal["cuda","cpu"]`
  - `def resolve_compute_type(compute_type: str, device: str) -> str`
  - `def detect_cuda_device_count() -> int` — ленивый `import ctranslate2`, `ctranslate2.get_cuda_device_count()`; при `ImportError` → 0.

- [ ] **Step 1: Создать `pyproject.toml` и установить зависимости**

`[project]`: `name = "ai-gateway"`, `version = "0.1.0"`, `requires-python = ">=3.12,<3.14"`, автор `Sergey Lyapin`. `[tool.poetry] packages = [{ include = "ai_gateway", from = "src" }]`. Затем:

```bash
poetry add fastapi "uvicorn[standard]" python-multipart pydantic-settings pyyaml faster-whisper loguru
poetry add --group dev pytest pytest-asyncio httpx openai ruff
```

Секции инструментов:

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
asyncio_default_fixture_loop_scope = "function"
testpaths = ["tests"]
addopts = "-m 'not integration'"
markers = ["integration: реальная модель faster-whisper на CPU (медленно, качает веса)"]

[tool.ruff]
line-length = 100
target-version = "py312"
src = ["src", "tests"]

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "ASYNC"]
```

Проверка: `poetry run python -c "import ai_gateway"` — без ошибок.

- [ ] **Step 2: Написать падающие тесты `tests/test_config.py`**

```python
def test_defaults(monkeypatch):            # monkeypatch.chdir(tmp_path), чтобы не подхватить .env
    s = Settings()
    assert (s.device, s.compute_type, s.api_key) == ("auto", "auto", None)
    assert (s.max_upload_mb, s.default_ttl, s.sweep_interval) == (200, 600, 30.0)
    assert s.models_file == Path("models.yaml") and s.log_level == "INFO"

def test_env_prefix(monkeypatch):          # AIGW_MAX_UPLOAD_MB=5, AIGW_API_KEY=secret
    assert Settings().max_upload_mb == 5 and Settings().api_key == "secret"

@pytest.mark.parametrize("device,count,expected", [
    ("auto", 1, "cuda"), ("auto", 0, "cpu"), ("cpu", 1, "cpu"), ("cuda", 0, "cuda")])
def test_resolve_device(device, count, expected): ...

@pytest.mark.parametrize("ct,device,expected", [
    ("auto", "cuda", "float16"), ("auto", "cpu", "int8"), ("int8_float16", "cuda", "int8_float16")])
def test_resolve_compute_type(ct, device, expected): ...
```

- [ ] **Step 3: Запустить — FAIL** (`poetry run pytest tests/test_config.py -v` → `ImportError`)
- [ ] **Step 4: Реализовать `config.py`** по Interfaces.
- [ ] **Step 5: Запустить — PASS**; `poetry run ruff check . && poetry run ruff format --check .` — чисто.
- [ ] **Step 6: Commit** — `chore: каркас проекта и конфигурация (Settings)` (включая `poetry.lock`).

---

### Task 2: Типы бэкендов и форматирование ответов

**Files:**
- Create: `src/ai_gateway/backends/__init__.py` (пока пустой), `src/ai_gateway/backends/base.py`, `src/ai_gateway/languages.py`, `src/ai_gateway/formatting.py`
- Test: `tests/test_formatting.py`

**Interfaces:**
- Produces (`backends/base.py`, все — `@dataclass(frozen=True, slots=True)`):
  - `Word(word: str, start: float, end: float)`
  - `Segment(id: int, start: float, end: float, text: str, avg_logprob: float, compression_ratio: float, no_speech_prob: float, temperature: float)`
  - `TranscriptionOptions(language: str | None = None, prompt: str | None = None, temperature: float = 0.0, word_timestamps: bool = False)` — `vad_filter` берётся бэкендом из `ModelSpec`, не из запроса.
  - `TranscriptionResult(text: str, language: str, duration: float, segments: list[Segment], words: list[Word] | None = None)`
  - `class LoadableBackend(Protocol)`: `def load(self) -> None`, `def unload(self) -> None`, `@property def loaded(self) -> bool`
  - `class TranscriptionBackend(LoadableBackend, Protocol)`: `def transcribe(self, audio_path: Path, options: TranscriptionOptions) -> TranscriptionResult`
- Produces (`languages.py`): `LANGUAGES: dict[str, str]` — копия словаря кодов Whisper (`"en": "english"`, `"ru": "russian"`, …, 100 языков, включая `"yue": "cantonese"`) из `openai/whisper` `whisper/tokenizer.py`; `def language_name(code: str) -> str` — имя или сам код, если неизвестен.
- Produces (`formatting.py`):
  - `ResponseFormat = Literal["json", "text", "verbose_json", "srt", "vtt"]`
  - `def render(result: TranscriptionResult, fmt: ResponseFormat, *, include_words: bool = False) -> Response` (starlette `Response`/`JSONResponse`/`PlainTextResponse`)
  - `def format_timestamp(seconds: float, *, decimal_marker: str) -> str` — `HH:MM:SS{marker}mmm`, округление до ближайшей миллисекунды.

- [ ] **Step 1: Падающие тесты `tests/test_formatting.py`** на фикстуре из двух сегментов (`text=" Привет."`, `0.0–1.5`; `text=" Мир."`, `1.5–3661.5`), `language="ru"`, `duration=3661.5`, два `Word`:

```python
def test_format_timestamp():
    assert format_timestamp(3661.5, decimal_marker=",") == "01:01:01,500"
    assert format_timestamp(0.0004, decimal_marker=".") == "00:00:00.000"
    assert format_timestamp(1.9996, decimal_marker=",") == "00:00:02,000"

async def test_json(): body == {"text": "Привет. Мир."}; media_type == "application/json"
async def test_text(): body == "Привет. Мир."; media_type startswith "text/plain"
async def test_srt():
    assert body == "1\n00:00:00,000 --> 00:00:01,500\nПривет.\n\n2\n00:00:01,500 --> 01:01:01,500\nМир.\n"
async def test_vtt():
    assert body == "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nПривет.\n\n00:00:01.500 --> 01:01:01.500\nМир.\n"
async def test_verbose_json_without_words():
    # task="transcribe", language="russian", duration=3661.5, text, len(segments)==2,
    # ключи сегмента == {"id","start","end","text","avg_logprob","compression_ratio","no_speech_prob","temperature"},
    # "words" not in body
async def test_verbose_json_with_words(): body["words"] == [{"word":..., "start":..., "end":...}, ...]
async def test_verbose_json_words_requested_but_missing(): include_words=True, words=None → "words" not in body
def test_language_name(): language_name("ru") == "russian"; language_name("zz") == "zz"
```

Текст в `json`/`text`/субтитрах — `strip()` каждого сегмента; `result.text` уже готов (собирает бэкенд), `render` его не пересобирает.

- [ ] **Step 2: Запустить — FAIL**
- [ ] **Step 3: Реализовать `base.py`, `languages.py`, `formatting.py`** по Interfaces.
- [ ] **Step 4: Запустить — PASS**, ruff чисто.
- [ ] **Step 5: Commit** — `feat: типы бэкендов и форматирование ответов (json/text/verbose_json/srt/vtt)`

---

### Task 3: Ошибки и реестр моделей

**Files:**
- Create: `src/ai_gateway/errors.py`, `src/ai_gateway/registry.py`, `models.yaml`, `models.dev.yaml`
- Modify: `src/ai_gateway/backends/__init__.py`
- Test: `tests/test_registry.py`

**Interfaces:**
- Produces (`errors.py`):
  - `class GatewayError(Exception)`: `__init__(self, status_code: int, code: str, message: str, *, param: str | None = None, headers: dict[str, str] | None = None)`; свойство `error_type: str` — `401 → "authentication_error"`, `>= 500 → "server_error"`, иначе `"invalid_request_error"`; `def to_body(self) -> dict`.
  - `def model_unavailable(message: str) -> GatewayError` — 503, `code="model_unavailable"`, `headers={"Retry-After": "30"}`.
  - `def install_error_handlers(app: FastAPI) -> None` — реализуется в Task 5 (в этой задаче не создавать).
- Produces (`registry.py`):
  - `class ModelSpec(BaseModel)`: `name: str`, `backend: Literal["whisper"]`, `model: str`, `ttl: int` (`ge=-1`), `max_concurrency: int = 1` (`ge=1`), `vad_filter: bool = True`.
  - `class RegistryError(ValueError)` — ошибка конфигурации.
  - `class ModelRegistry`: `@classmethod from_dict(cls, data: dict, *, default_ttl: int) -> ModelRegistry`; `@classmethod from_file(cls, path: Path, *, default_ttl: int) -> ModelRegistry`; `def resolve(self, name: str | None) -> ModelSpec`; `def specs(self) -> list[ModelSpec]`; `def model_ids(self) -> list[str]` (модели + алиасы, отсортировано); свойство `default_transcription: str`.
- Produces (`backends/__init__.py`): `def build_backend(spec: ModelSpec, *, device: str, compute_type: str) -> LoadableBackend` — словарь фабрик `{"whisper": ...}`; для whisper — `WhisperBackend(spec.model, device=device, compute_type=compute_type, vad_filter=spec.vad_filter)`, импорт `WhisperBackend` **внутри** функции (Task 6 создаёт класс).

- [ ] **Step 1: Падающие тесты `tests/test_registry.py`** (`DATA` — словарь как в `models.yaml` спецификации §4.4, без `ttl` у turbo):

```python
def test_resolve_by_name(): r.resolve("whisper-large-v3").model == "large-v3"
def test_resolve_alias(): r.resolve("whisper-1").name == "whisper-large-v3-turbo"
@pytest.mark.parametrize("name", [None, ""])
def test_resolve_default(name): r.resolve(name).name == "whisper-large-v3-turbo"
def test_default_ttl_applied(): from_dict(DATA_without_ttl, default_ttl=42).resolve("whisper-large-v3-turbo").ttl == 42
def test_unknown_model():
    with pytest.raises(GatewayError) as e: r.resolve("nope")
    assert (e.value.status_code, e.value.code, e.value.param) == (404, "model_not_found", "model")
def test_model_ids(): r.model_ids() == ["whisper-1", "whisper-large-v3", "whisper-large-v3-turbo"]
@pytest.mark.parametrize("mutate", [
    alias_to_missing_model, default_to_missing_model, ttl_minus_2, max_concurrency_0,
    unknown_backend, no_models])
def test_invalid_config(mutate): pytest.raises(RegistryError, match=...)   # сообщение называет проблемное поле/имя
def test_from_file(tmp_path): yaml → тот же результат, что from_dict
def test_repo_model_files_are_valid(): from_file(Path("models.yaml")) и from_file(Path("models.dev.yaml")) не падают
def test_gateway_error_body():
    e = model_unavailable("OOM")
    assert e.status_code == 503 and e.headers == {"Retry-After": "30"}
    assert e.to_body() == {"error": {"message": "OOM", "type": "server_error", "param": None, "code": "model_unavailable"}}
```

Pydantic-ошибки (`ttl=-2` и т.п.) оборачиваются в `RegistryError` с именем модели в тексте.

- [ ] **Step 2: Запустить — FAIL**
- [ ] **Step 3: Реализовать `errors.py` (без `install_error_handlers`), `registry.py`, `build_backend`; создать `models.yaml` (точно как §4.4 спецификации) и `models.dev.yaml`** (`default_transcription: whisper-base`, алиас `whisper-1: whisper-base`, модели `whisper-tiny` → `tiny`, `whisper-base` → `base`, `ttl: 120`).
- [ ] **Step 4: Запустить — PASS**, ruff чисто.
- [ ] **Step 5: Commit** — `feat: реестр моделей и GatewayError`

---

### Task 4: ModelManager — ленивая загрузка, семафор, выгрузка по TTL

**Files:**
- Create: `src/ai_gateway/lifecycle.py`, `tests/fakes.py`
- Test: `tests/test_lifecycle.py`

**Interfaces:**
- Consumes: `ModelSpec` (Task 3), `LoadableBackend` (Task 2), `model_unavailable` (Task 3).
- Produces (`lifecycle.py`):
  - `@dataclass(frozen=True) class ModelStatus(name: str, loaded: bool, active: int, idle_seconds: float | None)` — `idle_seconds=None`, если модель не загружена.
  - `class ModelManager`: `__init__(self, specs: Iterable[ModelSpec], backend_factory: Callable[[ModelSpec], LoadableBackend], *, clock: Callable[[], float] = time.monotonic)` — бэкенды создаются сразу (дёшево, без загрузки весов);
    `def acquire(self, name: str) -> AbstractAsyncContextManager[LoadableBackend]` (через `@asynccontextmanager`);
    `async def sweep(self) -> list[str]` — имена выгруженных;
    `async def run_sweeper(self, interval: float) -> None` — бесконечный цикл `sleep → sweep`, исключения `sweep` логируются и не роняют цикл;
    `def status(self) -> list[ModelStatus]`;
    `async def shutdown(self) -> None`.
  - Алгоритм `acquire` — ровно §4.3 спецификации; `load`/`unload` — через `asyncio.to_thread`; любое исключение `load` → `model_unavailable(f"Не удалось загрузить модель {name}: {exc}")`, слот остаётся `loaded=False`. Шаги «`active -= 1`, `last_used = clock()`, выгрузка при `ttl == 0`» — в `finally`, срабатывающем и при `CancelledError` на любом этапе.
  - Логи loguru: `"Модель {name} загружена за {sec:.1f} с"`, `"Модель {name} выгружена (простой {idle:.0f} с)"`.
- Produces (`tests/fakes.py`):
  - `class FakeClock`: `now: float = 0.0`, `__call__() -> float`, `advance(seconds: float) -> None`.
  - `class FakeTranscriptionBackend`: `__init__(self, result: TranscriptionResult | None = None, *, load_error: Exception | None = None, transcribe_error: Exception | None = None, load_gate: threading.Event | None = None)`; счётчики `load_calls`, `unload_calls`; `last_options: TranscriptionOptions | None`; `last_audio_path: Path | None`; `loaded`; `load()` ждёт `load_gate`, если задан.
  - `def make_result(text: str = "привет мир") -> TranscriptionResult` — один сегмент 0–1.0, `language="ru"`, `duration=1.0`.
  - `def spec(name="m", ttl=600, max_concurrency=1) -> ModelSpec` (`backend="whisper"`, `model="tiny"`).

- [ ] **Step 1: Падающие тесты `tests/test_lifecycle.py`**

```python
async def test_lazy_load():                # до acquire load_calls == 0; после — 1 и status()[0].loaded
async def test_concurrent_acquire_loads_once():
    # load_gate держит загрузку; 5 задач acquire("m"); gate.set(); все прошли; backend.load_calls == 1
async def test_sweep_unloads_after_ttl():  # ttl=600: advance(600) → sweep() == []; advance(1) → sweep() == ["m"], unload_calls == 1
async def test_ttl_zero_unloads_immediately():  # после выхода из acquire: loaded is False
async def test_ttl_minus_one_never_unloads():   # advance(10**6) → sweep() == []
async def test_active_model_not_unloaded():     # внутри acquire: advance(10**6); sweep() == []
async def test_semaphore_limits_concurrency():
    # max_concurrency=1: вторая задача не входит в тело, пока первая внутри (asyncio.Event); max_concurrency=2 — входят обе
async def test_load_error_is_503_and_retryable():
    # load_error=RuntimeError("CUDA failed with error out of memory") → GatewayError 503 "model_unavailable",
    # status()[0] == ModelStatus("m", False, 0, None); после backend.load_error = None — следующий acquire успешен
async def test_cancelled_acquire_releases_slot():   # Review Focus #1
    # задача A держит слот (max_concurrency=1), задача B ждёт семафор; B.cancel(); A выходит;
    # status()[0].active == 0; advance(601); sweep() == ["m"]
async def test_status_idle_seconds():           # после выхода из acquire advance(15) → idle_seconds == 15.0
async def test_shutdown_unloads_all():          # две загруженные модели → shutdown() → обе loaded False
async def test_unknown_name_raises_404():       # acquire("nope") → GatewayError 404 model_not_found
```

- [ ] **Step 2: Запустить — FAIL**
- [ ] **Step 3: Реализовать `tests/fakes.py` и `lifecycle.py`** по Interfaces.
- [ ] **Step 4: Запустить — PASS** (`poetry run pytest tests/test_lifecycle.py -v`), ruff чисто.
- [ ] **Step 5: Commit** — `feat: ModelManager — ленивая загрузка и выгрузка по TTL`

---

### Task 5: HTTP API — приложение, эндпоинты, ошибки, авторизация, логи

**Files:**
- Create: `src/ai_gateway/app.py`, `src/ai_gateway/main.py`, `src/ai_gateway/api/__init__.py`, `src/ai_gateway/api/deps.py`, `src/ai_gateway/api/audio.py`, `src/ai_gateway/api/models.py`, `src/ai_gateway/api/health.py`, `tests/conftest.py`
- Modify: `src/ai_gateway/errors.py` (добавить `install_error_handlers`)
- Test: `tests/test_api_audio.py`, `tests/test_api_misc.py`

**Interfaces:**
- Consumes: `Settings`, `resolve_device`, `resolve_compute_type`, `detect_cuda_device_count` (Task 1); `render`, `LANGUAGES`, `TranscriptionOptions` (Task 2); `ModelRegistry`, `GatewayError`, `model_unavailable`, `build_backend` (Task 3); `ModelManager` (Task 4).
- Produces:
  - `app.py`: `def create_app(settings: Settings | None = None, *, registry: ModelRegistry | None = None, manager: ModelManager | None = None) -> FastAPI`. Внедрённые объекты кладутся в `app.state` сразу; недостающие создаются в lifespan (`ModelRegistry.from_file(settings.models_file, default_ttl=settings.default_ttl)`; device/compute_type через resolve-функции; `ModelManager(registry.specs(), lambda s: build_backend(s, device=..., compute_type=...))`). Lifespan всегда: `configure_logging(settings.log_level)`, лог `"Устройство: {device}, compute_type: {ct}"`, запуск `run_sweeper(settings.sweep_interval)` как task; при остановке — `cancel()` и `manager.shutdown()`. `app.state`: `settings`, `registry`, `manager`, `device` (в тестах — `"cpu"`, если не задано).
  - `app.py`: `def configure_logging(level: str) -> None` — loguru в stderr, формат с `{extra[request_id]}`, `logger.configure(extra={"request_id": "-"})`.
  - ASGI-middleware `upload_size_guard` (в `app.py`): для `POST /v1/audio/transcriptions`, если `Content-Length` > `max_upload_mb * 1024 * 1024 + 1 MiB`, сразу отвечает 413 `file_too_large` в формате OpenAI, не читая тело. Именно middleware: FastAPI разбирает multipart до вызова эндпоинта и зависимостей.
  - Middleware request id: берёт `X-Request-ID` из запроса или `uuid4().hex`, `logger.contextualize(request_id=...)`, ставит заголовок `X-Request-ID` в ответ (включая ответы с ошибкой).
  - `main.py`: `app = create_app()` — только для uvicorn; тесты его не импортируют.
  - `errors.install_error_handlers(app)`: `GatewayError` → `JSONResponse(e.to_body(), status_code, headers)`; `RequestValidationError` → 400 `invalid_request_error`, `param` — последний элемент `loc` первой ошибки; `Exception` → 500 `internal_error`, `message="Внутренняя ошибка сервера"`, `logger.exception`.
  - `api/deps.py`: `get_settings`, `get_registry`, `get_manager` (из `request.app.state`); `async def require_api_key(request: Request) -> None` — если `settings.api_key` задан, сравнивает `Authorization: Bearer <key>` через `secrets.compare_digest`, иначе 401 `invalid_api_key`. Применяется к роутерам `/v1/*`, не к `/health`.
  - `POST /v1/audio/transcriptions` (`api/audio.py`), поля формы — §5.1 спецификации; `timestamp_granularities: list[str] = Form(default=[], alias="timestamp_granularities[]")`. Порядок проверок (после `upload_size_guard`): `response_format` ∉ `ResponseFormat` → 400 `param="response_format"`; гранулярность ∉ {`segment`,`word`} → 400 `param="timestamp_granularities[]"`; `language` не `None`/`""` и ∉ `LANGUAGES` → 400 `param="language"`; `registry.resolve(model)`; копирование `UploadFile` чанками по 1 MiB в `tempfile.NamedTemporaryFile(delete=False, suffix=<суффикс исходного имени>)` со счётчиком (превышение → 413 `file_too_large`); 0 байт → 400 `invalid_audio`; `acquire` + `asyncio.to_thread(backend.transcribe, path, options)`; `RuntimeError`, в тексте которого есть `"out of memory"` (без учёта регистра) → `model_unavailable(...)`; `render(result, fmt, include_words="word" in granularities)`; `finally` — `path.unlink(missing_ok=True)`. Лог: `"Распознано: модель={name}, аудио={duration:.1f} с, обработка={elapsed:.1f} с"`.
  - `GET /v1/models` и `GET /health` — тела ровно как §5.2/§5.3 спецификации.
- Produces (`tests/conftest.py`): фикстура `make_client` — async-фабрика `make_client(*, api_key: str | None = None, max_upload_mb: int = 200, backend: FakeTranscriptionBackend | None = None) -> httpx.AsyncClient`; реестр из словаря §4.4 (`default_ttl=600`), менеджер с фабрикой, возвращающей переданный фейк для любой модели; фейк доступен как `client.backend`.

- [ ] **Step 1: Падающие тесты `tests/test_api_audio.py`** (`files={"file": ("a.wav", b"RIFF....", "audio/wav")}`):

```python
async def test_json_default(make_client):       # model="whisper-1" → 200 {"text": "привет мир"}; backend.load_calls == 1
async def test_empty_model_uses_default(make_client):   # data={"model": ""} → 200
async def test_formats(make_client):            # parametrize text/srt/vtt/verbose_json → media type и начало тела
async def test_word_granularity_sets_option(make_client):
    # data={"response_format": "verbose_json", "timestamp_granularities[]": ["word", "segment"]}
    # → backend.last_options.word_timestamps is True; "words" in body
async def test_options_passed(make_client):     # language="ru", prompt="p", temperature="0.2" → last_options == TranscriptionOptions("ru", "p", 0.2, False)
async def test_unknown_model_404(make_client):  # body["error"]["code"] == "model_not_found", param == "model"
async def test_bad_response_format_400(make_client):     # param == "response_format"
async def test_bad_granularity_400(make_client):
async def test_unknown_language_rejected(make_client):   # Review Focus #3: language="xx" → 400, param == "language"
async def test_missing_file_400(make_client):            # без file → 400 invalid_request_error, param == "file"
async def test_empty_file_is_invalid_audio(make_client): # Review Focus #2: b"" → 400 "invalid_audio"
async def test_file_too_large_413(make_client):          # max_upload_mb=1, файл 1 MiB + 1 байт → 413 "file_too_large"
async def test_content_length_precheck_413(make_client): # content=b"x", headers Content-Length: "10000000000" и multipart content-type → 413 "file_too_large", backend.load_calls == 0
async def test_invalid_audio_from_backend(make_client):  # transcribe_error=GatewayError(400, "invalid_audio", "...") → 400
async def test_load_oom_is_503(make_client):             # load_error=RuntimeError("out of memory") → 503, Retry-After == "30"
async def test_oom_during_transcribe_is_503(make_client):  # Review Focus #4: transcribe_error=RuntimeError("CUDA failed with error out of memory")
async def test_unexpected_error_500(make_client):        # transcribe_error=ValueError("boom") → 500 "internal_error", "boom" not in text
async def test_temp_file_removed_on_error(make_client):  # Review Focus #5: после 500 — not backend.last_audio_path.exists()
async def test_temp_file_removed_on_success(make_client):
```

- [ ] **Step 2: Падающие тесты `tests/test_api_misc.py`**

```python
async def test_models_list(make_client):    # data ids == ["whisper-1", "whisper-large-v3", "whisper-large-v3-turbo"], object == "list"
async def test_health(make_client):         # {"status": "ok", "device": "cpu", "models": [... loaded False ...]}
async def test_auth_required(make_client):  # api_key="k": без заголовка → 401 "invalid_api_key", type "authentication_error"
async def test_auth_wrong_key(make_client): # "Bearer bad" → 401
async def test_auth_ok(make_client):        # "Bearer k" → 200 на /v1/models
async def test_health_without_auth(make_client):   # api_key="k", /health без заголовка → 200
async def test_request_id_generated(make_client):  # len(headers["X-Request-ID"]) == 32
async def test_request_id_propagated(make_client): # отправили "abc" → вернулся "abc", в том числе на 404
async def test_lifespan_builds_from_settings(tmp_path):
    # models_file=tmp_path/"m.yaml" (одна модель), device="cpu"; `async with LifespanManager`-аналог:
    # использовать `app.router.lifespan_context(app)` → app.state.manager.status() == [ModelStatus(<имя>, False, 0, None)] — веса не грузятся до запроса
```

- [ ] **Step 3: Запустить — FAIL**
- [ ] **Step 4: Реализовать `app.py`, `main.py`, `api/*`, `install_error_handlers`, `tests/conftest.py`** по Interfaces.
- [ ] **Step 5: Запустить весь набор — PASS** (`poetry run pytest -v`), ruff чисто.
- [ ] **Step 6: Commit** — `feat: HTTP API — /v1/audio/transcriptions, /v1/models, /health`

---

### Task 6: WhisperBackend и интеграционный тест через OpenAI SDK

**Files:**
- Create: `src/ai_gateway/backends/whisper.py`, `tests/fixtures/hello.wav`
- Test: `tests/test_whisper_backend.py`, `tests/test_integration_whisper.py`

**Interfaces:**
- Consumes: `TranscriptionOptions`, `TranscriptionResult`, `Segment`, `Word` (Task 2); `GatewayError` (Task 3); `build_backend` (Task 3) уже ссылается на этот класс.
- Produces: `class WhisperBackend`: `__init__(self, model: str, *, device: str, compute_type: str, vad_filter: bool = True, download_root: str | None = None)`; `load()` — `WhisperModel(model, device=..., compute_type=..., download_root=...)`; `unload()` — `self._model = None; gc.collect()`; `loaded`; `transcribe(audio_path, options)` — `RuntimeError("Модель не загружена")`, если не загружена; вызывает `self._model.transcribe(str(audio_path), language=options.language or None, initial_prompt=options.prompt or None, temperature=options.temperature, word_timestamps=options.word_timestamps, vad_filter=self._vad_filter)`; материализует генератор; `text = " ".join(s.text.strip() for s in segments).strip()`; `words` — плоский список слов всех сегментов при `word_timestamps`, иначе `None`; `language=info.language`, `duration=info.duration`. `av.error.FFmpegError` (и `IndexError` из декодера при отсутствии аудиопотока) → `GatewayError(400, "invalid_audio", "Не удалось декодировать аудиофайл", param="file")`.
- `faster_whisper` и `av` импортируются в начале `whisper.py`; `WhisperModel` создаётся только в `load()`.

- [ ] **Step 1: Сгенерировать фикстуру** (macOS):

```bash
say -o /tmp/hello.aiff "Hello world. This is a test."
afconvert -f WAVE -d LEI16@16000 -c 1 /tmp/hello.aiff tests/fixtures/hello.wav
```

Проверка: `afinfo tests/fixtures/hello.wav` — 16000 Hz, 1 канал, < 200 КБ.

- [ ] **Step 2: Падающие юнит-тесты `tests/test_whisper_backend.py`** (`monkeypatch.setattr(whisper_module, "WhisperModel", FakeWhisperModel)`; фейк возвращает `(iter([seg(0, 0, 1, " Hello", words=[w]), seg(1, 1, 2, " world.", words=[w])]), SimpleNamespace(language="en", duration=2.0))` и запоминает kwargs):

```python
def test_load_unload():            # loaded False → load() → True, конструктор получил device/compute_type → unload() → False
def test_transcribe_maps_result(): # text == "Hello world.", language "en", duration 2.0, [s.id for s in segments] == [0, 1], words is None
def test_transcribe_words():       # word_timestamps=True → len(words) == 2
def test_transcribe_kwargs():      # TranscriptionOptions("ru", "", 0.0, False) → kwargs language="ru", initial_prompt=None, vad_filter=True
def test_transcribe_not_loaded():  # RuntimeError
```

- [ ] **Step 3: Запустить — FAIL**, реализовать `whisper.py`, запустить — PASS.
- [ ] **Step 4: Интеграционный тест `tests/test_integration_whisper.py`** (`pytestmark = pytest.mark.integration`; приложение — `create_app(Settings(device="cpu", models_file=Path("models.dev.yaml")))`, lifespan через `app.router.lifespan_context(app)`):

```python
async def test_openai_sdk_transcription():
    client = AsyncOpenAI(base_url="http://test/v1", api_key="x",
                         http_client=httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test"))
    with open("tests/fixtures/hello.wav", "rb") as f:
        r = await client.audio.transcriptions.create(model="whisper-1", file=f)
    assert "hello" in r.text.lower()

async def test_openai_sdk_verbose_words():   # model="whisper-tiny", response_format="verbose_json",
    # timestamp_granularities=["word"] → r.language == "english", r.words непустой
async def test_garbage_audio_is_400():       # httpx: файл b"not audio at all" * 100 → 400 "invalid_audio"
```

- [ ] **Step 5: Запустить** `poetry run pytest -m integration -v` — PASS (первый запуск качает `tiny`/`base`, ~200 МБ). Затем `poetry run pytest` — интеграционные пропущены, остальное PASS.
- [ ] **Step 6: Ручной smoke-тест на Mac**: `.env` с `AIGW_DEVICE=cpu`, `AIGW_MODELS_FILE=models.dev.yaml`, `AIGW_DEFAULT_TTL=60`, `AIGW_SWEEP_INTERVAL=10`; `poetry run uvicorn ai_gateway.main:app`; `curl -F file=@tests/fixtures/hello.wav -F model=whisper-1 http://localhost:8000/v1/audio/transcriptions` → JSON с текстом; через ~70 с в логе `Модель whisper-base выгружена`.
- [ ] **Step 7: Commit** — `feat: WhisperBackend на faster-whisper + интеграционный тест через OpenAI SDK`

---

### Task 7: Docker, compose и README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, `README.md`
- Modify: `CLAUDE.md` (только если реальные команды разошлись с описанными)

**Interfaces:**
- Consumes: `ai_gateway.main:app` (Task 5), `models.yaml` (Task 3).

- [ ] **Step 1: Выбрать тег базового образа**: `docker manifest inspect nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04` (если не существует — ближайший `12.x-cudnn-runtime-ubuntu24.04` с cuDNN 9, требования CTranslate2 — в README faster-whisper). Записать выбранный тег в обе стадии `Dockerfile`.
- [ ] **Step 2: `Dockerfile`** (multi-stage):
  - **builder:** выбранный образ; `apt-get install python3.12 python3.12-venv`; `python3.12 -m venv /opt/poetry && /opt/poetry/bin/pip install poetry`; `python3.12 -m venv /opt/venv`; `COPY pyproject.toml poetry.lock /app/`; `VIRTUAL_ENV=/opt/venv /opt/poetry/bin/poetry install --only main --no-root --no-interaction`.
  - **runtime:** тот же образ; `apt-get install python3.12` (без `-venv`), очистка apt-кэша; `useradd -m app`; `COPY --from=builder /opt/venv /opt/venv`; `COPY src /app/src`; `COPY models.yaml /app/models.yaml`; `ENV PATH=/opt/venv/bin:$PATH PYTHONPATH=/app/src HF_HOME=/home/app/.cache/huggingface PYTHONUNBUFFERED=1`; `WORKDIR /app`; `USER app`; `EXPOSE 8000`; `CMD ["uvicorn", "ai_gateway.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]`.
  - `.dockerignore`: `.git`, `.venv`, `tests`, `docs`, `.env`, `__pycache__`, `*.pyc`.
- [ ] **Step 3: `docker-compose.yml`** — сервис `gateway` ровно по §8.2 спецификации; healthcheck: `["CMD", "python3", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]`, `interval: 30s`, `timeout: 5s`, `start_period: 30s`; volume `hf-cache` объявлен на верхнем уровне. Каталог `/home/app/.cache/huggingface` создаётся в Dockerfile от пользователя `app`, чтобы volume унаследовал владельца.
- [ ] **Step 4: `.env.example`** — все переменные §4.5 со значениями по умолчанию, `AIGW_API_KEY` закомментирован.
- [ ] **Step 5: Проверить конфигурацию**: `docker compose config -q` — без ошибок. Если Docker на Mac доступен: `docker buildx build --platform linux/amd64 -t ai-gateway:test .` — сборка проходит (рантайм с GPU на Mac не проверяется).
- [ ] **Step 6: `README.md`** (на русском): назначение и эндпоинты; запуск на Mac (Task 6 Step 6); развёртывание на Windows — Docker Desktop с WSL2-бэкендом, драйвер NVIDIA, проверка `docker run --rm --gpus all nvidia/cuda:<тег base> nvidia-smi`, `copy .env.example .env`, `docker compose up -d --build`; пример вызова через OpenAI SDK (`base_url="http://<host>:8000/v1"`, `model="whisper-1"`) и curl; описание `models.yaml` и TTL; **чек-лист GPU** из спецификации §7.6: `docker compose exec gateway nvidia-smi` видит карту; первый запрос — в логе `Устройство: cuda, compute_type: float16` и время загрузки; повторный запрос заметно быстрее; после TTL — `Модель … выгружена` и падение памяти в `nvidia-smi`.
- [ ] **Step 7: Финальная проверка**: `poetry run pytest -v` и `poetry run ruff check . && poetry run ruff format --check .` — всё зелёное; сверить команды в `CLAUDE.md` с реальными.
- [ ] **Step 8: Commit** — `chore: Dockerfile, docker-compose и README для развёртывания на Windows + NVIDIA`

---

## Ручная приёмка на целевой машине (после Task 7, выполняет пользователь)

Критерии успеха §1 спецификации: `docker compose up` на Windows видит GPU; OpenAI SDK с `model="whisper-1"` возвращает текст; модель выгружается после TTL (лог + `nvidia-smi`).
