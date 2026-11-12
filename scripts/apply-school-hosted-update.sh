#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

CONFIG_FILE="${TERMLY_UPDATE_ENV:-/etc/termly/update.env}"
[[ -f "$CONFIG_FILE" ]] || { echo "Missing update configuration: $CONFIG_FILE" >&2; exit 1; }
# This is an administrator-managed root-only shell config file.
# shellcheck disable=SC1090
source "$CONFIG_FILE"

WEB_DIR="${TERMLY_WEB_DIR:-/opt/termly/app/deployment/school-hosted}"
SUPABASE_DIR="${SUPABASE_DIR:-/opt/termly/supabase}"
PUBLIC_KEY_FILE="${TERMLY_RELEASE_PUBLIC_KEY_FILE:-/etc/termly/release-public-key.pem}"
BACKUP_SCRIPT="${TERMLY_BACKUP_SCRIPT:-/opt/termly/app/scripts/backup-school-hosted.sh}"
BACKUP_ENV="${TERMLY_BACKUP_ENV:-/etc/termly/backup.env}"
VERIFY_SCRIPT="${TERMLY_VERIFY_SCRIPT:-/opt/termly/app/tools/releases/verify-release.mjs}"
STATUS_FILE="$WEB_DIR/runtime/termly-update-status.json"
RELEASE_DIR=""
DRY_RUN=0

fail() { echo "[Termly update] ERROR: $*" >&2; exit 1; }
usage() { echo "Usage: $0 --release-dir /path/to/extracted-release [--dry-run]"; }
while (($#)); do
  case "$1" in
    --release-dir) [[ $# -ge 2 ]] || { usage >&2; exit 2; }; RELEASE_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ -n "$RELEASE_DIR" ]] || { usage >&2; exit 2; }
[[ "$EUID" -eq 0 ]] || fail 'Run this command as root.'
for cmd in docker node sha256sum flock realpath; do command -v "$cmd" >/dev/null 2>&1 || fail "Missing required command: $cmd"; done
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 22 ]] || fail 'Node.js 22 or newer is required for the release verifier.'
[[ -d "$WEB_DIR" && -f "$WEB_DIR/compose.yml" && -f "$WEB_DIR/.env" ]] || fail "Termly web deployment is incomplete: $WEB_DIR"
[[ -d "$SUPABASE_DIR" && -f "$SUPABASE_DIR/docker-compose.yml" && -f "$SUPABASE_DIR/.env" ]] || fail "Supabase stack is incomplete: $SUPABASE_DIR"
[[ -f "$PUBLIC_KEY_FILE" ]] || fail "Vendor public release key is missing: $PUBLIC_KEY_FILE"
[[ -f "$VERIFY_SCRIPT" ]] || fail "Release verifier is missing: $VERIFY_SCRIPT"
[[ -f "$BACKUP_SCRIPT" && -f "$BACKUP_ENV" ]] || fail 'Phase 3 backup script/config must be installed before updates are allowed.'
RELEASE_DIR="$(realpath "$RELEASE_DIR")"
WEB_DIR="$(realpath "$WEB_DIR")"
SUPABASE_DIR="$(realpath "$SUPABASE_DIR")"

MAINTENANCE_LOCK_FILE="${TERMLY_MAINTENANCE_LOCK_FILE:-/run/lock/termly-school-hosted-maintenance.lock}"
install -d -m 0755 "$(dirname "$MAINTENANCE_LOCK_FILE")"
exec 9>"$MAINTENANCE_LOCK_FILE"
flock -n 9 || fail 'Another Termly backup, restore or update is running.'

dc() { docker compose --env-file "$WEB_DIR/.env" -f "$WEB_DIR/compose.yml" "$@"; }
sdc() { docker compose --env-file "$SUPABASE_DIR/.env" -f "$SUPABASE_DIR/docker-compose.yml" "$@"; }

VERIFY_JSON="$(node "$VERIFY_SCRIPT" --release-dir "$RELEASE_DIR" --public-key "$PUBLIC_KEY_FILE")" || fail 'Release signature or artifact verification failed.'
VERSION="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(x.version)' "$VERIFY_JSON")"
CHANNEL="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(x.channel)' "$VERIFY_JSON")"
MIGRATION_COUNT="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.migrations.length))' "$VERIFY_JSON")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$ ]] || fail 'Verified release version is not safe for an image tag.'
[[ "$CHANNEL" == stable ]] || fail 'This school updater only installs stable releases. Preview builds require a separate test installation.'

if [[ -f "$STATUS_FILE" ]]; then
  CURRENT_VERSION="$(node -e 'try { const x=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(x.version||"0.0.0")); } catch { process.stdout.write("0.0.0"); }' "$STATUS_FILE")"
else
  CURRENT_VERSION="0.0.0"
fi
node --input-type=module - "$CURRENT_VERSION" "$VERSION" "$(dirname "$VERIFY_SCRIPT")/release-utils.mjs" <<'NODE' || fail 'Release version is invalid or not newer than the installed version.'
import { pathToFileURL } from 'node:url';
const [current, next, utilsPath] = process.argv.slice(2);
const { compareSemver } = await import(pathToFileURL(utilsPath).href);
if (compareSemver(next, current) <= 0) process.exit(1);
NODE

mapfile -t IMAGES < <(dc config --images)
[[ "${#IMAGES[@]}" -eq 1 ]] || fail "Expected exactly one image in the Termly web Compose file; found ${#IMAGES[@]}."
COMPOSE_IMAGE="${IMAGES[0]}"
[[ "$COMPOSE_IMAGE" =~ ^[A-Za-z0-9._/:@-]+$ ]] || fail 'Compose image name contains unsupported characters.'
PREVIOUS_ID="$(docker image inspect --format '{{.Id}}' "$COMPOSE_IMAGE" 2>/dev/null || true)"
[[ -n "$PREVIOUS_ID" ]] || fail "Current Termly image does not exist: $COMPOSE_IMAGE. Complete the initial Phase 2 install first."

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[Termly update] DRY RUN: verified Termly $VERSION ($CHANNEL), $MIGRATION_COUNT signed migration(s)."
  echo "[Termly update] Current image: $COMPOSE_IMAGE ($PREVIOUS_ID)"
  echo '[Termly update] No backup, migration, image replacement or service restart was performed.'
  exit 0
fi

IMAGE_VERSION="${VERSION//+/_}"
NEW_IMAGE="termly-school-web:$IMAGE_VERSION"
docker build --tag "$NEW_IMAGE" --file "$RELEASE_DIR/Dockerfile" "$RELEASE_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ROLLBACK_TAG="termly-school-web:rollback-$STAMP"
docker image tag "$PREVIOUS_ID" "$ROLLBACK_TAG"

mkdir -p "$(dirname "$STATUS_FILE")"
if [[ -f "$STATUS_FILE" ]]; then cp -a "$STATUS_FILE" "$STATUS_FILE.pre-update-$STAMP"; fi
STATUS_BACKUP="$STATUS_FILE.pre-update-$STAMP"

# A verified Phase 3 cold backup is mandatory before any SQL or running-image change.
TERMLY_BACKUP_ENV="$BACKUP_ENV" TERMLY_MAINTENANCE_LOCK_HELD=1 "$BACKUP_SCRIPT" --label "pre-update-$VERSION"

# Track only release migrations. Existing historic migrations are not replayed.
if [[ "$MIGRATION_COUNT" -gt 0 ]]; then
  sdc exec -T db psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -c \
    'CREATE TABLE IF NOT EXISTS public.termly_release_migrations (migration_name text PRIMARY KEY, checksum text NOT NULL CHECK (checksum ~ $$^[0-9a-f]{64}$$), app_version text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()); REVOKE ALL ON TABLE public.termly_release_migrations FROM PUBLIC, anon, authenticated, service_role;'

  while IFS= read -r migration; do
    [[ -n "$migration" ]] || continue
    MIGRATION_NAME="${migration##*/}"
    [[ "$MIGRATION_NAME" =~ ^[A-Za-z0-9_.-]+\.sql$ ]] || fail "Unsafe migration name in verified manifest: $MIGRATION_NAME"
    MIGRATION_FILE="$RELEASE_DIR/$migration"
    [[ -f "$MIGRATION_FILE" && ! -L "$MIGRATION_FILE" ]] || fail "Migration file is not a regular file: $migration"
    CHECKSUM="$(sha256sum "$MIGRATION_FILE" | awk '{print $1}')"
    EXISTING="$(sdc exec -T db psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -Atqc \
      "SELECT checksum FROM public.termly_release_migrations WHERE migration_name = '$MIGRATION_NAME';" | tr -d '\r')"
    if [[ -n "$EXISTING" ]]; then
      [[ "$EXISTING" == "$CHECKSUM" ]] || fail "Previously applied migration has changed checksum: $MIGRATION_NAME"
      echo "[Termly update] Already applied: $MIGRATION_NAME"
      continue
    fi
    TMP_SQL="$(mktemp)"
    {
      cat "$MIGRATION_FILE"
      printf '\nINSERT INTO public.termly_release_migrations (migration_name, checksum, app_version) VALUES (%s, %s, %s);\n' \
        "'${MIGRATION_NAME}'" "'${CHECKSUM}'" "'${VERSION}'"
    } > "$TMP_SQL"
    if ! sdc exec -T db psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 --single-transaction -f - < "$TMP_SQL"; then
      rm -f "$TMP_SQL"
      fail "Migration failed and its transaction was rolled back: $MIGRATION_NAME. Existing app image remains active. Inspect the database before retrying."
    fi
    rm -f "$TMP_SQL"
    echo "[Termly update] Applied: $MIGRATION_NAME"
  done < <(node -e 'const x=JSON.parse(process.argv[1]); for(const m of x.migrations) console.log(m.path)' "$VERIFY_JSON")
fi

# Retag the signed new image to the image name used by the Phase 2 Compose service.
docker image tag "$NEW_IMAGE" "$COMPOSE_IMAGE"
node --input-type=module - "$STATUS_FILE" "$VERSION" "$CHANNEL" "$CURRENT_VERSION" "$MIGRATION_COUNT" <<'NODE'
import fs from 'node:fs';
const [file, version, channel, previousVersion, migrationCount] = process.argv.slice(2);
const now = new Date().toISOString();
const data = { product: 'termly', version, channel, previousVersion, installedAt: now, updatedAt: now, migrationCount: Number(migrationCount), updateMethod: 'signed-school-hosted-release' };
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 });
NODE

rollback_app() {
  echo '[Termly update] New app failed its health check. Restoring the previous web image...' >&2
  docker image tag "$PREVIOUS_ID" "$COMPOSE_IMAGE" || true
  cp -a "$STATUS_BACKUP" "$STATUS_FILE" 2>/dev/null || rm -f "$STATUS_FILE"
  dc up -d --no-build --no-deps --force-recreate termly-web || true
  echo "[Termly update] Previous app image restored from $PREVIOUS_ID. Database migrations are not automatically rolled back; use the Phase 3 recovery procedure only after review." >&2
}

if ! dc up -d --no-build --no-deps --force-recreate termly-web; then
  rollback_app
  fail 'Compose could not start the new Termly web container.'
fi

CONTAINER=""
HEALTH="starting"
for attempt in $(seq 1 40); do
  CONTAINER="$(dc ps -q termly-web 2>/dev/null || true)"
  if [[ -n "$CONTAINER" ]]; then
    HEALTH="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$CONTAINER" 2>/dev/null || echo missing)"
    [[ "$HEALTH" == healthy ]] && break
    [[ "$HEALTH" == unhealthy || "$HEALTH" == missing ]] && break
  fi
  sleep 5
done
if [[ "$HEALTH" != healthy ]]; then
  rollback_app
  fail "New Termly container did not become healthy (state: $HEALTH). The previous app image was restored; review migration compatibility and logs."
fi

rm -f "$STATUS_BACKUP"
echo "[Termly update] Successfully installed Termly $VERSION."
echo "[Termly update] Previous image retained as $ROLLBACK_TAG."
echo "[Termly update] Verified backup completed before migration/deployment. Keep the backup and rollback image until school acceptance checks pass."
