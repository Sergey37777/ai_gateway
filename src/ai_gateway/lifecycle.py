"""ModelManager — единственное место, которое управляет памятью моделей (VRAM).

Ленивая загрузка под per-model lock, семафор `max_concurrency` на модель,
выгрузка по TTL простоя фоновой задачей (`-1` — никогда, `0` — сразу после запроса).
"""

import asyncio
import time
from collections.abc import AsyncIterator, Callable, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from loguru import logger

from ai_gateway.backends.base import LoadableBackend
from ai_gateway.errors import GatewayError, model_unavailable
from ai_gateway.registry import ModelSpec


async def run_blocking[**P, T](func: Callable[P, T], /, *args: P.args, **kwargs: P.kwargs) -> T:
    """`asyncio.to_thread`, который при отмене дожидается завершения потока.

    Поток (инференс) прервать нельзя. Если отпустить вызывающего сразу, `acquire` освободит
    семафор и слот, а с `ttl=0` — выгрузит модель, хотя поток ещё держит её в памяти:
    следующий запрос загрузил бы вторую копию. Отмена пробрасывается после завершения потока.
    """
    future = asyncio.ensure_future(asyncio.to_thread(func, *args, **kwargs))
    cancelled = False
    while not future.done():
        try:
            await asyncio.wait({future})
        except asyncio.CancelledError:
            cancelled = True
    if cancelled:
        if not future.cancelled():
            future.exception()  # результат потока уже не нужен; исключение забрано
        raise asyncio.CancelledError
    return future.result()


@dataclass(frozen=True)
class ModelStatus:
    """Состояние модели для `/health`; `idle_seconds=None`, если модель не загружена."""

    name: str
    loaded: bool
    active: int
    idle_seconds: float | None


@dataclass
class _Slot:
    spec: ModelSpec
    backend: LoadableBackend
    semaphore: asyncio.Semaphore
    active: int = 0
    last_used: float = 0.0
    load_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    # загрузка идёт отдельной задачей: отмена одного запроса не прерывает её
    # и не даёт второму запросу начать параллельную загрузку тех же весов
    load_task: "asyncio.Task[None] | None" = None


class ModelManager:
    """Загрузка, конкурентный доступ и выгрузка моделей по TTL."""

    def __init__(
        self,
        specs: Iterable[ModelSpec],
        backend_factory: Callable[[ModelSpec], LoadableBackend],
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._clock = clock
        self._slots: dict[str, _Slot] = {
            s.name: _Slot(
                spec=s,
                backend=backend_factory(s),
                semaphore=asyncio.Semaphore(s.max_concurrency),
            )
            for s in specs
        }

    def _slot(self, name: str) -> _Slot:
        slot = self._slots.get(name)
        if slot is None:
            raise GatewayError(404, "model_not_found", f"Модель '{name}' не найдена", param="model")
        return slot

    def backend(self, name: str) -> LoadableBackend:
        """Бэкенд модели без загрузки весов — например, чтобы проверить его тип."""
        return self._slot(name).backend

    @asynccontextmanager
    async def acquire(self, name: str) -> AsyncIterator[LoadableBackend]:
        """Загружает модель при необходимости и выдаёт бэкенд под семафором модели."""
        slot = self._slot(name)
        # счётчик растёт до ожидания загрузки и семафора, чтобы sweep не выгрузил
        # модель, которую ждёт очередь
        slot.active += 1
        try:
            await self._ensure_loaded(slot)
            async with slot.semaphore:
                yield slot.backend
        finally:
            slot.active -= 1
            slot.last_used = self._clock()
            if slot.spec.ttl == 0 and slot.active == 0:
                async with slot.load_lock:
                    if slot.active == 0 and slot.backend.loaded:
                        await self._unload(slot)

    async def _ensure_loaded(self, slot: _Slot) -> None:
        async with slot.load_lock:
            if slot.backend.loaded:
                return
            if slot.load_task is None or slot.load_task.done():
                slot.load_task = asyncio.create_task(self._load(slot))
                # исключение забирается всегда, даже если все ожидающие отменены
                slot.load_task.add_done_callback(lambda t: t.cancelled() or t.exception())
            task = slot.load_task
        await asyncio.shield(task)

    async def _load(self, slot: _Slot) -> None:
        name = slot.spec.name
        started = time.perf_counter()
        try:
            await asyncio.to_thread(slot.backend.load)
        except Exception as exc:
            logger.error("Не удалось загрузить модель {}: {}", name, exc)
            raise model_unavailable(f"Не удалось загрузить модель {name}: {exc}") from exc
        logger.info("Модель {} загружена за {:.1f} с", name, time.perf_counter() - started)

    async def _unload(self, slot: _Slot) -> None:
        idle = self._clock() - slot.last_used
        await asyncio.to_thread(slot.backend.unload)
        logger.info("Модель {} выгружена (простой {:.0f} с)", slot.spec.name, idle)

    def _expired(self, slot: _Slot) -> bool:
        ttl = slot.spec.ttl
        if not slot.backend.loaded or slot.active > 0 or ttl < 0:
            return False
        # ttl=0: обычно выгружается в acquire; сюда попадает модель, догрузившаяся
        # уже после отмены запроса
        return ttl == 0 or self._clock() - slot.last_used > ttl

    async def sweep(self) -> list[str]:
        """Выгружает модели, простаивающие дольше TTL; возвращает их имена."""
        unloaded: list[str] = []
        for name, slot in self._slots.items():
            if not self._expired(slot):
                continue
            async with slot.load_lock:
                if self._expired(slot):
                    await self._unload(slot)
                    unloaded.append(name)
        return unloaded

    async def run_sweeper(self, interval: float) -> None:
        """Бесконечный цикл `sleep → sweep`; ошибки логируются и не останавливают цикл."""
        while True:
            await asyncio.sleep(interval)
            try:
                await self.sweep()
            except Exception:
                logger.exception("Ошибка фоновой выгрузки моделей")

    def status(self) -> list[ModelStatus]:
        """Состояние всех моделей реестра."""
        now = self._clock()
        return [
            ModelStatus(
                name=name,
                loaded=slot.backend.loaded,
                active=slot.active,
                idle_seconds=self._idle_seconds(slot, now),
            )
            for name, slot in self._slots.items()
        ]

    @staticmethod
    def _idle_seconds(slot: _Slot, now: float) -> float | None:
        if not slot.backend.loaded:
            return None
        # пока идут запросы, модель не простаивает
        return 0.0 if slot.active > 0 else now - slot.last_used

    async def shutdown(self) -> None:
        """Выгружает все модели при остановке сервиса."""
        for slot in self._slots.values():
            async with slot.load_lock:
                if slot.backend.loaded:
                    await self._unload(slot)
