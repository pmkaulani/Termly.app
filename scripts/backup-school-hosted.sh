#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${TERMLY_BACKUP_ENV:-/etc/termly/backup.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # This is an administrator-managed root-only shell config file.
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

SUPABASE_DIR="${SUPABASE_DIR:-/opt/termly/supabase}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/termly}"
BACKUP_TEMP_DIR="${BACKUP_TEMP_DIR:-${TMPDIR:-/var/tmp}}"
BACKUP_EXPECTED_MOUNT="${BACKUP_EXPECTED_MOUNT:-}"
AGE_RECIPIENT="${AGE_RECIPIENT:-}"
KEEP_DAYS="${KEEP_DAYS:-30}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"
EXTRA_CONFIG_PATHS_FILE="${EXTRA_CONFIG_PATHS_FILE:-}"
LABEL="manual"

usage() { echo "Usage: $0 [--label LABEL]"; }
while (($#)); do
  case "$1" in
    --label)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      LABEL="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
LABEL="${LABEL//[^A-Za-z0-9_-]/_}"

fail() { echo "[Termly backup] ERROR: $*" >&2; exit 1; }
for cmd in docker age tar sha256sum find awk date realpath; do
  command -v "$cmd" >/dev/null 2>&1 || fail "Missing required command: $cmd"
done
[[ "$AGE_RECIPIENT" == age1* ]] || fail "Set AGE_RECIPIENT to a valid age public recipient in $CONFIG_FILE."
[[ -d "$SUPABASE_DIR" ]] || fail "Supabase directory not found: $SUPABASE_DIR"
[[ -f "$SUPABASE_DIR/docker-compose.yml" ]] || fail "Missing docker-compose.yml in $SUPABASE_DIR"
[[ -f "$SUPABASE_DIR/.env" ]] || fail "Missing Supabase .env in $SUPABASE_DIR"
[[ -d "$SUPABASE_DIR/volumes/db/data" ]] || fail "Expected local PostgreSQL data path is missing: $SUPABASE_DIR/volumes/db/data"
[[ -d "$SUPABASE_DIR/volumes/storage" ]] || fail "Expected file-based Storage path is missing: $SUPABASE_DIR/volumes/storage"
[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || fail "KEEP_DAYS must be a non-negative integer."
if command -v flock >/dev/null 2>&1; then
  exec 9>/run/lock/termly-school-hosted-backup.lock
  flock -n 9 || fail 'Another Termly backup is already running.'
fi

SUPABASE_DIR="$(realpath "$SUPABASE_DIR")"
if [[ -n "$BACKUP_EXPECTED_MOUNT" ]]; then
  command -v mountpoint >/dev/null 2>&1 || fail 'mountpoint command is required when BACKUP_EXPECTED_MOUNT is set.'
  mountpoint -q "$BACKUP_EXPECTED_MOUNT" || fail "Expected backup filesystem is not mounted at $BACKUP_EXPECTED_MOUNT; refusing to write to the root disk."
fi
mkdir -p "$BACKUP_DIR" "$BACKUP_TEMP_DIR"
BACKUP_DIR="$(realpath "$BACKUP_DIR")"
BACKUP_TEMP_DIR="$(realpath "$BACKUP_TEMP_DIR")"
case "$BACKUP_DIR/" in
  "$SUPABASE_DIR/"*) fail "BACKUP_DIR must be outside SUPABASE_DIR; otherwise restore/backup files could be moved or re-archived." ;;
esac
if [[ -n "$BACKUP_EXPECTED_MOUNT" ]]; then
  EXPECTED_MOUNT="$(realpath "$BACKUP_EXPECTED_MOUNT")"
  case "$BACKUP_DIR/" in
    "$EXPECTED_MOUNT/"*) ;;
    *) fail "BACKUP_DIR ($BACKUP_DIR) is not inside BACKUP_EXPECTED_MOUNT ($EXPECTED_MOUNT)." ;;
  esac
fi
case "$BACKUP_TEMP_DIR/" in
  "$SUPABASE_DIR/"*) fail 'BACKUP_TEMP_DIR must be outside SUPABASE_DIR.' ;;
esac
chmod 700 "$BACKUP_DIR"
WORK="$(mktemp -d "$BACKUP_TEMP_DIR/termly-backup.XXXXXX")"
chmod 700 "$WORK"
STACK_STOPPED=0
RESTART_SERVICES=()

cd "$SUPABASE_DIR"
dc() { docker compose "$@"; }
restart_original_services() {
  if [[ "$STACK_STOPPED" == 1 && ${#RESTART_SERVICES[@]} -gt 0 ]]; then
    echo "[Termly backup] Restarting services that were running before the backup..."
    dc start "${RESTART_SERVICES[@]}" >/dev/null || echo "[Termly backup] WARNING: automatic service restart failed; run 'docker compose up -d' in $SUPABASE_DIR." >&2
    STACK_STOPPED=0
  fi
}
cleanup() {
  local rc=$?
  restart_original_services
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT

mapfile -t RESTART_SERVICES < <(dc ps --services --status running)
[[ " ${RESTART_SERVICES[*]} " == *" db "* ]] || fail "Supabase db service must be running before backup."
[[ " ${RESTART_SERVICES[*]} " == *" storage "* ]] || fail "Supabase storage service must be running (file-storage backup)."
DB_CONTAINER="$(dc ps -q db)"
[[ -n "$DB_CONTAINER" ]] || fail "Could not resolve the Supabase db container."

DB_HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$DB_CONTAINER")"
[[ "$DB_HEALTH" == healthy || "$DB_HEALTH" == running ]] || fail "Database is not healthy (state: $DB_HEALTH)."

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="termly-schoolhosted-${STAMP}-${LABEL}.tar.gz.age"
FINAL="$BACKUP_DIR/$BASE"
PARTIAL="$FINAL.partial"

printf '[Termly backup] Stopping the Supabase stack for a consistent cold snapshot...\n'
STACK_STOPPED=1
dc stop

mkdir -p "$WORK/db-config" "$WORK/extras"
# db-config is a named Docker volume in the pinned official Supabase stack.
# Copy it while the database container is stopped so the pgsodium key material is consistent.
docker cp "$DB_CONTAINER:/etc/postgresql-custom/." "$WORK/db-config/" >/dev/null

# Configuration archive includes .env, Edge Function source, SQL/bootstrap files,
# Supabase version pin and compose files, but excludes the two large data directories.
tar --warning=no-file-changed \
  --exclude='./volumes/db/data' --exclude='./volumes/storage' \
  -czf "$WORK/stack-config.tar.gz" -C "$SUPABASE_DIR" .

tar -czf "$WORK/postgres-data.tar.gz" -C "$SUPABASE_DIR/volumes/db/data" .
tar -czf "$WORK/storage-data.tar.gz" -C "$SUPABASE_DIR/volumes/storage" .
tar -czf "$WORK/db-config.tar.gz" -C "$WORK/db-config" .

if [[ -n "$EXTRA_CONFIG_PATHS_FILE" && -f "$EXTRA_CONFIG_PATHS_FILE" ]]; then
  while IFS= read -r raw_path || [[ -n "$raw_path" ]]; do
    raw_path="${raw_path%$'\r'}"
    [[ -z "$raw_path" || "$raw_path" == \#* ]] && continue
    [[ "$raw_path" == /* ]] || fail "Extra config paths must be absolute: $raw_path"
    [[ -e "$raw_path" ]] || fail "Extra config path does not exist: $raw_path"
    rel_path="${raw_path#/}"
    mkdir -p "$WORK/extras/$(dirname "$rel_path")"
    cp -a "$raw_path" "$WORK/extras/$rel_path"
  done < "$EXTRA_CONFIG_PATHS_FILE"
fi

tar -czf "$WORK/extra-config.tar.gz" -C "$WORK/extras" .

{
  echo "Termly school-hosted cold backup"
  echo "Created UTC: $STAMP"
  echo "Source directory: $SUPABASE_DIR"
  echo "Supabase release: $(cat "$SUPABASE_DIR/.supabase-version" 2>/dev/null || echo unknown)"
  echo "PostgreSQL major: $(cat "$SUPABASE_DIR/volumes/db/data/PG_VERSION" 2>/dev/null || echo unknown)"
  echo "Host: $(hostname -f 2>/dev/null || hostname)"
  echo "Included: Supabase compose/config, PostgreSQL data directory, file Storage objects, db-config named volume, optional external config paths"
  echo "Excluded: Docker image layers, logs, remote S3 objects (if S3 Storage is configured), external services not listed in EXTRA_CONFIG_PATHS_FILE"
} > "$WORK/manifest.txt"

(cd "$WORK" && sha256sum stack-config.tar.gz postgres-data.tar.gz storage-data.tar.gz db-config.tar.gz extra-config.tar.gz > SHA256SUMS)
tar -czf "$WORK/$BASE.tar.gz" -C "$WORK" \
  stack-config.tar.gz postgres-data.tar.gz storage-data.tar.gz db-config.tar.gz extra-config.tar.gz manifest.txt SHA256SUMS

# Encrypt the complete bundle before it is written to the backup destination.
age -r "$AGE_RECIPIENT" -o "$PARTIAL" "$WORK/$BASE.tar.gz"
chmod 600 "$PARTIAL"
mv "$PARTIAL" "$FINAL"
(cd "$BACKUP_DIR" && sha256sum "$BASE" > "$BASE.sha256")
chmod 600 "$FINAL" "$FINAL.sha256"

# Restart before optional remote copying/retention so a slow remote cannot extend downtime.
restart_original_services

if [[ -n "$RCLONE_REMOTE" ]]; then
  command -v rclone >/dev/null 2>&1 || fail "RCLONE_REMOTE is set but rclone is not installed."
  rclone copyto "$FINAL" "${RCLONE_REMOTE%/}/$BASE"
  rclone copyto "$FINAL.sha256" "${RCLONE_REMOTE%/}/$BASE.sha256"
else
  echo "[Termly backup] WARNING: no RCLONE_REMOTE set; this copy exists only on this server." >&2
fi

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'termly-schoolhosted-*.tar.gz.age' -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'termly-schoolhosted-*.tar.gz.age.sha256' -mtime "+$KEEP_DAYS" -delete

echo "[Termly backup] Encrypted backup created: $FINAL"
echo "[Termly backup] SHA-256: $(cut -d ' ' -f1 "$FINAL.sha256")"
