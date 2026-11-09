#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$EUID" -eq 0 ]] || { echo 'Run with sudo on the Linux school server.' >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || { echo 'systemd is required for this installer.' >&2; exit 1; }

ENV_DIR=/etc/termly
ENV_FILE="$ENV_DIR/backup.env"
mkdir -p "$ENV_DIR"
chmod 700 "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 600 "$ROOT_DIR/deployment/school-hosted/backup/backup.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE. Edit SUPABASE_DIR, BACKUP_DIR and AGE_RECIPIENT first."
  echo 'Then rerun this installer to enable the timer.'
  exit 0
fi
chmod 600 "$ENV_FILE"
# shellcheck disable=SC1090
source "$ENV_FILE"
[[ "${AGE_RECIPIENT:-}" == age1* ]] || { echo "Set AGE_RECIPIENT in $ENV_FILE before enabling the timer." >&2; exit 1; }
[[ -d "${SUPABASE_DIR:-/opt/termly/supabase}" ]] || { echo "SUPABASE_DIR does not exist: ${SUPABASE_DIR:-}" >&2; exit 1; }

sed "s|@TERMLY_ROOT@|$ROOT_DIR|g" \
  "$ROOT_DIR/deployment/school-hosted/systemd/termly-backup.service.in" \
  > /etc/systemd/system/termly-backup.service
install -m 644 "$ROOT_DIR/deployment/school-hosted/systemd/termly-backup.timer" /etc/systemd/system/termly-backup.timer
systemctl daemon-reload
systemctl enable --now termly-backup.timer
systemctl list-timers termly-backup.timer --no-pager

echo 'Daily backup timer enabled. Run the first backup manually and verify an off-site copy before using real school records.'
