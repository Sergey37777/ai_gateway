"""Форматирование результата распознавания в ответы OpenAI (json/text/verbose_json/srt/vtt)."""

from dataclasses import asdict
from typing import Literal, get_args

from starlette.responses import JSONResponse, PlainTextResponse, Response

from ai_gateway.backends.base import TranscriptionResult
from ai_gateway.languages import language_name

ResponseFormat = Literal["json", "text", "verbose_json", "srt", "vtt"]
RESPONSE_FORMATS: frozenset[str] = frozenset(get_args(ResponseFormat))


def format_timestamp(seconds: float, *, decimal_marker: str) -> str:
    """`HH:MM:SS{marker}mmm` с округлением до ближайшей миллисекунды."""
    total_ms = round(seconds * 1000)
    hours, rest = divmod(total_ms, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs, ms = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{decimal_marker}{ms:03d}"


def _srt(result: TranscriptionResult) -> str:
    blocks = [
        f"{i}\n{format_timestamp(s.start, decimal_marker=',')} --> "
        f"{format_timestamp(s.end, decimal_marker=',')}\n{s.text.strip()}\n"
        for i, s in enumerate(result.segments, start=1)
    ]
    return "\n".join(blocks)


def _vtt(result: TranscriptionResult) -> str:
    blocks = [
        f"{format_timestamp(s.start, decimal_marker='.')} --> "
        f"{format_timestamp(s.end, decimal_marker='.')}\n{s.text.strip()}\n"
        for s in result.segments
    ]
    return "WEBVTT\n\n" + "\n".join(blocks)


def _verbose(result: TranscriptionResult, include_words: bool) -> dict[str, object]:
    body: dict[str, object] = {
        "task": "transcribe",
        "language": language_name(result.language),
        "duration": result.duration,
        "text": result.text,
        "segments": [asdict(s) for s in result.segments],
    }
    if include_words and result.words is not None:
        body["words"] = [asdict(w) for w in result.words]
    return body


def render(
    result: TranscriptionResult, fmt: ResponseFormat, *, include_words: bool = False
) -> Response:
    """HTTP-ответ в запрошенном формате."""
    match fmt:
        case "json":
            return JSONResponse({"text": result.text})
        case "text":
            return PlainTextResponse(result.text)
        case "verbose_json":
            return JSONResponse(_verbose(result, include_words))
        case "srt":
            return PlainTextResponse(_srt(result))
        case "vtt":
            return PlainTextResponse(_vtt(result))
