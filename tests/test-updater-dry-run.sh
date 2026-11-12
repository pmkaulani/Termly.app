#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "$EUID" -ne 0 ]]; then
  echo 'SKIP: updater dry-run harness requires root in order to exercise its privilege guard.'
  exit 0
fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/web/runtime" "$WORK/supabase" "$WORK/source/dist" "$WORK/source/deployment/school-hosted" "$WORK/backup"

cat > "$WORK/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" config --images "*) echo 'termly-school-web:local' ;;
  *" image inspect "*) echo 'sha256:previous-image-id' ;;
  *) echo "Unexpected Docker command during dry-run: $*" >&2; exit 90 ;;
esac
MOCK
chmod +x "$WORK/bin/docker"

printf 'TERMLY_WEB_BIND=127.0.0.1\n' > "$WORK/web/.env"
printf 'services: {}\n' > "$WORK/web/compose.yml"
printf 'POSTGRES_PASSWORD=dummy\n' > "$WORK/supabase/.env"
printf 'services: {}\n' > "$WORK/supabase/docker-compose.yml"
printf '{"product":"termly","version":"1.0.0","channel":"stable"}\n' > "$WORK/web/runtime/termly-update-status.json"
printf '<!doctype html><title>Termly test</title>\n' > "$WORK/source/dist/index.html"
printf 'server { listen 8080; }\n' > "$WORK/source/deployment/school-hosted/nginx.conf"
printf '# backup marker should never be written during dry-run\n#!/usr/bin/env bash\necho ran > "%s"\n' "$WORK/backup/ran" > "$WORK/backup/backup.sh"
chmod +x "$WORK/backup/backup.sh"
: > "$WORK/backup/backup.env"

export TERMLY_RELEASE_KEY_PASSPHRASE='phase-five-dry-run-passphrase-long'
node "$ROOT_DIR/tools/releases/generate-keypair.mjs" --out-dir "$WORK/keys" >/dev/null
node "$ROOT_DIR/tools/releases/build-release.mjs" \
  --source "$WORK/source" --version 1.1.0 \
  --private-key "$WORK/keys/release-private-key.pem" \
  --out "$WORK/release" >/dev/null
unset TERMLY_RELEASE_KEY_PASSPHRASE

cat > "$WORK/update.env" <<EOF2
TERMLY_WEB_DIR=$WORK/web
SUPABASE_DIR=$WORK/supabase
TERMLY_RELEASE_PUBLIC_KEY_FILE=$WORK/keys/release-public-key.pem
TERMLY_BACKUP_SCRIPT=$WORK/backup/backup.sh
TERMLY_BACKUP_ENV=$WORK/backup/backup.env
TERMLY_VERIFY_SCRIPT=$ROOT_DIR/tools/releases/verify-release.mjs
TERMLY_MAINTENANCE_LOCK_FILE=$WORK/maintenance.lock
EOF2
chmod 0600 "$WORK/update.env"

OUTPUT="$(PATH="$WORK/bin:$PATH" TERMLY_UPDATE_ENV="$WORK/update.env" \
  "$ROOT_DIR/scripts/apply-school-hosted-update.sh" --release-dir "$WORK/release" --dry-run)"
[[ "$OUTPUT" == *'DRY RUN: verified Termly 1.1.0'* ]]
[[ ! -e "$WORK/backup/ran" ]]
printf '%s\n' 'School updater dry-run passed with mocked Docker; no backup/deployment command was run.'
