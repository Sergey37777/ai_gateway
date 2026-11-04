"""Каталог данных шлюза (`AIGW_DATA_DIR`): загрузки `uploads/` и Opus-аудио истории `audio/`.

В БД хранятся пути относительно корня; `resolve` не выпускает путь за его пределы.
"""

import asyncio
import re
import uuid
from pathlib import Path

from starlette.datastructures import UploadFile

from ai_gateway.errors import GatewayError

CHUNK_SIZE = 1024 * 1024
MIB = 1024 * 1024
_SUFFIX = re.compile(r"^\.[a-z0-9]{1,9}$")


def file_too_large(max_upload_mb: int) -> GatewayError:
    return GatewayError(
        413, "file_too_large", f"Файл больше лимита {max_upload_mb} МБ", param="file"
    )


class DataDir:
    def __init__(self, root: Path) -> None:
        self.root = root

    def ensure(self) -> None:
        for name in ("uploads", "audio"):
            (self.root / name).mkdir(parents=True, exist_ok=True)

    def upload_rel(self, tid: uuid.UUID, filename: str) -> str:
        """`uploads/<id><.ext>`: расширение помогает PyAV угадать формат; мусорное — отброшено."""
        suffix = Path(filename).suffix.lower()
        return f"uploads/{tid}{suffix if _SUFFIX.match(suffix) else ''}"

    def audio_rel(self, tid: uuid.UUID) -> str:
        return f"audio/{tid}.webm"

    def resolve(self, rel: str) -> Path:
        root = self.root.resolve()
        path = (root / rel).resolve()
        if not path.is_relative_to(root) or path == root:
            raise ValueError(f"Путь вне каталога данных: {rel}")
        return path

    async def save_upload(self, upload: UploadFile, rel: str, *, max_upload_mb: int) -> int:
        """Копирует загрузку чанками; сверх лимита → 413, пустой файл → 400 (файл удаляется)."""
        path = self.resolve(rel)
        limit = max_upload_mb * MIB
        size = 0
        try:
            with path.open("wb") as out:
                while chunk := await upload.read(CHUNK_SIZE):
                    size += len(chunk)
                    if size > limit:
                        raise file_too_large(max_upload_mb)
                    await asyncio.to_thread(out.write, chunk)
            if size == 0:
                raise GatewayError(400, "invalid_audio", "Пустой аудиофайл", param="file")
        except BaseException:
            # и при отмене запроса (обрыв соединения): недописанный файл не остаётся сиротой
            path.unlink(missing_ok=True)
            raise
        finally:
            # спул Starlette больше не нужен: не держать на диске вторую копию
            await upload.close()
        return size

    def remove(self, rel: str | None) -> None:
        if rel is not None:
            self.resolve(rel).unlink(missing_ok=True)

    def remove_orphans(self, known: set[str]) -> int:
        """Удаляет файлы, на которые не ссылается ни одна запись (после сбоя); возвращает число."""
        removed = 0
        for name in ("uploads", "audio"):
            for path in (self.root / name).iterdir():
                if path.is_file() and f"{name}/{path.name}" not in known:
                    path.unlink(missing_ok=True)
                    removed += 1
        return removed
