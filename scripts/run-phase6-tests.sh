#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

python3 -m unittest discover -s tests -p 'test_phase6_*.py' -v
node --test tests/termly-remediation-regression.test.mjs
bash -n scripts/install-school-hosted-monitor.sh
python3 - <<'PY'
from pathlib import Path
for path in [
    Path('tools/ops/ops_core.py'),
    Path('tools/ops/monitor-school-hosted.py'),
    Path('tools/ops/build-support-bundle.py'),
]:
    compile(path.read_text(encoding='utf-8'), str(path), 'exec')
print('Python syntax checks passed.')
PY

echo 'Phase 6 tests and syntax checks passed.'
