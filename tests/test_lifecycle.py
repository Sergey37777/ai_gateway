import asyncio
import threading

import pytest

from ai_gateway.errors import GatewayError
from ai_gateway.lifecycle import ModelManager, ModelStatus, run_blocking
from ai_gateway.registry import WhisperSpec
from tests.fakes import FakeClock, FakeTranscriptionBackend, spec


def make_manager(
    *specs: WhisperSpec,
    backend: FakeTranscriptionBackend | None = None,
    backends: dict[str, FakeTranscriptionBackend] | None = None,
) -> tuple[ModelManager, FakeTranscriptionBackend, FakeClock]:
    clock = FakeClock()
    single = backend or FakeTranscriptionBackend()
    by_name = backends or {}
    manager = ModelManager(
        specs or [spec()],
        lambda s: by_name.get(s.name, single),
        clock=clock,
    )
    return manager, single, clock


async def _ticks(n: int = 5) -> None:
    for _ in range(n):
        await asyncio.sleep(0)


async def test_lazy_load():
    manager, backend, _ = make_manager()
    assert backend.load_calls == 0
    assert manager.status()[0].loaded is False
    async with manager.acquire("m") as b:
        assert b is backend
    assert backend.load_calls == 1
    assert manager.status()[0].loaded is True


async def test_second_acquire_reuses_loaded_model():
    manager, backend, _ = make_manager()
    async with manager.acquire("m"):
        pass
    async with manager.acquire("m"):
        pass
    assert backend.load_calls == 1


async def test_concurrent_acquire_loads_once():
    gate = threading.Event()
    manager, backend, _ = make_manager(
        spec(max_concurrency=5), backend=FakeTranscriptionBackend(load_gate=gate)
    )

    async def use() -> None:
        async with manager.acquire("m"):
            await asyncio.sleep(0)

    tasks = [asyncio.create_task(use()) for _ in range(5)]
    await asyncio.sleep(0.05)
    assert manager.status()[0].active == 5
    gate.set()
    await asyncio.wait_for(asyncio.gather(*tasks), timeout=5)
    assert backend.load_calls == 1


async def test_sweep_unloads_after_ttl():
    manager, backend, clock = make_manager(spec(ttl=600))
    async with manager.acquire("m"):
        pass
    clock.advance(600)
    assert await manager.sweep() == []
    clock.advance(1)
    assert await manager.sweep() == ["m"]
    assert backend.unload_calls == 1
    assert manager.status()[0] == ModelStatus("m", False, 0, None)


async def test_reload_after_sweep():
    manager, backend, clock = make_manager(spec(ttl=10))
    async with manager.acquire("m"):
        pass
    clock.advance(11)
    await manager.sweep()
    async with manager.acquire("m"):
        pass
    assert backend.load_calls == 2


async def test_ttl_zero_unloads_immediately():
    manager, backend, _ = make_manager(spec(ttl=0))
    async with manager.acquire("m"):
        assert backend.loaded is True
    assert backend.loaded is False
    assert backend.unload_calls == 1


async def test_ttl_minus_one_never_unloads():
    manager, backend, clock = make_manager(spec(ttl=-1))
    async with manager.acquire("m"):
        pass
    clock.advance(10**6)
    assert await manager.sweep() == []
    assert backend.loaded is True


async def test_active_model_not_unloaded():
    manager, backend, clock = make_manager(spec(ttl=600))
    async with manager.acquire("m"):
        clock.advance(10**6)
        assert await manager.sweep() == []
        assert backend.loaded is True


@pytest.mark.parametrize(("max_concurrency", "both_inside"), [(1, False), (2, True)])
async def test_semaphore_limits_concurrency(max_concurrency, both_inside):
    manager, _, _ = make_manager(spec(max_concurrency=max_concurrency))
    release = asyncio.Event()
    inside = 0
    peak = 0

    async def use() -> None:
        nonlocal inside, peak
        async with manager.acquire("m"):
            inside += 1
            peak = max(peak, inside)
            await release.wait()
            inside -= 1

    tasks = [asyncio.create_task(use()) for _ in range(2)]
    await asyncio.sleep(0.05)
    assert (inside == 2) is both_inside
    assert manager.status()[0].active == 2
    release.set()
    await asyncio.wait_for(asyncio.gather(*tasks), timeout=5)
    assert peak == max_concurrency


async def test_load_error_is_503_and_retryable():
    backend = FakeTranscriptionBackend(
        load_error=RuntimeError("CUDA failed with error out of memory")
    )
    manager, _, _ = make_manager(backend=backend)
    with pytest.raises(GatewayError) as e:
        async with manager.acquire("m"):
            pytest.fail("тело не должно выполняться")
    assert (e.value.status_code, e.value.code) == (503, "model_unavailable")
    assert e.value.headers == {"Retry-After": "30"}
    assert "out of memory" in e.value.message
    assert manager.status()[0] == ModelStatus("m", False, 0, None)

    backend.load_error = None
    async with manager.acquire("m"):
        pass
    assert manager.status()[0].loaded is True


async def test_cancelled_acquire_releases_slot():
    manager, _, clock = make_manager(spec(ttl=600, max_concurrency=1))
    release = asyncio.Event()
    a_inside = asyncio.Event()
    b_inside = False

    async def holder() -> None:
        async with manager.acquire("m"):
            a_inside.set()
            await release.wait()

    async def waiter() -> None:
        nonlocal b_inside
        async with manager.acquire("m"):
            b_inside = True

    a = asyncio.create_task(holder())
    await a_inside.wait()
    b = asyncio.create_task(waiter())
    await _ticks()
    assert manager.status()[0].active == 2

    b.cancel()
    with pytest.raises(asyncio.CancelledError):
        await b
    release.set()
    await a

    assert b_inside is False
    assert manager.status()[0].active == 0
    clock.advance(601)
    assert await manager.sweep() == ["m"]


async def test_cancelled_during_load_releases_slot():
    gate = threading.Event()
    backend = FakeTranscriptionBackend(load_gate=gate)
    manager, _, _ = make_manager(spec(ttl=600), backend=backend)

    async def use() -> None:
        async with manager.acquire("m"):
            pass

    task = asyncio.create_task(use())
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert manager.status()[0].active == 0

    # следующий запрос дожидается уже идущей загрузки, а не начинает вторую
    second = asyncio.create_task(use())
    await asyncio.sleep(0.05)
    gate.set()
    await asyncio.wait_for(second, timeout=5)
    assert backend.load_calls == 1
    assert backend.loaded is True


async def test_ttl_zero_cancelled_during_load_unloaded_by_sweep():
    gate = threading.Event()
    backend = FakeTranscriptionBackend(load_gate=gate)
    manager, _, _ = make_manager(spec(ttl=0), backend=backend)

    async def use() -> None:
        async with manager.acquire("m"):
            pass

    task = asyncio.create_task(use())
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    gate.set()
    assert await asyncio.to_thread(backend.load_done.wait, 5)
    # загрузка завершилась уже после отмены: выгрузить модель некому, кроме sweep
    assert await manager.sweep() == ["m"]
    assert backend.loaded is False


async def test_run_blocking_holds_slot_until_thread_finishes():
    manager, _, _ = make_manager(spec(max_concurrency=1))
    gate = threading.Event()
    in_thread = threading.Event()

    def blocking() -> str:
        in_thread.set()
        gate.wait(timeout=5)
        return "done"

    async def use() -> None:
        async with manager.acquire("m"):
            await run_blocking(blocking)

    task = asyncio.create_task(use())
    await asyncio.to_thread(in_thread.wait, 5)
    task.cancel()
    await _ticks()
    # поток инференса не прервать: слот и семафор заняты, пока он работает
    assert not task.done()
    assert manager.status()[0].active == 1
    gate.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, timeout=5)
    assert manager.status()[0].active == 0


async def test_run_blocking_returns_result_and_raises():
    assert await run_blocking(lambda: 42) == 42

    def boom() -> None:
        raise ValueError("boom")

    with pytest.raises(ValueError, match="boom"):
        await run_blocking(boom)


async def test_status_idle_seconds():
    manager, _, clock = make_manager()
    assert manager.status()[0].idle_seconds is None
    async with manager.acquire("m"):
        pass
    clock.advance(15)
    assert manager.status()[0].idle_seconds == 15.0


async def test_status_idle_zero_while_active():
    manager, _, clock = make_manager()
    clock.advance(100)
    async with manager.acquire("m"):
        assert manager.status()[0].idle_seconds == 0.0
        clock.advance(5)
        assert manager.status()[0].idle_seconds == 0.0
    clock.advance(3)
    assert manager.status()[0].idle_seconds == 3.0


async def test_shutdown_unloads_all():
    a, b = FakeTranscriptionBackend(), FakeTranscriptionBackend()
    manager, _, _ = make_manager(spec("a"), spec("b"), backends={"a": a, "b": b})
    async with manager.acquire("a"), manager.acquire("b"):
        pass
    await manager.shutdown()
    assert (a.loaded, b.loaded) == (False, False)
    assert [s.loaded for s in manager.status()] == [False, False]


async def test_unknown_name_raises_404():
    manager, _, _ = make_manager()
    with pytest.raises(GatewayError) as e:
        async with manager.acquire("nope"):
            pass
    assert (e.value.status_code, e.value.code) == (404, "model_not_found")


async def test_run_sweeper_survives_errors(monkeypatch):
    manager, _, _ = make_manager()
    calls = 0

    async def flaky_sweep() -> list[str]:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("boom")
        return []

    monkeypatch.setattr(manager, "sweep", flaky_sweep)
    task = asyncio.create_task(manager.run_sweeper(0.001))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert calls >= 2
