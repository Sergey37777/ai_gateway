"""Ошибки шлюза в формате OpenAI: `{"error": {message, type, param, code}}`."""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from loguru import logger
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse, Response


class GatewayError(Exception):
    """Ошибка, которая отдаётся клиенту как есть, с HTTP-статусом и кодом OpenAI."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        param: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.param = param
        self.headers = headers

    @property
    def error_type(self) -> str:
        """Поле `type` в теле ошибки OpenAI."""
        if self.status_code == 401:
            return "authentication_error"
        if self.status_code >= 500:
            return "server_error"
        return "invalid_request_error"

    def to_body(self) -> dict[str, dict[str, str | None]]:
        """Тело ответа в формате OpenAI."""
        return {
            "error": {
                "message": self.message,
                "type": self.error_type,
                "param": self.param,
                "code": self.code,
            }
        }


def model_unavailable(message: str) -> GatewayError:
    """503: модель не удалось загрузить или ей не хватило памяти; клиент может повторить."""
    return GatewayError(503, "model_unavailable", message, headers={"Retry-After": "30"})


def database_unavailable() -> GatewayError:
    """503: PostgreSQL недоступна (история и очередь); клиент может повторить."""
    return GatewayError(
        503, "database_unavailable", "База данных недоступна", headers={"Retry-After": "5"}
    )


def transcription_not_found(tid: object) -> GatewayError:
    return GatewayError(404, "transcription_not_found", f"Распознавание '{tid}' не найдено")


def invalid_state(message: str) -> GatewayError:
    """409: действие не подходит к текущему статусу распознавания."""
    return GatewayError(409, "invalid_state", message)


def transcription_cancelled() -> GatewayError:
    """409 клиенту синхронного запроса, если его распознавание отменили (из UI)."""
    return GatewayError(409, "transcription_cancelled", "Распознавание отменено")


def error_response(error: GatewayError) -> JSONResponse:
    """JSON-ответ с ошибкой в формате OpenAI."""
    return JSONResponse(error.to_body(), status_code=error.status_code, headers=error.headers)


def internal_error() -> GatewayError:
    """500 без деталей: трейсбек пишется только в лог."""
    return GatewayError(500, "internal_error", "Внутренняя ошибка сервера")


async def _gateway_error_handler(_request: Request, exc: Exception) -> Response:
    assert isinstance(exc, GatewayError)
    return error_response(exc)


async def _validation_error_handler(_request: Request, exc: Exception) -> Response:
    assert isinstance(exc, RequestValidationError)
    errors = exc.errors()
    first = errors[0] if errors else {}
    loc = first.get("loc") or ()
    param = str(loc[-1]) if loc else None
    message = str(first.get("msg", "Некорректный запрос"))
    return error_response(GatewayError(400, "invalid_request_error", message, param=param))


async def _http_error_handler(_request: Request, exc: Exception) -> Response:
    assert isinstance(exc, StarletteHTTPException)
    error = GatewayError(
        exc.status_code,
        "invalid_request_error",
        str(exc.detail),
        headers=dict(exc.headers) if exc.headers else None,
    )
    return error_response(error)


async def _unhandled_error_handler(_request: Request, exc: Exception) -> Response:
    logger.opt(exception=exc).error("Необработанная ошибка")
    return error_response(internal_error())


def install_error_handlers(app: FastAPI) -> None:
    """Все ошибки приложения — в формате OpenAI."""
    app.add_exception_handler(GatewayError, _gateway_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_error_handler)
    app.add_exception_handler(StarletteHTTPException, _http_error_handler)
    app.add_exception_handler(Exception, _unhandled_error_handler)
