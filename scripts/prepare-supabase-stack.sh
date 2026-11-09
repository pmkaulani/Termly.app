#!/usr/bin/env bash
set -euo pipefail

# Follows the official Supabase self-hosted Docker layout and pins a release.
# Review the official docs/release notes before changing SUPABASE_REF.
SUPABASE_REF="${SUPABASE_REF:-self-hosted/v0.8.4}"
INSTALL_DIR="${1:-/opt/termly/supabase}"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

for cmd in git docker openssl jq; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing prerequisite: $cmd" >&2; exit 1; }
done
docker compose version >/dev/null 2>&1 || { echo 'Docker Compose plugin is required.' >&2; exit 1; }

if [ -e "$INSTALL_DIR/docker-compose.yml" ]; then
  echo "Refusing to overwrite existing Supabase stack at $INSTALL_DIR" >&2
  echo 'Back it up and manage upgrades separately.' >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
git clone --depth 1 --branch "$SUPABASE_REF" https://github.com/supabase/supabase.git "$TMP_DIR/supabase"
cp -a "$TMP_DIR/supabase/docker/." "$INSTALL_DIR/"
printf 'ref=%s\n' "$SUPABASE_REF" > "$INSTALL_DIR/.supabase-version"

cd "$INSTALL_DIR"
[ -f .env ] || cp .env.example .env

# Official Supabase helpers generate random secrets and the new API key pair.
sh utils/generate-keys.sh
sh utils/add-new-auth-keys.sh

echo
echo "Supabase Docker files prepared at: $INSTALL_DIR"
echo 'BEFORE starting containers:'
echo '  1. Edit .env and replace every remaining example/default secret.'
echo '  2. Set SUPABASE_PUBLIC_URL, API_EXTERNAL_URL, SITE_URL and DASHBOARD_PASSWORD.'
echo '  3. Bind API_GW_HTTP_PORT to 127.0.0.1:8000 when using the supplied host Caddy reverse-proxy example.'
echo '  4. Keep POSTGRES_PASSWORD, SUPABASE_SECRET_KEY and JWT secrets server-side only.'
echo '  5. Review the exact release docs and docker compose config before `sh run.sh start`.'
echo
echo "Official guide: https://supabase.com/docs/guides/self-hosting/docker"
