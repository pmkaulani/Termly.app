#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="/etc/termly"
STATUS_DIR="$ROOT_DIR/deployment/school-hosted/runtime"

[[ "$EUID" -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }
command -v install >/dev/null 2>&1 || { echo 'install command is required.' >&2; exit 1; }
[[ -f "$ROOT_DIR/scripts/apply-school-hosted-update.sh" ]] || { echo 'Missing Phase 5 updater script.' >&2; exit 1; }
[[ -f "$ROOT_DIR/tools/releases/verify-release.mjs" ]] || { echo 'Missing release verifier.' >&2; exit 1; }
[[ -f "$ROOT_DIR/deployment/school-hosted/update/update.env.example" ]] || { echo 'Missing update.env.example.' >&2; exit 1; }

install -d -m 0700 "$CONFIG_DIR"
install -d -m 0755 "$STATUS_DIR"
if [[ ! -f "$CONFIG_DIR/update.env" ]]; then
  install -m 0600 "$ROOT_DIR/deployment/school-hosted/update/update.env.example" "$CONFIG_DIR/update.env"
  echo "Created $CONFIG_DIR/update.env. Review all paths before using the updater."
else
  echo "Keeping existing $CONFIG_DIR/update.env."
fi
if [[ ! -f "$STATUS_DIR/termly-update-status.json" ]]; then
  install -m 0644 "$ROOT_DIR/deployment/school-hosted/runtime/termly-update-status.json.example" "$STATUS_DIR/termly-update-status.json"
fi
install -m 0750 "$ROOT_DIR/scripts/apply-school-hosted-update.sh" /usr/local/sbin/termly-apply-school-hosted-update
cat <<'MSG'
Updater installed at /usr/local/sbin/termly-apply-school-hosted-update.
Next: copy the separate Termly release PUBLIC key to /etc/termly/release-public-key.pem,
set root-only ownership/mode, edit /etc/termly/update.env, then run a dry-run.
Do not copy the private release signing key to this host.
MSG
