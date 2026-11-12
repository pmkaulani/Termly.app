#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
node --test tests/release-pipeline.test.mjs
python3 tests/test-safe-extract.py
bash tests/test-updater-dry-run.sh
for file in scripts/*.sh; do bash -n "$file"; done
for file in tools/releases/*.mjs; do node --check "$file"; done
python3 - <<'PYCODE'
from pathlib import Path
for name in ('tools/releases/extract-release.py', 'tests/test-safe-extract.py'):
    compile(Path(name).read_text(), name, 'exec')
PYCODE
printf '\nPhase 5 package checks passed. Live Docker, PostgreSQL and school-hosted rollout checks are still required.\n'
