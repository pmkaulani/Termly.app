#!/usr/bin/env python3
"""Safely extract a Termly release ZIP into an empty staging directory."""
from __future__ import annotations
import argparse
import os
from pathlib import Path, PurePosixPath
import stat
import zipfile

MAX_MEMBERS = 100_000
MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    parser.add_argument("destination")
    args = parser.parse_args()
    archive = Path(args.archive).resolve(strict=True)
    dest = Path(args.destination).resolve()
    if dest.exists() and any(dest.iterdir()):
        raise SystemExit("Destination must be a new or empty directory.")
    dest.mkdir(parents=True, exist_ok=True, mode=0o700)
    total = 0
    with zipfile.ZipFile(archive) as zf:
        members = zf.infolist()
        if len(members) > MAX_MEMBERS:
            raise SystemExit("Release ZIP contains too many entries.")
        for info in members:
            raw = info.filename
            if "\\" in raw or (len(raw) >= 2 and raw[1] == ":"):
                raise SystemExit(f"Unsafe ZIP path: {raw!r}")
            rel = PurePosixPath(raw)
            if rel.is_absolute() or not rel.parts or any(part in ("", ".", "..") for part in rel.parts):
                raise SystemExit(f"Unsafe ZIP path: {raw!r}")
            mode = (info.external_attr >> 16) & 0xFFFF
            file_type = stat.S_IFMT(mode)
            if file_type == stat.S_IFLNK:
                raise SystemExit(f"Symbolic links are not permitted: {raw}")
            if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise SystemExit(f"Unsupported ZIP member type: {raw}")
            total += info.file_size
            if total > MAX_TOTAL_SIZE:
                raise SystemExit("Release ZIP exceeds the 2 GiB expanded size limit.")
            target = (dest / Path(*rel.parts)).resolve()
            if dest != target and dest not in target.parents:
                raise SystemExit(f"ZIP path escapes destination: {raw}")
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
                continue
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
            fd = os.open(target, flags, 0o600)
            with os.fdopen(fd, "wb") as output, zf.open(info, "r") as source:
                while True:
                    block = source.read(1024 * 1024)
                    if not block:
                        break
                    output.write(block)
    print(f"Safely extracted {len(members)} entries to {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
