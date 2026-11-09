#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_FILE="${TERMLY_BACKUP_ENV:-/etc/termly/backup.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi
SUPABASE_DIR="${SUPABASE_DIR:-/opt/termly/supabase}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/termly}"
TERMLY_HEALTH_URL="${TERMLY_HEALTH_URL:-}"
REQUIRE_RECENT_BACKUP_HOURS="${REQUIRE_RECENT_BACKUP_HOURS:-30}"

failures=0
warn() { echo "[Termly health] WARNING: $*" >&2; }
fail() { echo "[Termly health] FAIL: $*" >&2; failures=$((failures + 1)); }

for cmd in docker df find date; do
  command -v "$cmd" >/dev/null 2>&1 || { fail "Missing command: $cmd"; break; }
done
if [[ ! -f "$SUPABASE_DIR/docker-compose.yml" ]]; then
  fail "Supabase compose file missing: $SUPABASE_DIR/docker-compose.yml"
else
  cd "$SUPABASE_DIR"
  dc() { docker compose "$@"; }
  SERVICES="$(dc config --services 2>/dev/null || true)"
  [[ -n "$SERVICES" ]] || fail 'Docker Compose could not render the Supabase stack.'
  for service in db storage api-gw auth rest; do
    if grep -qx "$service" <<<"$SERVICES"; then
      cid="$(dc ps -q "$service" 2>/dev/null || true)"
      if [[ -z "$cid" ]]; then
        fail "Service '$service' has no container."
      else
        state="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)"
        health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo unknown)"
        [[ "$state" == running ]] || fail "Service '$service' state is '$state'."
        [[ "$health" == unhealthy || "$health" == unknown ]] && fail "Service '$service' health is '$health'."
        [[ "$health" == starting ]] && warn "Service '$service' is still starting."
      fi
    else
      warn "Service '$service' is not in this Compose configuration."
    fi
  done
fi

if [[ -d "$SUPABASE_DIR" ]]; then
  use_pct="$(df -P "$SUPABASE_DIR" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
  if [[ "$use_pct" =~ ^[0-9]+$ ]]; then
    (( use_pct < 85 )) || fail "Disk usage is ${use_pct}% (must be below 85%)."
    (( use_pct < 75 )) || warn "Disk usage is ${use_pct}%; plan storage expansion."
  fi
fi

if [[ -d "$BACKUP_DIR" ]]; then
  latest="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'termly-schoolhosted-*.tar.gz.age' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2- || true)"
  if [[ -z "$latest" ]]; then
    fail "No encrypted backup found in $BACKUP_DIR."
  else
    age_seconds=$(( $(date +%s) - $(stat -c %Y "$latest") ))
    max_seconds=$(( REQUIRE_RECENT_BACKUP_HOURS * 3600 ))
    (( age_seconds <= max_seconds )) || fail "Latest backup is older than ${REQUIRE_RECENT_BACKUP_HOURS} hours: $latest"
    [[ -f "$latest.sha256" ]] || fail "Backup checksum sidecar missing: $latest.sha256"
  fi
else
  fail "Backup directory missing: $BACKUP_DIR"
fi

if [[ -n "$TERMLY_HEALTH_URL" ]]; then
  command -v curl >/dev/null 2>&1 || fail 'curl is required for TERMLY_HEALTH_URL.'
  if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --max-time 10 "$TERMLY_HEALTH_URL" >/dev/null || fail "Termly URL failed: $TERMLY_HEALTH_URL"
  fi
fi

if (( failures > 0 )); then
  echo "[Termly health] $failures check(s) failed." >&2
  exit 1
fi
echo '[Termly health] All required checks passed.'
