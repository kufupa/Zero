"""Deny connected-mailbox dump reads from CPython -m kernels.

Python kernel only. Node fs and host bash are not covered.
"""

from __future__ import annotations

import builtins
import io
import os
from pathlib import Path

_DUMP_NAME = "connected-mailbox-inbox.md"
_ERROR = "NAVA dump deny (set NAVA_ALLOW_DUMP=1 to override)"


def _denied(path: object) -> bool:
    if os.environ.get("NAVA_ALLOW_DUMP") == "1":
        return False
    try:
        name = os.path.basename(os.fspath(path))
    except TypeError:
        return False
    return name == _DUMP_NAME


_io_open = io.open


def _open(file, *args, **kwargs):  # type: ignore[no-untyped-def]
    if _denied(file):
        raise PermissionError(_ERROR)
    return _io_open(file, *args, **kwargs)


io.open = _open  # type: ignore[assignment]
builtins.open = _open  # type: ignore[assignment]

_path_open = Path.open
_path_read_text = Path.read_text
_path_read_bytes = Path.read_bytes


def _path_open_wrapped(self: Path, *args, **kwargs):  # type: ignore[no-untyped-def]
    if _denied(self):
        raise PermissionError(_ERROR)
    return _path_open(self, *args, **kwargs)


def _path_read_text_wrapped(self: Path, *args, **kwargs):  # type: ignore[no-untyped-def]
    if _denied(self):
        raise PermissionError(_ERROR)
    return _path_read_text(self, *args, **kwargs)


def _path_read_bytes_wrapped(self: Path, *args, **kwargs):  # type: ignore[no-untyped-def]
    if _denied(self):
        raise PermissionError(_ERROR)
    return _path_read_bytes(self, *args, **kwargs)


Path.open = _path_open_wrapped  # type: ignore[assignment]
Path.read_text = _path_read_text_wrapped  # type: ignore[assignment]
Path.read_bytes = _path_read_bytes_wrapped  # type: ignore[assignment]


def _wrap_bash_if_present() -> None:
    for holder in (builtins,):
        current = getattr(holder, "bash", None)
        if not callable(current):
            continue

        def _bash(*args, **kwargs):  # type: ignore[no-untyped-def]
            blob = " ".join(str(item) for item in args)
            blob += " ".join(str(value) for value in kwargs.values())
            if _DUMP_NAME in blob and os.environ.get("NAVA_ALLOW_DUMP") != "1":
                raise PermissionError(_ERROR)
            return current(*args, **kwargs)

        setattr(holder, "bash", _bash)


_wrap_bash_if_present()
