"""Opus/WebM для плеера в истории — через PyAV; типы `av` наружу не выходят."""

from pathlib import Path

import av

SAMPLE_RATE = 48_000
BITRATE = 32_000


def encode_opus(src: Path, dst: Path, *, bitrate: int = BITRATE) -> int:
    """Первая аудиодорожка `src` → моно 48 кГц, libopus, WebM; возвращает размер файла.

    Блокирующая (CPU): вызывать через `run_blocking`. Нет аудиодорожки или файл не
    декодируется — исключение PyAV / `ValueError`; недописанный `dst` удаляется.
    """
    try:
        with av.open(str(src)) as source, av.open(str(dst), "w", format="webm") as target:
            if not source.streams.audio:
                raise ValueError("В файле нет аудиодорожки")
            in_stream = source.streams.audio[0]
            out_stream = target.add_stream("libopus", rate=SAMPLE_RATE, layout="mono")
            out_stream.bit_rate = bitrate
            resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
            for frame in source.decode(in_stream):
                for resampled in resampler.resample(frame):
                    target.mux(out_stream.encode(resampled))
            for resampled in resampler.resample(None):
                target.mux(out_stream.encode(resampled))
            target.mux(out_stream.encode(None))
    except BaseException:
        dst.unlink(missing_ok=True)
        raise
    return dst.stat().st_size
