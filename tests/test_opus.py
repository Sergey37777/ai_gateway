"""Кодирование аудио истории в Opus/WebM (настоящий PyAV, без моделей)."""

from pathlib import Path

import av
import pytest

from ai_gateway.backends.opus import encode_opus

HELLO = Path(__file__).parent / "fixtures" / "hello.wav"


def _duration(path: Path) -> float:
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        assert stream.codec_context.name == "opus"
        return float(container.duration or 0) / av.time_base


def test_encode_opus_hello(tmp_path):
    dst = tmp_path / "x.webm"
    size = encode_opus(HELLO, dst)
    assert size == dst.stat().st_size > 0
    assert abs(_duration(dst) - _duration_source()) < 0.1


def _duration_source() -> float:
    with av.open(str(HELLO)) as container:
        return float(container.duration or 0) / av.time_base


def test_encode_opus_rejects_garbage(tmp_path):
    src = tmp_path / "junk.wav"
    src.write_bytes(b"not audio at all" * 100)
    with pytest.raises(Exception):  # noqa: B017 — PyAV бросает свои ошибки декодирования
        encode_opus(src, tmp_path / "x.webm")
