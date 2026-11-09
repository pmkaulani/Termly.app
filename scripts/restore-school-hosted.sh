#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${TERMLY_BACKUP_ENV:-/etc/termly/backup.env}"
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi
SUPABASE_DIR="${SUPABASE_DIR:-/opt/termly/supabase}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/termly}"
BACKUP_TEMP_DIR="${BACKUP_TEMP_DIR:-${TMPDIR:-/var/tmp}}"
AGE_IDENTITY_FILE="${AGE_IDENTITY_FILE:-}"
MODE="inspect"
BACKUP_FILE=""

usage() {
  cat <<USAGE
Usage:
  $0 BACKUP.age                         # decrypt, verify and inspect only
  AGE_IDENTITY_FILE=/secure/key.txt $0 BACKUP.age --inspect
  AGE_IDENTITY_FILE=/secure/key.txt $0 BACKUP.age --apply

--apply restores PostgreSQL, file Storage, Supabase config and db-config.
It creates an encrypted pre-restore backup first and requires a typed confirmation.
USAGE
}
while (($#)); do
  case "$1" in
    --inspect) MODE=inspect; shift ;;
    --apply) MODE=apply; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) usage >&2; exit 2 ;;
    *) [[ -z "$BACKUP_FILE" ]] || { usage >&2; exit 2; }; BACKUP_FILE="$1"; shift ;;
  esac
done
[[ -n "$BACKUP_FILE" ]] || { usage >&2; exit 2; }
[[ -f "$BACKUP_FILE" ]] || { echo "Backup file not found: $BACKUP_FILE" >&2; exit 1; }
[[ -n "$AGE_IDENTITY_FILE" && -f "$AGE_IDENTITY_FILE" ]] || { echo 'Set AGE_IDENTITY_FILE to the private age identity file (keep it offline).' >&2; exit 1; }
for cmd in age tar sha256sum; do command -v "$cmd" >/dev/null 2>&1 || { echo "Missing required command: $cmd" >&2; exit 1; }; done

BACKUP_FILE="$(realpath "$BACKUP_FILE")"
if [[ -f "$BACKUP_FILE.sha256" ]]; then
  (cd "$(dirname "$BACKUP_FILE")" && sha256sum -c "$(basename "$BACKUP_FILE").sha256")
else
  echo '[Termly restore] WARNING: no SHA-256 sidecar found; age authentication still protects ciphertext integrity.' >&2
fi

mkdir -p "$BACKUP_TEMP_DIR"
WORK="$(mktemp -d "$BACKUP_TEMP_DIR/termly-restore.XXXXXX")"
chmod 700 "$WORK"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

age -d -i "$AGE_IDENTITY_FILE" -o "$WORK/bundle.tar.gz" "$BACKUP_FILE"
# Reject absolute paths, traversal and links before extracting any archive layer.
safe_tar() {
  local archive="$1"
  if tar -tzf "$archive" | awk 'BEGIN{bad=0} /^\//{bad=1} /(^|\/)\.\.($|\/)/{bad=1} END{exit bad ? 0 : 1}'; then
    echo "[Termly restore] Unsafe path found in $archive; refusing to extract." >&2
    return 1
  fi
  if tar -tvzf "$archive" | awk 'substr($0,1,1)=="l" || substr($0,1,1)=="h" {bad=1} END{exit bad ? 0 : 1}'; then
    echo "[Termly restore] Symlink/hardlink found in $archive; refusing to extract." >&2
    return 1
  fi
}
safe_tar "$WORK/bundle.tar.gz"
mkdir -p "$WORK/bundle"
tar -xzf "$WORK/bundle.tar.gz" -C "$WORK/bundle"
for item in stack-config.tar.gz postgres-data.tar.gz storage-data.tar.gz db-config.tar.gz extra-config.tar.gz manifest.txt SHA256SUMS; do
  [[ -f "$WORK/bundle/$item" ]] || { echo "Backup is incomplete: missing $item" >&2; exit 1; }
done
for component in stack-config.tar.gz postgres-data.tar.gz storage-data.tar.gz db-config.tar.gz extra-config.tar.gz; do safe_tar "$WORK/bundle/$component"; done
(cd "$WORK/bundle" && sha256sum -c SHA256SUMS)

BACKUP_PG_VERSION="$(tar -xOf "$WORK/bundle/postgres-data.tar.gz" ./PG_VERSION 2>/dev/null || true)"
[[ -n "$BACKUP_PG_VERSION" ]] || BACKUP_PG_VERSION="$(tar -xOf "$WORK/bundle/postgres-data.tar.gz" PG_VERSION 2>/dev/null || true)"
[[ -n "$BACKUP_PG_VERSION" ]] || { echo 'Could not read PostgreSQL PG_VERSION from backup.' >&2; exit 1; }
BACKUP_SUPABASE_REF="$(tar -xOf "$WORK/bundle/stack-config.tar.gz" ./.supabase-version 2>/dev/null || true)"
[[ -n "$BACKUP_SUPABASE_REF" ]] || BACKUP_SUPABASE_REF="$(tar -xOf "$WORK/bundle/stack-config.tar.gz" .supabase-version 2>/dev/null || true)"

if [[ "$MODE" == inspect ]]; then
  echo
  echo '--- Backup manifest ---'
  cat "$WORK/bundle/manifest.txt"
  echo
  echo "PostgreSQL major version: $BACKUP_PG_VERSION"
  echo "Supabase release pin: ${BACKUP_SUPABASE_REF:-not recorded}"
  echo 'Verified: encrypted bundle decrypted and all component SHA-256 checks passed.'
  echo 'No live files or containers were changed.'
  exit 0
fi

[[ "$EUID" -eq 0 ]] || { echo 'Run --apply as root (for example, sudo) so PostgreSQL file ownership is preserved.' >&2; exit 1; }
[[ -d "$SUPABASE_DIR" && -f "$SUPABASE_DIR/docker-compose.yml" ]] || { echo "Current Supabase stack not found: $SUPABASE_DIR" >&2; exit 1; }
SUPABASE_DIR="$(realpath "$SUPABASE_DIR")"
BACKUP_DIR="$(realpath -m "$BACKUP_DIR")"
case "$BACKUP_DIR/" in
  "$SUPABASE_DIR/"*) echo 'BACKUP_DIR must be outside SUPABASE_DIR.' >&2; exit 1 ;;
esac
CURRENT_REF="$(cat "$SUPABASE_DIR/.supabase-version" 2>/dev/null || true)"
[[ -n "$CURRENT_REF" && -n "$BACKUP_SUPABASE_REF" && "$CURRENT_REF" == "$BACKUP_SUPABASE_REF" ]] || {
  echo "Supabase release mismatch (current='$CURRENT_REF', backup='$BACKUP_SUPABASE_REF'). Refusing to restore across releases." >&2; exit 1;
}
POSTGRES_IMAGE="$(grep -E '^[[:space:]]*image:[[:space:]]*supabase/postgres:' "$SUPABASE_DIR/docker-compose.yml" | head -n1 | sed -E 's/.*supabase\/postgres:([0-9]+).*/\1/')"
[[ -n "$POSTGRES_IMAGE" && "$POSTGRES_IMAGE" == "$BACKUP_PG_VERSION" ]] || {
  echo "PostgreSQL major mismatch (current image major='$POSTGRES_IMAGE', backup='$BACKUP_PG_VERSION'). Refusing restore." >&2; exit 1;
}

# Require current database and Storage services to be running before creating the rollback snapshot.
cd "$SUPABASE_DIR"
dc() { docker compose "$@"; }
mapfile -t RUNNING < <(dc ps --services --status running)
[[ " ${RUNNING[*]} " == *" db "* ]] || { echo 'Current db service must be running.' >&2; exit 1; }
[[ " ${RUNNING[*]} " == *" storage "* ]] || { echo 'Current storage service must be running.' >&2; exit 1; }

CONFIRM="RESTORE $(basename "$BACKUP_FILE")"
echo
cat "$WORK/bundle/manifest.txt"
echo
printf 'This will replace the current Supabase data and configuration. Type exactly:\n%s\n> ' "$CONFIRM"
read -r ANSWER
[[ "$ANSWER" == "$CONFIRM" ]] || { echo 'Confirmation did not match; no changes made.'; exit 1; }

# Make a second encrypted snapshot of the current installation before replacing it.
"$SCRIPT_DIR/backup-school-hosted.sh" --label pre-restore

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ROLLBACK_DIR="$BACKUP_DIR/restore-rollback-$STAMP"
mkdir -p "$ROLLBACK_DIR/db-config"
chmod 700 "$ROLLBACK_DIR"
CURRENT_DB_CONTAINER="$(dc ps -q db)"
docker cp "$CURRENT_DB_CONTAINER:/etc/postgresql-custom/." "$ROLLBACK_DIR/db-config/" >/dev/null

RESTORE_STARTED=0
rollback_restore() {
  local rc=$?
  if [[ "$RESTORE_STARTED" == 1 && -d "$ROLLBACK_DIR/previous-stack" ]]; then
    echo '[Termly restore] Restore did not complete. Attempting to put the previous stack back...' >&2
    (cd "$SUPABASE_DIR" && docker compose down) >/dev/null 2>&1 || true
    rm -rf "$SUPABASE_DIR"
    mv "$ROLLBACK_DIR/previous-stack" "$SUPABASE_DIR"
    (cd "$SUPABASE_DIR" && docker compose run --rm --no-deps --entrypoint /bin/sh db -c 'find /etc/postgresql-custom -mindepth 1 -maxdepth 1 -exec rm -rf {} +') >/dev/null 2>&1 || true
    (cd "$SUPABASE_DIR" && docker compose create db) >/dev/null 2>&1 || true
    local old_db
    old_db="$(cd "$SUPABASE_DIR" && docker compose ps -aq db)"
    if [[ -n "$old_db" ]]; then docker cp "$ROLLBACK_DIR/db-config/." "$old_db:/etc/postgresql-custom/" >/dev/null 2>&1 || true; fi
    (cd "$SUPABASE_DIR" && docker compose up -d) >/dev/null 2>&1 || true
    echo "[Termly restore] Previous files were returned. Check services and logs. Rollback copy: $ROLLBACK_DIR" >&2
  fi
  exit "$rc"
}
trap rollback_restore ERR

# Remove containers/network but deliberately retain named volumes (including db-config).
dc down
mv "$SUPABASE_DIR" "$ROLLBACK_DIR/previous-stack"
mkdir -p "$SUPABASE_DIR"
RESTORE_STARTED=1

tar -xzf "$WORK/bundle/stack-config.tar.gz" -C "$SUPABASE_DIR"
mkdir -p "$SUPABASE_DIR/volumes/db/data" "$SUPABASE_DIR/volumes/storage"
tar --numeric-owner -xpf "$WORK/bundle/postgres-data.tar.gz" -C "$SUPABASE_DIR/volumes/db/data"
tar --numeric-owner -xpf "$WORK/bundle/storage-data.tar.gz" -C "$SUPABASE_DIR/volumes/storage"
mkdir -p "$WORK/db-config"
tar -xzf "$WORK/bundle/db-config.tar.gz" -C "$WORK/db-config"

cd "$SUPABASE_DIR"
# Reset the retained named volume, create a stopped db container to attach it, then copy its snapshot.
docker compose run --rm --no-deps --entrypoint /bin/sh db -c 'find /etc/postgresql-custom -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
docker compose create db
NEW_DB_CONTAINER="$(docker compose ps -aq db)"
[[ -n "$NEW_DB_CONTAINER" ]] || { echo 'Could not create a db container to restore the db-config volume.' >&2; false; }
docker cp "$WORK/db-config/." "$NEW_DB_CONTAINER:/etc/postgresql-custom/" >/dev/null
docker compose up -d

# Wait for Postgres readiness. A healthy database is necessary before handing control back.
READY=0
for _ in $(seq 1 90); do
  DB_ID="$(docker compose ps -q db)"
  if [[ -n "$DB_ID" ]]; then
    STATE="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$DB_ID" 2>/dev/null || true)"
    if [[ "$STATE" == healthy ]]; then READY=1; break; fi
  fi
  sleep 2
done
[[ "$READY" == 1 ]] || { echo 'Postgres did not become healthy after restore.' >&2; false; }

docker compose ps
RESTORE_STARTED=0
trap - ERR

echo "[Termly restore] Database is healthy. Previous installation retained at: $ROLLBACK_DIR/previous-stack"
echo '[Termly restore] Run the application acceptance checklist before deleting that rollback copy.'
