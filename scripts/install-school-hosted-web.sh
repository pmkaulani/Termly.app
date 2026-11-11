#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_DIR="$ROOT_DIR/deployment/school-hosted"

"$ROOT_DIR/scripts/preflight-school-hosted.sh" "$ROOT_DIR"

if [ ! -f "$DEPLOY_DIR/runtime/termly-runtime-config.js" ]; then
  echo 'Missing runtime config. Run: node scripts/configure-runtime.mjs' >&2
  exit 1
fi

if [ ! -f "$DEPLOY_DIR/runtime/termly-update-status.json" ]; then
  cp "$DEPLOY_DIR/runtime/termly-update-status.json.example" "$DEPLOY_DIR/runtime/termly-update-status.json"
fi

if [ ! -f "$DEPLOY_DIR/runtime/termly-health-status.json" ]; then
  cp "$DEPLOY_DIR/runtime/termly-health-status.json.example" "$DEPLOY_DIR/runtime/termly-health-status.json"
fi

if [ ! -f "$DEPLOY_DIR/.env" ]; then
  cp "$DEPLOY_DIR/.env.example" "$DEPLOY_DIR/.env"
  echo "Created $DEPLOY_DIR/.env from example. Review TERMLY_WEB_BIND and TERMLY_WEB_PORT."
fi

cd "$DEPLOY_DIR"
docker compose --env-file .env -f compose.yml up -d --build
docker compose --env-file .env -f compose.yml ps
