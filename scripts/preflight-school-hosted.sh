#!/usr/bin/env bash
set -euo pipefail

MIN_RAM_KB=$((4 * 1024 * 1024))
MIN_DISK_KB=$((40 * 1024 * 1024))
RAM_KB=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
CPU_COUNT=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)
DISK_KB=$(df -Pk "${1:-/}" | awk 'NR==2 {print $4}')
WARN=0

printf 'Termly school-hosted server preflight\n'
printf 'CPU cores: %s (minimum 2; recommended 4+)\n' "$CPU_COUNT"
printf 'RAM: %.1f GiB (minimum 4 GiB; recommended 8 GiB+)\n' "$(awk -v n="$RAM_KB" 'BEGIN {print n/1048576}')"
printf 'Free disk: %.1f GiB (minimum 40 GiB SSD; recommended 80 GiB+)\n' "$(awk -v n="$DISK_KB" 'BEGIN {print n/1048576}')"

if ! command -v docker >/dev/null 2>&1; then echo 'ERROR: Docker Engine is not installed.'; exit 1; fi
if ! docker compose version >/dev/null 2>&1; then echo 'ERROR: Docker Compose plugin is not installed.'; exit 1; fi
if ! docker info >/dev/null 2>&1; then echo 'ERROR: Docker daemon is not running or current user lacks permission.'; exit 1; fi

if [ "$CPU_COUNT" -lt 2 ]; then echo 'WARNING: fewer than 2 CPU cores.'; WARN=1; fi
if [ "$RAM_KB" -lt "$MIN_RAM_KB" ]; then echo 'WARNING: less than 4 GiB RAM.'; WARN=1; fi
if [ "$DISK_KB" -lt "$MIN_DISK_KB" ]; then echo 'WARNING: less than 40 GiB free disk.'; WARN=1; fi

if [ "$WARN" -eq 1 ]; then
  echo 'Preflight completed with capacity warnings. Do not put production student data on an undersized host.'
else
  echo 'Preflight passed the documented minimum checks. Recommended headroom is still 8 GiB RAM, 4+ cores and 80 GiB+ SSD.'
fi
