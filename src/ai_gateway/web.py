"""Раздача собранного Web UI (`AIGW_WEB_DIR`) из шлюза."""

import os
from pathlib import Path

from fastapi import FastAPI
from loguru import logger
from starlette.responses import Response
from starlette.staticfiles import PathLike, StaticFiles
from starlette.types import Scope

# имена в assets/ содержат хэш содержимого (Vite) — их можно кэшировать навсегда
IMMUTABLE = "public, max-age=31536000, immutable"
# index.html и прочее без хэша — всегда сверять с сервером, иначе после обновления образа
# браузер показывал бы старый UI
NO_CACHE = "no-cache"


class WebStaticFiles(StaticFiles):
    """StaticFiles с заголовками кэширования под сборку Vite."""

    def __init__(self, *, directory: Path) -> None:
        super().__init__(directory=directory, html=True)
        self._root = directory.resolve()

    def file_response(
        self,
        full_path: PathLike,
        stat_result: os.stat_result,
        scope: Scope,
        status_code: int = 200,
    ) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        relative = Path(full_path).resolve().relative_to(self._root)
        immutable = relative.parts[:1] == ("assets",)
        response.headers["Cache-Control"] = IMMUTABLE if immutable else NO_CACHE
        return response


def mount_web(app: FastAPI, web_dir: Path) -> bool:
    """Монтирует UI на `/`; вызывать после всех роутеров, чтобы API имел приоритет."""
    if not (web_dir / "index.html").is_file():
        logger.info("Web UI не найден: {}", web_dir)
        return False
    app.mount("/", WebStaticFiles(directory=web_dir), name="web")
    return True
