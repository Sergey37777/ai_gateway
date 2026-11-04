"""Ошибки шлюза в формате OpenAI: `{"error": {message, type, param, code}}`."""


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
