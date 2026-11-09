#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/supabase/volumes/db/data" "$TMP/supabase/volumes/storage" "$TMP/mock-db-config"
printf '17\n' > "$TMP/supabase/volumes/db/data/PG_VERSION"
printf 'database fixture\n' > "$TMP/supabase/volumes/db/data/base.fixture"
printf 'storage fixture\n' > "$TMP/supabase/volumes/storage/document.fixture"
printf 'ref=self-hosted/v0.8.4\n' > "$TMP/supabase/.supabase-version"
printf 'name: supabase\nservices:\n  db:\n    image: supabase/postgres:17.6.1.136\n  storage:\n    image: supabase/storage-api:test\n' > "$TMP/supabase/docker-compose.yml"
printf 'POSTGRES_PASSWORD=test-only\n' > "$TMP/supabase/.env"
printf 'pgsodium key fixture\n' > "$TMP/mock-db-config/pgsodium_root.key"

cat > "$TMP/bin/docker" <<'MOCK_DOCKER'
#!/usr/bin/env bash
set -e
if [[ "$1" == compose ]]; then
  shift
  case "${1:-}" in
    ps)
      shift
      if [[ " ${*} " == *" --services "* ]]; then printf 'db\nstorage\napi-gw\n';
      elif [[ " ${*} " == *" -q db "* || " ${*} " == *" ps -q db "* ]]; then printf 'mock-db-id\n'; fi
      ;;
    stop|start) exit 0 ;;
    *) exit 0 ;;
  esac
elif [[ "$1" == inspect ]]; then
  printf 'healthy\n'
elif [[ "$1" == cp ]]; then
  src="$2"; dest="$3"
  [[ "$src" == mock-db-id:/etc/postgresql-custom/. ]] || exit 12
  mkdir -p "$dest"
  cp -a "$MOCK_DB_CONFIG"/. "$dest"/
else
  exit 0
fi
MOCK_DOCKER
chmod +x "$TMP/bin/docker"

cat > "$TMP/bin/age" <<'MOCK_AGE'
#!/usr/bin/env bash
set -e
out=''; input=''
while (($#)); do
  case "$1" in
    -r) shift 2 ;;
    -d) shift ;;
    -i) shift 2 ;;
    -o) out="$2"; shift 2 ;;
    *) input="$1"; shift ;;
  esac
done
[[ -n "$out" && -f "$input" ]] || exit 4
cp "$input" "$out"
MOCK_AGE
chmod +x "$TMP/bin/age"

cat > "$TMP/backup.env" <<EOF_ENV
SUPABASE_DIR=$TMP/supabase
BACKUP_DIR=$TMP/backups
BACKUP_TEMP_DIR=$TMP/temp-work
AGE_RECIPIENT=age1mockrecipient
KEEP_DAYS=30
EOF_ENV

export PATH="$TMP/bin:$PATH"
export MOCK_DB_CONFIG="$TMP/mock-db-config"
export TERMLY_BACKUP_ENV="$TMP/backup.env"
"$ROOT/scripts/backup-school-hosted.sh" --label test

BACKUP="$(find "$TMP/backups" -maxdepth 1 -name '*.tar.gz.age' -type f | head -n1)"
[[ -n "$BACKUP" ]]
[[ -f "$BACKUP.sha256" ]]
(cd "$TMP/backups" && sha256sum -c "$(basename "$BACKUP").sha256")

# Mock age produces the archive bytes directly, allowing us to inspect the tar structure.
for entry in stack-config.tar.gz postgres-data.tar.gz storage-data.tar.gz db-config.tar.gz extra-config.tar.gz manifest.txt SHA256SUMS; do
  tar -tzf "$BACKUP" | grep -qx "$entry"
done
mkdir "$TMP/extracted"
tar -xzf "$BACKUP" -C "$TMP/extracted"
(cd "$TMP/extracted" && sha256sum -c SHA256SUMS)
tar -xOf "$TMP/extracted/postgres-data.tar.gz" ./PG_VERSION | grep -qx '17'
tar -xOf "$TMP/extracted/storage-data.tar.gz" ./document.fixture | grep -qx 'storage fixture'
tar -xOf "$TMP/extracted/db-config.tar.gz" ./pgsodium_root.key | grep -qx 'pgsodium key fixture'

touch "$TMP/mock-age-identity.txt"
AGE_IDENTITY_FILE="$TMP/mock-age-identity.txt" TERMLY_BACKUP_ENV="$TMP/backup.env" \
  "$ROOT/scripts/restore-school-hosted.sh" "$BACKUP" --inspect

echo 'Phase 3 backup smoke test passed (mock Docker and age; no real encryption or database was used).'
