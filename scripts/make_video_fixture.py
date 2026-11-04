"""Видео-фикстура для e2e Web UI: `tests/fixtures/hello.wav` → `web/e2e/fixtures/hello.mp4`.

Видео — шум mpeg4 (чтобы файл был больше лимита 1 МиБ в e2e), аудио — речь из hello.wav в AAC.
Запуск: `uv run python scripts/make_video_fixture.py`.
"""

from fractions import Fraction
from pathlib import Path

import av
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "tests" / "fixtures" / "hello.wav"
TARGET = ROOT / "web" / "e2e" / "fixtures" / "hello.mp4"
FPS = 25
WIDTH, HEIGHT = 400, 300


def main() -> None:
    rng = np.random.default_rng(1)
    with av.open(str(SOURCE)) as src:
        frames = list(src.decode(audio=0))
    duration = sum(f.samples for f in frames) / frames[0].sample_rate

    TARGET.parent.mkdir(parents=True, exist_ok=True)
    with av.open(str(TARGET), "w", format="mp4") as out:
        video = out.add_stream("mpeg4", rate=FPS)
        video.width, video.height, video.pix_fmt = WIDTH, HEIGHT, "yuv420p"
        # шум плохо сжимается: небольшой ролик получается больше мегабайта
        video.options = {"qscale": "2", "g": "1"}
        audio = out.add_stream("aac", rate=16000)
        audio.layout = "mono"
        for i in range(int(duration * FPS) + 1):
            image = rng.integers(0, 256, (HEIGHT, WIDTH, 3), dtype=np.uint8)
            frame = av.VideoFrame.from_ndarray(image, format="rgb24")
            frame.pts = i
            frame.time_base = Fraction(1, FPS)
            for packet in video.encode(frame):
                out.mux(packet)
        resampler = av.AudioResampler(format="fltp", layout="mono", rate=16000)
        for source_frame in frames:
            source_frame.pts = None
            for resampled in resampler.resample(source_frame):
                for packet in audio.encode(resampled):
                    out.mux(packet)
        for packet in [*video.encode(None), *audio.encode(None)]:
            out.mux(packet)
    size_mib = TARGET.stat().st_size / 1024 / 1024
    print(f"{TARGET.relative_to(ROOT)}: {size_mib:.2f} МиБ, {duration:.1f} с")


if __name__ == "__main__":
    main()
