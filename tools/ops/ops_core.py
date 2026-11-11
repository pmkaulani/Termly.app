#!/usr/bin/env python3
"""Shared, deliberately small helpers for Termly school-hosted operations."""
from __future__ import annotations

import json
import os
import re
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


SAFE_STATUS = {"ok", "warning", "critical", "unknown"}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_env_file(path: str | Path, *, require_private: bool = True) -> dict[str, str]:
    """Read simple KEY=VALUE config; never execute it as shell code."""
    source = Path(path)
    if not source.is_file():
        return {}
    mode = stat.S_IMODE(source.stat().st_mode)
    if require_private and (mode & 0o077) and os.name != "nt":
        raise PermissionError(f"Configuration permissions must be 0600 or stricter: {source.name}")
    values: dict[str, str] = {}
    for line_number, raw in enumerate(source.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise ValueError(f"Invalid config entry on line {line_number}")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError(f"Invalid config key on line {line_number}")
        if value.startswith(("'", '"')):
            quote = value[0]
            if len(value) < 2 or value[-1] != quote:
                raise ValueError(f"Unclosed quote on line {line_number}")
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        values[key] = value
    return values


def atomic_json(path: str | Path, data: dict[str, Any], mode: int = 0o644) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=str(target.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def overall_status(checks: Iterable[dict[str, Any]]) -> str:
    statuses = [item.get("status", "unknown") for item in checks]
    if any(value == "critical" for value in statuses):
        return "critical"
    if any(value in {"warning", "unknown"} for value in statuses):
        return "degraded"
    return "healthy"


def public_status_document(checks: list[dict[str, str]]) -> dict[str, Any]:
    """Allowlist every field: this JSON is mounted by Nginx and is public."""
    clean = []
    for item in checks:
        status = item.get("status", "unknown")
        if status not in SAFE_STATUS:
            status = "unknown"
        clean.append({
            "id": re.sub(r"[^a-z0-9_-]", "", item.get("id", "check").lower())[:32] or "check",
            "label": str(item.get("label", "System check"))[:60],
            "status": status,
            "message": str(item.get("message", "No details available."))[:140],
        })
    overall = overall_status(clean)
    return {
        "product": "termly",
        "schemaVersion": 1,
        "checkedAt": utc_now(),
        "overall": overall,
        "checks": clean,
    }


def safe_update_status(path: str | Path) -> dict[str, Any] | None:
    """Return only public/non-secret release metadata from the Phase 5 status file."""
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or value.get("product") != "termly":
        return None
    result: dict[str, Any] = {"product": "termly"}
    for key in ("version", "channel", "previousVersion", "installedAt", "updatedAt", "migrationCount", "updateMethod"):
        item = value.get(key)
        if isinstance(item, (str, int, float)) or item is None:
            result[key] = item
    if not isinstance(result.get("version"), str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", result["version"]):
        return None
    return result


def backup_metadata(backup_dir: str | Path) -> dict[str, Any]:
    """Summarise encrypted backup age/count only; never disclose filenames or paths."""
    root = Path(backup_dir)
    if not root.is_dir():
        return {"available": False, "count": 0, "latestAgeHours": None, "totalBytes": 0}
    files = [item for item in root.glob("termly-schoolhosted-*.tar.gz.age") if item.is_file() and not item.is_symlink()]
    total = 0
    newest = None
    for item in files:
        try:
            details = item.stat()
        except OSError:
            continue
        total += details.st_size
        newest = details.st_mtime if newest is None else max(newest, details.st_mtime)
    age = None
    if newest is not None:
        age = round(max(0, datetime.now(timezone.utc).timestamp() - newest) / 3600, 2)
    return {"available": bool(files), "count": len(files), "latestAgeHours": age, "totalBytes": total}
