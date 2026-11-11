#!/usr/bin/env python3
"""Scheduled health reporter for a Termly Phase 2-5 school-hosted install."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from ops_core import atomic_json, overall_status, parse_env_file, public_status_document, safe_update_status, utc_now

APP_ROOT = Path(__file__).resolve().parents[2]


def run(args: list[str], timeout: int = 30, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=False, env=env)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return subprocess.CompletedProcess(args, 127, "", str(exc))


def check_web(config: dict[str, str], web_dir: Path) -> dict[str, str]:
    compose = Path(config.get("TERMLY_WEB_COMPOSE_FILE", str(web_dir / "compose.yml")))
    env_file = Path(config.get("TERMLY_WEB_ENV_FILE", str(web_dir / ".env")))
    if not compose.is_file():
        return {"id": "web", "label": "Termly web app", "status": "critical", "message": "The web deployment configuration is missing."}
    command = ["docker", "compose"]
    if env_file.is_file():
        command += ["--env-file", str(env_file)]
    command += ["-f", str(compose), "ps", "-q", "termly-web"]
    result = run(command)
    container = result.stdout.strip().splitlines()[0] if result.returncode == 0 and result.stdout.strip() else ""
    if not container:
        return {"id": "web", "label": "Termly web app", "status": "critical", "message": "The Termly web service is not running."}
    inspected = run(["docker", "inspect", "--format", "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", container])
    state, separator, health = inspected.stdout.strip().partition("|")
    if inspected.returncode != 0 or not separator:
        return {"id": "web", "label": "Termly web app", "status": "critical", "message": "The web container could not be inspected."}
    if state != "running" or health in {"unhealthy", "unknown"}:
        return {"id": "web", "label": "Termly web app", "status": "critical", "message": "The web service is stopped or failing its container health check."}
    if health in {"starting", "none"}:
        return {"id": "web", "label": "Termly web app", "status": "warning", "message": "The web service is running, but its container health check is not yet passing or is not configured."}
    return {"id": "web", "label": "Termly web app", "status": "ok", "message": "The web container is running and passing its health check."}


def check_endpoint(config: dict[str, str]) -> dict[str, str]:
    url = config.get("TERMLY_HEALTH_URL", "").strip()
    if not url:
        return {"id": "endpoint", "label": "HTTPS endpoint", "status": "warning", "message": "External endpoint checking is not configured."}
    if not url.startswith("https://"):
        return {"id": "endpoint", "label": "HTTPS endpoint", "status": "critical", "message": "The configured health endpoint must use HTTPS."}
    request = urllib.request.Request(url, headers={"User-Agent": "Termly-Host-Monitor/1"}, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status == 200:
                return {"id": "endpoint", "label": "HTTPS endpoint", "status": "ok", "message": "The configured HTTPS health endpoint responded successfully."}
    except (urllib.error.URLError, TimeoutError, OSError):
        pass
    return {"id": "endpoint", "label": "HTTPS endpoint", "status": "critical", "message": "The configured HTTPS health endpoint did not respond successfully."}


def check_phase3(config: dict[str, str], app_root: Path) -> dict[str, str]:
    script = Path(config.get("TERMLY_HEALTHCHECK_SCRIPT", str(app_root / "scripts/healthcheck-school-hosted.sh")))
    backup_env = Path(config.get("TERMLY_BACKUP_ENV", "/etc/termly/backup.env"))
    if not script.is_file():
        return {"id": "data", "label": "Backend and backup", "status": "critical", "message": "The Phase 3 health-check script is missing."}
    env = os.environ.copy()
    env["TERMLY_BACKUP_ENV"] = str(backup_env)
    try:
        timeout_seconds = max(30, min(600, int(config.get("HEALTHCHECK_TIMEOUT_SECONDS", "150"))))
    except ValueError:
        timeout_seconds = 150
    result = run(["bash", str(script)], timeout=timeout_seconds, env=env)
    if result.returncode != 0:
        return {"id": "data", "label": "Backend and backup", "status": "critical", "message": "One or more backend, storage, disk or backup checks failed."}
    if "WARNING:" in result.stdout or "WARNING:" in result.stderr:
        return {"id": "data", "label": "Backend and backup", "status": "warning", "message": "The backend is responding, but a capacity or backup warning needs attention."}
    return {"id": "data", "label": "Backend and backup", "status": "ok", "message": "The Phase 3 backend, storage, disk and backup checks passed."}


def check_release(config: dict[str, str], web_dir: Path) -> dict[str, str]:
    path = Path(config.get("TERMLY_UPDATE_STATUS_FILE", str(web_dir / "runtime/termly-update-status.json")))
    value = safe_update_status(path)
    if value is None:
        return {"id": "release", "label": "Installed release", "status": "warning", "message": "Installed release information is not available."}
    return {"id": "release", "label": "Installed release", "status": "ok", "message": "The installed release information is readable."}


def send_alert(url: str, overall: str, previous: str | None, summary: str) -> tuple[bool, str]:
    if not url:
        return False, ""
    if not url.startswith("https://"):
        return False, "Webhook notifications require an HTTPS endpoint."
    payload = json.dumps({"text": f"Termly school-hosted status: {overall.upper()} (previous: {previous or 'not recorded'}). {summary}"}).encode()
    request = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json", "User-Agent": "Termly-Host-Monitor/1"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return 200 <= response.status < 300, ""
    except (urllib.error.URLError, TimeoutError, OSError):
        return False, "Webhook notification failed."


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="/etc/termly/monitor.env")
    parser.add_argument("--app-root", default=str(APP_ROOT))
    args = parser.parse_args()
    try:
        config = parse_env_file(args.config)
    except (PermissionError, ValueError) as exc:
        print(f"Termly monitor configuration error: {exc}", file=sys.stderr)
        return 2
    app_root = Path(args.app_root).resolve()
    web_dir = Path(config.get("TERMLY_WEB_DIR", str(app_root / "deployment/school-hosted"))).resolve()
    status_file = Path(config.get("TERMLY_HEALTH_STATUS_FILE", str(web_dir / "runtime/termly-health-status.json")))
    state_file = Path(config.get("TERMLY_MONITOR_STATE_FILE", "/var/lib/termly-monitor/state.json"))

    checks = [check_web(config, web_dir), check_phase3(config, app_root), check_endpoint(config), check_release(config, web_dir)]
    document = public_status_document(checks)
    try:
        atomic_json(status_file, document, 0o644)
    except OSError as exc:
        print(f"Termly monitor could not write its status file: {exc}", file=sys.stderr)
        return 2

    try:
        previous_state: dict[str, Any] = json.loads(state_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        previous_state = {}
    previous = previous_state.get("overall")
    current = document["overall"]
    now_epoch = __import__("time").time()
    try:
        repeat_minutes = max(5, min(1440, int(config.get("ALERT_REPEAT_INTERVAL_MINUTES", "60"))))
    except ValueError:
        repeat_minutes = 60
    last_alert = float(previous_state.get("lastAlertEpoch", 0) or 0)
    alert_due = current in {"critical", "degraded"} and (
        previous not in {"critical", "degraded"} or now_epoch - last_alert >= repeat_minutes * 60
    )
    recovery_due = current == "healthy" and previous in {"critical", "degraded"} and config.get("ALERT_ON_RECOVERY", "true").lower() in {"1", "true", "yes"}
    webhook = config.get("TERMLY_ALERT_WEBHOOK_URL", "").strip()
    if webhook and (alert_due or recovery_due):
        failed = [item["label"] for item in checks if item["status"] in {"critical", "warning", "unknown"}]
        summary = "Checks needing attention: " + (", ".join(failed) if failed else "all checks passed; service recovered")
        ok, warning = send_alert(webhook, current, previous, summary)
        # Throttle failed deliveries too; otherwise an unavailable webhook would log every five minutes.
        last_alert = now_epoch
        if not ok and warning:
            print(warning, file=sys.stderr)
    else:
        last_alert = float(previous_state.get("lastAlertEpoch", 0) or 0)

    state = {"overall": current, "checkedAt": utc_now(), "lastAlertEpoch": last_alert}
    try:
        atomic_json(state_file, state, 0o600)
    except OSError as exc:
        print(f"Termly monitor could not write its private state file: {exc}", file=sys.stderr)
        return 2
    print(f"Termly host status: {current}; {len(checks)} checks recorded.")
    return 0 if current == "healthy" else 1


if __name__ == "__main__":
    raise SystemExit(main())
