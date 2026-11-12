#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="/etc/termly"
CONFIG_FILE="$CONFIG_DIR/monitor.env"
RUNTIME_DIR="$ROOT_DIR/deployment/school-hosted/runtime"
SYSTEMD_DIR="/etc/systemd/system"

[[ "$EUID" -eq 0 ]] || { echo 'Run this installer as root.' >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo 'Python 3 is required.' >&2; exit 1; }
PYTHON_BIN="$(command -v python3)"
command -v docker >/dev/null 2>&1 || { echo 'Docker Engine is required.' >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo 'systemd is required for scheduled monitoring.' >&2; exit 1; }
[[ -f "$ROOT_DIR/tools/ops/monitor-school-hosted.py" ]] || { echo 'Missing Phase 6 monitor.' >&2; exit 1; }
[[ -f "$ROOT_DIR/scripts/healthcheck-school-hosted.sh" ]] || { echo 'Apply Phase 3 first: healthcheck-school-hosted.sh is missing.' >&2; exit 1; }
[[ -f "$ROOT_DIR/deployment/school-hosted/monitor/monitor.env.example" ]] || { echo 'Missing monitor.env.example.' >&2; exit 1; }
[[ -f "$ROOT_DIR/deployment/school-hosted/systemd/termly-monitor.service.in" ]] || { echo 'Missing systemd service template.' >&2; exit 1; }

install -d -m 0700 "$CONFIG_DIR" /var/lib/termly-monitor
install -d -m 0755 "$RUNTIME_DIR"
[[ ! -L "$CONFIG_FILE" ]] || { echo 'Refusing a symbolic-link monitor config.' >&2; exit 1; }
[[ ! -L "$RUNTIME_DIR/termly-health-status.json" ]] || { echo 'Refusing a symbolic-link health status file.' >&2; exit 1; }
if [[ ! -f "$CONFIG_FILE" ]]; then
  install -m 0600 "$ROOT_DIR/deployment/school-hosted/monitor/monitor.env.example" "$CONFIG_FILE"
  echo "Created $CONFIG_FILE. Review the paths and set the HTTPS health URL and optional alert webhook."
else
  chown root:root "$CONFIG_FILE"
  chmod 0600 "$CONFIG_FILE"
  echo "Keeping existing $CONFIG_FILE."
fi
if [[ ! -f "$RUNTIME_DIR/termly-health-status.json" ]]; then
  install -m 0644 "$ROOT_DIR/deployment/school-hosted/runtime/termly-health-status.json.example" "$RUNTIME_DIR/termly-health-status.json"
else
  chown root:root "$RUNTIME_DIR/termly-health-status.json"
  chmod 0644 "$RUNTIME_DIR/termly-health-status.json"
fi

printf '#!/usr/bin/env bash\nset -Eeuo pipefail\nexec %q %q --config %q --app-root %q\n' \
  "$PYTHON_BIN" "$ROOT_DIR/tools/ops/monitor-school-hosted.py" "$CONFIG_FILE" "$ROOT_DIR" \
  > /usr/local/sbin/termly-school-hosted-monitor
chmod 0750 /usr/local/sbin/termly-school-hosted-monitor
chown root:root /usr/local/sbin/termly-school-hosted-monitor

sed "s|@MONITOR_ROOT@|$ROOT_DIR|g" "$ROOT_DIR/deployment/school-hosted/systemd/termly-monitor.service.in" > "$SYSTEMD_DIR/termly-monitor.service"
install -m 0644 "$ROOT_DIR/deployment/school-hosted/systemd/termly-monitor.timer" "$SYSTEMD_DIR/termly-monitor.timer"
systemctl daemon-reload
systemctl enable --now termly-monitor.timer

cat <<'MSG'
Termly monitoring timer installed and enabled.
Next steps:
  1. Review /etc/termly/monitor.env (root-only, mode 0600).
  2. Ensure the Phase 5 /termly-update-status.json and Phase 6 /termly-health-status.json mounts are present in the web Compose file.
  3. Run: systemctl start termly-monitor.service
  4. Review: systemctl status termly-monitor.service; journalctl -u termly-monitor.service
  5. Confirm /termly-health-status.json is reachable on the Termly site.
MSG
