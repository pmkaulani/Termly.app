#!/usr/bin/env python3
"""Create an age-encrypted, privacy-limited Termly support diagnostics bundle."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from ops_core import backup_metadata, parse_env_file, safe_update_status, utc_now

APP_ROOT = Path(__file__).resolve().parents[2]


def capture(args: list[str], timeout: int = 20) -> str:
    try:
        result = subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=False)
        output = result.stdout.strip() if result.returncode == 0 else "Command unavailable or returned an error."
        return output[:12000]
    except (OSError, subprocess.TimeoutExpired):
        return "Command unavailable or timed out."


def parse_compose_status(compose_file: Path, env_file: Path | None) -> list[dict[str, str]]:
    command = ["docker", "compose"]
    if env_file and env_file.is_file():
        command += ["--env-file", str(env_file)]
    command += ["-f", str(compose_file), "ps", "--all", "--format", "json"]
    raw = capture(command)
    try:
        decoded = json.loads(raw)
        items = decoded if isinstance(decoded, list) else [decoded]
    except json.JSONDecodeError:
        items = []
        for line in raw.splitlines():
            try:
                items.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    rows: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        rows.append({
            "service": str(item.get("Service", "unknown"))[:80],
            "state": str(item.get("State", "unknown"))[:40],
            "health": str(item.get("Health", "not-reported"))[:40],
        })
    return rows


def build_support_bundle(config_path: str, recipient: str, output: str | None, app_root: Path) -> Path:
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        raise PermissionError("Run the support-bundle collector as root.")
    if not recipient.startswith("age1") or len(recipient) < 20:
        raise ValueError("Provide the Termly support team's age1... public recipient.")
    config = parse_env_file(config_path)
    web_dir = Path(config.get("TERMLY_WEB_DIR", str(app_root / "deployment/school-hosted"))).resolve()
    backup_config_path = config.get("TERMLY_BACKUP_ENV", "/etc/termly/backup.env")
    backup_cfg = parse_env_file(backup_config_path)
    supabase_dir = Path(backup_cfg.get("SUPABASE_DIR", config.get("SUPABASE_DIR", "/opt/termly/supabase"))).resolve()
    backup_dir = Path(backup_cfg.get("BACKUP_DIR", config.get("BACKUP_DIR", "/mnt/termly-backups"))).resolve()
    runtime = web_dir / "runtime"
    update_file = Path(config.get("TERMLY_UPDATE_STATUS_FILE", str(runtime / "termly-update-status.json")))
    health_file = Path(config.get("TERMLY_HEALTH_STATUS_FILE", str(runtime / "termly-health-status.json")))

    age = shutil.which("age")
    if not age:
        raise RuntimeError("The age encryption utility is required. Install age before collecting a support bundle.")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    default_output = Path("/var/tmp") / f"termly-support-{stamp}.tar.gz.age"
    encrypted_output = Path(output).resolve() if output else default_output
    checksum = encrypted_output.with_suffix(encrypted_output.suffix + ".sha256")
    encrypted_output.parent.mkdir(parents=True, exist_ok=True)
    if encrypted_output.exists() or encrypted_output.is_symlink():
        raise FileExistsError("Refusing to overwrite an existing support bundle.")
    if checksum.exists() or checksum.is_symlink():
        raise FileExistsError("Refusing to overwrite an existing support-bundle checksum.")

    with tempfile.TemporaryDirectory(prefix="termly-support-") as temporary:
        work = Path(temporary)
        (work / "scope.txt").write_text(
            "Termly school-hosted support diagnostics\n"
            f"Created: {utc_now()}\n\n"
            "This archive contains operational metadata only. It excludes database contents, uploaded files, raw application logs, user/student records, passwords, API keys, service-role keys, private keys and environment-file values.\n"
            "No SQL queries or database dumps are performed.\n",
            encoding="utf-8",
        )
        os.chmod(work / "scope.txt", 0o600)

        os_release = {}
        try:
            for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
                if line.startswith(("PRETTY_NAME=", "VERSION_ID=")):
                    key, value = line.split("=", 1)
                    os_release[key] = value.strip().strip('"')
        except OSError:
            pass
        host = {
            "createdAt": utc_now(),
            "os": os_release,
            "kernel": platform.release(),
            "architecture": platform.machine(),
            "python": platform.python_version(),
        }
        (work / "host-summary.json").write_text(json.dumps(host, indent=2) + "\n", encoding="utf-8")

        versions = {
            "docker": capture(["docker", "version", "--format", "{{.Server.Version}}"]),
            "dockerCompose": capture(["docker", "compose", "version", "--short"]),
            "node": capture(["node", "--version"]),
            "python": platform.python_version(),
        }
        (work / "runtime-versions.json").write_text(json.dumps(versions, indent=2) + "\n", encoding="utf-8")

        disk = {
            "rootFilesystem": capture(["df", "-h", "/"]),
            "termlyFilesystem": capture(["df", "-h", str(web_dir)]) if web_dir.exists() else "Termly web directory not found.",
            "supabaseFilesystem": capture(["df", "-h", str(supabase_dir)]) if supabase_dir.exists() else "Supabase directory not found.",
        }
        (work / "disk-summary.json").write_text(json.dumps(disk, indent=2) + "\n", encoding="utf-8")

        service_status = {
            "termlyWeb": parse_compose_status(web_dir / "compose.yml", web_dir / ".env"),
            "supabase": parse_compose_status(supabase_dir / "docker-compose.yml", supabase_dir / ".env"),
        }
        (work / "container-status.json").write_text(json.dumps(service_status, indent=2) + "\n", encoding="utf-8")

        timers = capture(["systemctl", "list-timers", "--all", "--no-pager", "termly-*"])
        (work / "termly-systemd-timers.txt").write_text(timers + "\n", encoding="utf-8")
        (work / "uptime.txt").write_text(capture(["uptime", "-p"]) + "\n", encoding="utf-8")

        actual_backup_dir = backup_cfg.get("BACKUP_DIR", str(backup_dir))
        (work / "backup-metadata.json").write_text(json.dumps(backup_metadata(actual_backup_dir), indent=2) + "\n", encoding="utf-8")

        update = safe_update_status(update_file)
        if update is not None:
            (work / "release-status.json").write_text(json.dumps(update, indent=2) + "\n", encoding="utf-8")
        try:
            health = json.loads(health_file.read_text(encoding="utf-8"))
            if isinstance(health, dict) and health.get("product") == "termly":
                safe_health = {key: health.get(key) for key in ("product", "schemaVersion", "checkedAt", "overall", "checks")}
                (work / "health-status.json").write_text(json.dumps(safe_health, indent=2) + "\n", encoding="utf-8")
        except (OSError, json.JSONDecodeError):
            pass

        key_files = [web_dir / ".env", supabase_dir / ".env", Path(config.get("TERMLY_BACKUP_ENV", "/etc/termly/backup.env")), Path("/etc/termly/update.env"), Path(config_path)]
        config_metadata = []
        for item in key_files:
            try:
                details = item.stat()
                config_metadata.append({"fileClass": item.name.replace(".env", "environment-config"), "exists": True, "mode": oct(stat.S_IMODE(details.st_mode))})
            except OSError:
                config_metadata.append({"fileClass": item.name.replace(".env", "environment-config"), "exists": False, "mode": None})
        (work / "config-permissions.json").write_text(json.dumps(config_metadata, indent=2) + "\n", encoding="utf-8")

        tar_path = work.parent / f"termly-support-{stamp}-{os.getpid()}.tar.gz"
        try:
            with tarfile.open(tar_path, "w:gz") as archive:
                for item in sorted(work.iterdir()):
                    if item.is_file() and not item.is_symlink():
                        archive.add(item, arcname=item.name, recursive=False)
            os.chmod(tar_path, 0o600)
            previous_umask = os.umask(0o077)
            try:
                try:
                    result = subprocess.run([age, "--recipient", recipient, "--output", str(encrypted_output), str(tar_path)], capture_output=True, text=True, timeout=90, check=False)
                except (OSError, subprocess.TimeoutExpired) as exc:
                    try:
                        encrypted_output.unlink()
                    except FileNotFoundError:
                        pass
                    raise RuntimeError("age could not complete support-bundle encryption.") from exc
            finally:
                os.umask(previous_umask)
            if result.returncode != 0:
                try:
                    encrypted_output.unlink()
                except FileNotFoundError:
                    pass
                raise RuntimeError("age could not encrypt the support bundle. Check the supplied public recipient.")
        finally:
            try:
                tar_path.unlink()
            except FileNotFoundError:
                pass

    os.chmod(encrypted_output, 0o600)
    digest = hashlib.sha256(encrypted_output.read_bytes()).hexdigest()
    checksum.write_text(f"{digest}  {encrypted_output.name}\n", encoding="ascii")
    os.chmod(checksum, 0o600)
    return encrypted_output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/termly/monitor.env")
    parser.add_argument("--recipient", required=True, help="Termly support team's age public recipient")
    parser.add_argument("--output")
    parser.add_argument("--app-root", default=str(APP_ROOT))
    args = parser.parse_args()
    try:
        result = build_support_bundle(args.config, args.recipient, args.output, Path(args.app_root).resolve())
    except (PermissionError, ValueError, RuntimeError, OSError) as exc:
        print(f"Termly support bundle failed: {exc}", file=sys.stderr)
        return 1
    print(f"Encrypted support bundle created: {result}")
    print(f"SHA-256 sidecar: {result}.sha256")
    print("The archive excludes database contents, uploads, user records, raw application logs and secret values.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
