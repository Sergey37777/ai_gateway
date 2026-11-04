"""Каталог данных: загрузки, пути, сироты."""

import io
import uuid
from pathlib import Path

import pytest
from starlette.datastructures import UploadFile

from ai_gateway.errors import GatewayError
from ai_gateway.files import DataDir

MIB = 1024 * 1024


def upload(data: bytes, name: str = "a.wav") -> UploadFile:
    return UploadFile(io.BytesIO(data), filename=name)


@pytest.fixture
def files(tmp_path: Path) -> DataDir:
    data = DataDir(tmp_path / "data")
    data.ensure()
    return data


async def test_save_upload_writes_file(files):
    rel = files.upload_rel(uuid.uuid4(), "a.wav")
    assert await files.save_upload(upload(b"12345"), rel, max_upload_mb=1) == 5
    assert files.resolve(rel).read_bytes() == b"12345"


async def test_save_upload_limit_removes_file(files):
    rel = files.upload_rel(uuid.uuid4(), "a.wav")
    with pytest.raises(GatewayError) as info:
        await files.save_upload(upload(b"x" * (MIB + 1)), rel, max_upload_mb=1)
    assert (info.value.status_code, info.value.code) == (413, "file_too_large")
    assert not files.resolve(rel).exists()


async def test_save_upload_empty(files):
    rel = files.upload_rel(uuid.uuid4(), "a.wav")
    with pytest.raises(GatewayError) as info:
        await files.save_upload(upload(b""), rel, max_upload_mb=1)
    assert (info.value.status_code, info.value.code) == (400, "invalid_audio")
    assert not files.resolve(rel).exists()


def test_upload_rel_sanitizes_suffix(files):
    tid = uuid.uuid4()
    assert files.upload_rel(tid, "a.M4A") == f"uploads/{tid}.m4a"
    assert files.upload_rel(tid, "x.ph p") == f"uploads/{tid}"
    assert files.upload_rel(tid, "noext") == f"uploads/{tid}"
    assert files.upload_rel(tid, "a.verylongsuffix") == f"uploads/{tid}"
    assert files.audio_rel(tid) == f"audio/{tid}.webm"


def test_resolve_rejects_escape(files):
    with pytest.raises(ValueError):
        files.resolve("../x")
    with pytest.raises(ValueError):
        files.resolve("/etc/passwd")


def test_remove_and_orphans(files):
    keep = "uploads/keep.wav"
    files.resolve(keep).write_bytes(b"1")
    files.resolve("audio/orphan.webm").write_bytes(b"1")
    files.resolve("uploads/orphan.wav").write_bytes(b"1")
    assert files.remove_orphans({keep}) == 2
    assert files.resolve(keep).exists()
    files.remove(keep)
    files.remove(keep)  # повторно — без ошибки
    files.remove(None)
    assert not files.resolve(keep).exists()
