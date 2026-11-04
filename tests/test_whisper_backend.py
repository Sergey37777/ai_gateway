from pathlib import Path
from types import SimpleNamespace
from typing import Any

import av
import pytest

from ai_gateway.backends import build_backend
from ai_gateway.backends import whisper as whisper_module
from ai_gateway.backends.base import TranscriptionBackend, TranscriptionOptions
from ai_gateway.backends.whisper import WhisperBackend
from ai_gateway.errors import GatewayError
from tests.fakes import spec


def _word(word: str, start: float, end: float) -> SimpleNamespace:
    return SimpleNamespace(word=word, start=start, end=end, probability=0.9)


def _seg(id_: int, start: float, end: float, text: str, words: list[Any]) -> SimpleNamespace:
    return SimpleNamespace(
        id=id_,
        seek=id_ * 100,
        start=start,
        end=end,
        text=text,
        tokens=[50364 + id_, 2425],
        avg_logprob=-0.3,
        compression_ratio=1.2,
        no_speech_prob=0.05,
        words=words,
        temperature=None,
    )


class FakeWhisperModel:
    instances: list["FakeWhisperModel"] = []

    def __init__(self, model: str, **kwargs: Any) -> None:
        self.model = model
        self.init_kwargs = kwargs
        self.transcribe_kwargs: dict[str, Any] = {}
        self.error: Exception | None = None
        FakeWhisperModel.instances.append(self)

    def transcribe(self, audio: str, **kwargs: Any) -> tuple[Any, SimpleNamespace]:
        self.audio = audio
        self.transcribe_kwargs = kwargs
        error = self.error

        def segments() -> Any:
            # ошибка декодирования у faster-whisper всплывает при итерации генератора
            if error is not None:
                raise error
            yield _seg(0, 0.0, 1.0, " Hello", [_word(" Hello", 0.0, 1.0)])
            yield _seg(1, 1.0, 2.0, " world.", [_word(" world.", 1.0, 2.0)])

        return segments(), SimpleNamespace(language="en", duration=2.0)


@pytest.fixture(autouse=True)
def fake_model(monkeypatch):
    FakeWhisperModel.instances = []
    monkeypatch.setattr(whisper_module, "WhisperModel", FakeWhisperModel)


def _loaded(**kwargs: Any) -> WhisperBackend:
    backend = WhisperBackend("tiny", device="cpu", compute_type="int8", **kwargs)
    backend.load()
    return backend


def test_load_unload():
    backend = WhisperBackend("tiny", device="cpu", compute_type="int8", download_root="/c")
    assert backend.loaded is False
    backend.load()
    assert backend.loaded is True
    model = FakeWhisperModel.instances[0]
    assert model.model == "tiny"
    assert model.init_kwargs == {"device": "cpu", "compute_type": "int8", "download_root": "/c"}
    backend.unload()
    assert backend.loaded is False


def test_satisfies_protocol():
    assert isinstance(
        WhisperBackend("tiny", device="cpu", compute_type="int8"), TranscriptionBackend
    )


def test_build_backend_creates_whisper():
    backend = build_backend(spec(), device="cpu", compute_type="int8")
    assert isinstance(backend, WhisperBackend)
    assert backend.loaded is False
    assert FakeWhisperModel.instances == []


def test_transcribe_maps_result():
    result = _loaded().transcribe(Path("a.wav"), TranscriptionOptions())
    assert result.text == "Hello world."
    assert (result.language, result.duration) == ("en", 2.0)
    assert [s.id for s in result.segments] == [0, 1]
    assert result.segments[0].text == " Hello"
    assert result.segments[0].temperature == 0.0
    assert [(s.seek, s.tokens) for s in result.segments] == [
        (0, [50364, 2425]),
        (100, [50365, 2425]),
    ]
    assert result.words is None


def test_transcribe_words():
    result = _loaded().transcribe(Path("a.wav"), TranscriptionOptions(word_timestamps=True))
    assert result.words is not None
    assert [(w.word, w.start, w.end) for w in result.words] == [
        (" Hello", 0.0, 1.0),
        (" world.", 1.0, 2.0),
    ]


def test_transcribe_kwargs():
    backend = _loaded()
    backend.transcribe(Path("a.wav"), TranscriptionOptions("ru", "", 0.0, False))
    model = FakeWhisperModel.instances[0]
    assert model.audio == "a.wav"
    assert model.transcribe_kwargs == {
        "language": "ru",
        "initial_prompt": None,
        # temperature=0 — как у OpenAI: расписание с повышением при сбое порогов
        "temperature": (0.0, 0.2, 0.4, 0.6, 0.8, 1.0),
        "word_timestamps": False,
        "vad_filter": True,
    }


def test_transcribe_vad_from_config():
    backend = _loaded(vad_filter=False)
    backend.transcribe(Path("a.wav"), TranscriptionOptions(prompt="p"))
    kwargs = FakeWhisperModel.instances[0].transcribe_kwargs
    assert kwargs["vad_filter"] is False
    assert kwargs["initial_prompt"] == "p"
    assert kwargs["language"] is None


def test_transcribe_fixed_temperature():
    backend = _loaded()
    backend.transcribe(Path("a.wav"), TranscriptionOptions(temperature=0.4))
    assert FakeWhisperModel.instances[0].transcribe_kwargs["temperature"] == 0.4


def test_transcribe_not_loaded():
    with pytest.raises(RuntimeError):
        WhisperBackend("tiny", device="cpu", compute_type="int8").transcribe(
            Path("a.wav"), TranscriptionOptions()
        )


@pytest.mark.parametrize(
    "error",
    [av.error.InvalidDataError(1094995529, "Invalid data found"), IndexError("tuple index")],
)
def test_decode_error_is_invalid_audio(error):
    backend = _loaded()
    FakeWhisperModel.instances[0].error = error
    with pytest.raises(GatewayError) as e:
        backend.transcribe(Path("a.wav"), TranscriptionOptions())
    assert (e.value.status_code, e.value.code, e.value.param) == (400, "invalid_audio", "file")
