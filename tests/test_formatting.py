import json

import pytest
from faster_whisper import tokenizer as fw_tokenizer
from starlette.responses import Response

from ai_gateway.backends.base import Segment, TranscriptionResult, Word
from ai_gateway.formatting import format_timestamp, render
from ai_gateway.languages import LANGUAGES, language_name


def _segment(id_: int, start: float, end: float, text: str) -> Segment:
    return Segment(
        id=id_,
        start=start,
        end=end,
        text=text,
        avg_logprob=-0.2,
        compression_ratio=1.1,
        no_speech_prob=0.01,
        temperature=0.0,
    )


def _result(words: list[Word] | None = None) -> TranscriptionResult:
    return TranscriptionResult(
        text="Привет. Мир.",
        language="ru",
        duration=3661.5,
        segments=[_segment(0, 0.0, 1.5, " Привет."), _segment(1, 1.5, 3661.5, " Мир.")],
        words=words,
    )


def _text(response: Response) -> str:
    return bytes(response.body).decode()


WORDS = [Word(word=" Привет.", start=0.0, end=1.5), Word(word=" Мир.", start=1.5, end=3661.5)]


def test_format_timestamp():
    assert format_timestamp(3661.5, decimal_marker=",") == "01:01:01,500"
    assert format_timestamp(0.0004, decimal_marker=".") == "00:00:00.000"
    assert format_timestamp(1.9996, decimal_marker=",") == "00:00:02,000"


async def test_json():
    response = render(_result(), "json")
    assert json.loads(_text(response)) == {"text": "Привет. Мир."}
    assert response.media_type == "application/json"


async def test_text():
    response = render(_result(), "text")
    assert _text(response) == "Привет. Мир."
    assert response.media_type is not None
    assert response.media_type.startswith("text/plain")


async def test_srt():
    response = render(_result(), "srt")
    assert _text(response) == (
        "1\n00:00:00,000 --> 00:00:01,500\nПривет.\n\n2\n00:00:01,500 --> 01:01:01,500\nМир.\n"
    )
    assert response.media_type is not None
    assert response.media_type.startswith("text/plain")


async def test_vtt():
    response = render(_result(), "vtt")
    assert _text(response) == (
        "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nПривет.\n\n00:00:01.500 --> 01:01:01.500\nМир.\n"
    )


async def test_verbose_json_without_words():
    body = json.loads(_text(render(_result(WORDS), "verbose_json")))
    assert body["task"] == "transcribe"
    assert body["language"] == "russian"
    assert body["duration"] == 3661.5
    assert body["text"] == "Привет. Мир."
    assert len(body["segments"]) == 2
    assert set(body["segments"][0]) == {
        "id",
        "seek",
        "tokens",
        "start",
        "end",
        "text",
        "avg_logprob",
        "compression_ratio",
        "no_speech_prob",
        "temperature",
    }
    assert "words" not in body


async def test_verbose_json_with_words():
    body = json.loads(_text(render(_result(WORDS), "verbose_json", include_words=True)))
    assert body["words"] == [
        {"word": " Привет.", "start": 0.0, "end": 1.5},
        {"word": " Мир.", "start": 1.5, "end": 3661.5},
    ]


async def test_verbose_json_words_requested_but_missing():
    body = json.loads(_text(render(_result(None), "verbose_json", include_words=True)))
    assert "words" not in body


def test_language_name():
    assert language_name("ru") == "russian"
    assert language_name("yue") == "cantonese"
    assert language_name("zz") == "zz"


@pytest.mark.parametrize("code", ["en", "ru", "yue"])
def test_language_known(code):
    assert code in LANGUAGES


def test_languages_match_faster_whisper():
    # таблица должна совпадать с набором кодов, которые принимает faster-whisper
    assert set(LANGUAGES) == set(fw_tokenizer._LANGUAGE_CODES)
