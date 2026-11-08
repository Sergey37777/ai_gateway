"""Общие помощники хранилищ: позиция курсора (`время|uuid` в base64url)."""

import base64
import uuid
from datetime import UTC, datetime

import pytest

from ai_gateway.db.session import decode_position, encode_position
from ai_gateway.errors import GatewayError


def test_position_roundtrip():
    at = datetime(2026, 11, 8, 10, 0, 1, 123456, tzinfo=UTC)
    pid = uuid.uuid4()
    assert decode_position(encode_position(at, pid)) == (at, pid)


def _b64(raw: str) -> str:
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


@pytest.mark.parametrize(
    "value",
    ["!!", _b64("без-разделителя"), _b64(f"2026-11-08T10:00:00|{uuid.uuid4()}"), _b64("x|y")],
)
def test_position_rejects_garbage(value: str) -> None:
    with pytest.raises(GatewayError) as caught:
        decode_position(value)
    assert caught.value.status_code == 400
    assert caught.value.param == "before"
