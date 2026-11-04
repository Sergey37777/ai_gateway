"""Исполнитель распознаваний и фоновый воркер (этап 4).

`TranscriptionService.execute()` — единый путь для фоновых задач (их по одной берёт `Worker`)
и синхронного `/v1/audio/transcriptions` (`run_sync`, сразу, под `asyncio.shield`). Ход и флаг
отмены живут в памяти процесса: процесс один (uvicorn с одним воркером), писать прогресс
в БД незачем.
"""

import asyncio
import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from loguru import logger
from starlette.datastructures import UploadFile

from ai_gateway.backends.base import (
    TranscriptionBackend,
    TranscriptionCancelled,
    TranscriptionHooks,
    TranscriptionOptions,
    TranscriptionResult,
)
from ai_gateway.backends.opus import encode_opus
from ai_gateway.errors import (
    GatewayError,
    internal_error,
    invalid_state,
    model_unavailable,
    transcription_cancelled,
    transcription_not_found,
)
from ai_gateway.files import DataDir
from ai_gateway.languages import LANGUAGES
from ai_gateway.lifecycle import ModelManager, run_blocking
from ai_gateway.registry import ModelRegistry
from ai_gateway.store import (
    NewTranscription,
    Source,
    TranscriptionParams,
    TranscriptionRecord,
    TranscriptionStore,
)

# признаки нехватки памяти GPU в ошибках CTranslate2 / cuBLAS / cuDNN
_OOM_MARKERS = ("out of memory", "alloc_failed")
DELETE_WAIT = 30.0
WORKER_IDLE = 30.0
WORKER_ERROR_PAUSE = 5.0

# исход execute: результат, ошибка для клиента синхронного запроса или None (отменено)
Outcome = TranscriptionResult | GatewayError | None


def _bad_param(param: str, message: str) -> GatewayError:
    return GatewayError(400, "invalid_request_error", message, param=param)


def _is_gpu_oom(exc: RuntimeError) -> bool:
    text = str(exc).lower()
    return any(marker in text for marker in _OOM_MARKERS)


def prepare_params(
    registry: ModelRegistry,
    manager: ModelManager,
    *,
    model: str,
    language: str | None,
    prompt: str | None,
    temperature: float,
    word_timestamps: bool,
) -> TranscriptionParams:
    """Проверки до чтения файла: не-речевая модель не должна попадать в VRAM."""
    if language and language not in LANGUAGES:
        raise _bad_param("language", f"Неизвестный код языка '{language}'")
    spec = registry.resolve(model, "transcription")
    if not isinstance(manager.backend(spec.name), TranscriptionBackend):
        raise _bad_param("model", f"Модель '{spec.name}' не распознаёт речь")
    return TranscriptionParams(
        model=spec.name,
        language=language or None,
        prompt=prompt or None,
        temperature=temperature,
        word_timestamps=word_timestamps,
    )


@dataclass
class RunState:
    """Выполняющееся распознавание: ход (пишет поток инференса) и флаг остановки."""

    progress: float = 0.0
    stop: threading.Event = field(default_factory=threading.Event)
    done: asyncio.Event = field(default_factory=asyncio.Event)


class TranscriptionService:
    def __init__(
        self,
        store: TranscriptionStore,
        manager: ModelManager,
        files: DataDir,
        *,
        max_upload_mb: int,
        encode: Callable[[Path, Path], int] = encode_opus,
    ) -> None:
        self._store = store
        self._manager = manager
        self._files = files
        self._max_upload_mb = max_upload_mb
        self._encode = encode
        self._runs: dict[uuid.UUID, RunState] = {}
        self._wake = asyncio.Event()
        # синхронные распознавания доживают после обрыва соединения клиента
        self._detached: set[asyncio.Task[Outcome]] = set()

    # --- приём ---------------------------------------------------------------------------

    async def _accept(
        self,
        upload: UploadFile,
        params: TranscriptionParams,
        *,
        title: str | None,
        source: Source,
        status: str,
    ) -> TranscriptionRecord:
        tid = uuid.uuid4()
        filename = upload.filename or "audio"
        rel = self._files.upload_rel(tid, filename)
        await self._files.save_upload(upload, rel, max_upload_mb=self._max_upload_mb)
        try:
            return await self._store.create(
                NewTranscription(
                    id=tid,
                    status="running" if status == "running" else "queued",
                    source=source,
                    title=title or filename,
                    filename=filename,
                    params=params,
                    upload_path=rel,
                )
            )
        except BaseException:
            self._files.remove(rel)
            raise

    async def submit(
        self,
        upload: UploadFile,
        params: TranscriptionParams,
        *,
        title: str | None,
        source: Source = "ui",
    ) -> TranscriptionRecord:
        """Фоновое распознавание: запись `queued`, воркер возьмёт её в свою очередь."""
        record = await self._accept(upload, params, title=title, source=source, status="queued")
        self.wake()
        return record

    async def run_sync(
        self, upload: UploadFile, params: TranscriptionParams
    ) -> TranscriptionResult:
        """Синхронное распознавание (`/v1/audio/transcriptions`): сразу, с записью в историю."""
        record = await self._accept(upload, params, title=None, source="api", status="running")
        task = asyncio.create_task(self.execute(record))
        self._detached.add(task)
        task.add_done_callback(self._detached.discard)
        # обрыв соединения отменяет только ожидание: работа доводится и сохраняется
        outcome = await asyncio.shield(task)
        if outcome is None:
            raise transcription_cancelled()
        if isinstance(outcome, GatewayError):
            raise outcome
        return outcome

    # --- исполнение ----------------------------------------------------------------------

    async def execute(self, record: TranscriptionRecord) -> Outcome:
        """Распознаёт запись `running`; итог — в хранилище, `RunState` живёт до конца."""
        state = RunState()
        self._runs[record.id] = state
        try:
            return await self._execute(record, state)
        finally:
            self._runs.pop(record.id, None)
            state.done.set()

    async def _fail(self, record: TranscriptionRecord, error: GatewayError) -> GatewayError:
        await self._store.fail(record.id, error.code, error.message)
        return error

    async def _execute(self, record: TranscriptionRecord, state: RunState) -> Outcome:
        path = None if record.upload_path is None else self._files.resolve(record.upload_path)
        if path is None or not path.exists():
            return await self._fail(
                record, GatewayError(400, "upload_missing", "Файл загрузки не найден")
            )
        params = record.params
        options = TranscriptionOptions(
            language=params.language,
            prompt=params.prompt,
            temperature=params.temperature,
            word_timestamps=params.word_timestamps,
        )

        def on_progress(fraction: float) -> None:
            state.progress = fraction  # из потока инференса; присваивание float атомарно

        hooks = TranscriptionHooks(on_progress=on_progress, should_stop=state.stop.is_set)
        try:
            async with self._manager.acquire(params.model) as backend:
                # отменили, пока ждали модель (её держала другая задача) — инференс не нужен
                if state.stop.is_set():
                    raise TranscriptionCancelled
                if not isinstance(backend, TranscriptionBackend):
                    raise _bad_param("model", f"Модель '{params.model}' не распознаёт речь")
                result = await run_blocking(backend.transcribe, path, options, hooks)
        except TranscriptionCancelled:
            await self._store.cancel(record.id)
            return None
        except GatewayError as exc:
            return await self._fail(record, exc)
        except RuntimeError as exc:
            if _is_gpu_oom(exc):
                return await self._fail(
                    record, model_unavailable(f"Модели {params.model} не хватило памяти: {exc}")
                )
            logger.exception("Ошибка распознавания {}", record.id)
            return await self._fail(record, internal_error())
        except Exception:
            logger.exception("Ошибка распознавания {}", record.id)
            return await self._fail(record, internal_error())

        audio_rel: str | None = self._files.audio_rel(record.id)
        audio_bytes: int | None = None
        try:
            audio_bytes = await run_blocking(
                self._encode, path, self._files.resolve(self._files.audio_rel(record.id))
            )
        except Exception as exc:  # плеер в истории — не повод терять расшифровку
            logger.warning("Не удалось сохранить аудио {}: {}", record.id, exc)
            audio_rel = None
        await self._store.finish(record.id, result, audio_rel, audio_bytes)
        self._files.remove(record.upload_path)
        logger.info(
            "Распознано: модель={}, аудио={:.1f} с, запись={}",
            params.model,
            result.duration,
            record.id,
        )
        return result

    # --- управление ----------------------------------------------------------------------

    async def _get(self, tid: uuid.UUID) -> TranscriptionRecord:
        record = await self._store.get(tid)
        if record is None:
            raise transcription_not_found(tid)
        return record

    async def cancel(self, tid: uuid.UUID) -> TranscriptionRecord:
        """`queued` — отменяется сразу; `running` — флаг остановки, статус выставит execute."""
        record = await self._get(tid)
        if record.status == "queued":
            await self._store.cancel(tid)
            return await self._get(tid)
        if record.status != "running":
            raise invalid_state("Распознавание уже завершено")
        state = self._runs.get(tid)
        if state is None:
            # running без исполнителя в этом процессе (не должно случаться после recover)
            await self._store.cancel(tid)
            return await self._get(tid)
        state.stop.set()
        return record

    async def retry(self, tid: uuid.UUID) -> TranscriptionRecord:
        await self._get(tid)
        record = await self._store.requeue(tid)
        if record is None:
            raise invalid_state("Повторить можно только упавшее или отменённое распознавание")
        self.wake()
        return record

    async def delete(self, tid: uuid.UUID) -> None:
        """Удаляет запись и её файлы; выполняющуюся сначала останавливает."""
        await self._get(tid)
        state = self._runs.get(tid)
        if state is not None:
            state.stop.set()
            try:
                async with asyncio.timeout(DELETE_WAIT):
                    await state.done.wait()
            except TimeoutError as exc:
                raise invalid_state("Распознавание ещё останавливается, повторите позже") from exc
        deleted = await self._store.delete(tid)
        if deleted is not None:
            self._files.remove(deleted.upload_path)
            self._files.remove(deleted.audio_path)
            if deleted.audio_path is None:
                # аудио могло записаться, пока шла остановка
                self._files.remove(self._files.audio_rel(tid))

    def progress(self, record: TranscriptionRecord) -> float | None:
        if record.status == "done":
            return 1.0
        if record.status == "queued":
            return 0.0
        if record.status == "running":
            state = self._runs.get(record.id)
            return 0.0 if state is None else state.progress
        return None

    def wake(self) -> None:
        self._wake.set()

    async def wait_for_work(self, seconds: float) -> None:
        """Ждёт `wake()` (новая или повторённая задача) не дольше `seconds` секунд."""
        try:
            async with asyncio.timeout(seconds):
                await self._wake.wait()
        except TimeoutError:
            pass
        self._wake.clear()

    async def recover(self) -> None:
        """Старт: прерванные рестартом задачи — обратно в очередь, файлы-сироты — удалить."""
        requeued = await self._store.requeue_running()
        removed = self._files.remove_orphans(await self._store.file_paths())
        if requeued or removed:
            logger.info("Восстановление: в очередь {}, удалено файлов {}", requeued, removed)


class Worker:
    """Фоновая задача lifespan: берёт `queued` по одной (FIFO) и исполняет."""

    def __init__(
        self,
        service: TranscriptionService,
        store: TranscriptionStore,
        *,
        idle_timeout: float = WORKER_IDLE,
        error_pause: float = WORKER_ERROR_PAUSE,
    ) -> None:
        self._service = service
        self._store = store
        self._idle_timeout = idle_timeout
        self._error_pause = error_pause

    async def run(self) -> None:
        while True:
            try:
                record = await self._store.claim_next()
            except Exception:
                logger.exception("Воркер: не удалось взять задачу из очереди")
                await asyncio.sleep(self._error_pause)
                continue
            if record is None:
                await self._service.wait_for_work(self._idle_timeout)
                continue
            try:
                await self._service.execute(record)
            except Exception:
                # например, БД пропала на finish: запись останется running до рестарта
                logger.exception("Воркер: ошибка исполнения {}", record.id)
