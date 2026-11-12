# Termly Phase 6 — Operations monitoring and support diagnostics

## Purpose

Phase 6 adds operational visibility to the Phase 2–5 **school-hosted web deployment**. It builds on the Phase 3 health-check and backup scripts; it does not replace them.

This phase provides:

- a root-owned monitor that checks the Termly web container, the Phase 3 Supabase/backend/backup health check, the configured HTTPS health endpoint and the Phase 5 installed-release status;
- a systemd timer that runs the check every five minutes;
- a small, allowlisted status JSON document and an admin-facing Settings panel;
- optional HTTPS webhook alerts on an incident transition, recovery and repeated unresolved incidents;
- an age-encrypted support bundle containing operational metadata only.

It is not a central multi-school monitoring service. Each school-hosted server monitors itself. No telemetry is sent to Termly unless the school deliberately configures a webhook endpoint, and no school database is queried by this monitor.

## 1. What the monitor checks

| Check | Source | Meaning |
|---|---|---|
| Termly web app | Phase 2 Docker Compose service `termly-web` and Docker health state | Container is running and its Nginx health check passes |
| Backend and backup | Existing Phase 3 `scripts/healthcheck-school-hosted.sh` | Supabase core services, disk usage, encrypted backup age and checksum sidecar |
| HTTPS endpoint | Configured `TERMLY_HEALTH_URL` | The school-facing HTTPS hostname can return the Nginx liveness response |
| Installed release | Phase 5 `termly-update-status.json` | Release metadata can be read and has a valid SemVer version |

The Phase 6 Nginx addition exposes `/healthz`, which returns only `200 ok`; it does not expose build metadata. The status file `/termly-health-status.json` contains only a timestamp, generic check labels/statuses and short generic messages. It contains no hostname, IP address, filesystem path, database URL, secrets, backup names or student information. The file is served as static content, so it is technically publicly readable wherever the Termly site is reachable; keep its schema minimal and do not add private diagnostic details to it.

The Settings panel is rendered only for administrators in the school-hosted deployment. It marks the report stale if no check has been recorded in the last 15 minutes, so an old green status is not displayed as current after the timer stops.

## 2. Apply the source patch

The patch assumes the Phase 2 school-hosted layout, the Phase 3 health-check script and the Phase 5 release-status integration are already in the working tree. Do not apply it to a repo that is missing those prerequisites. Have Antigravity reconcile the patch if your current files have moved; preserve existing local work.

```bash
git switch -c feat/termly-phase6-operations-monitoring
git apply --check patches/termly-phase6-operations-monitoring.patch
git apply patches/termly-phase6-operations-monitoring.patch
```

Then run the normal Termly app checks:

```bash
npm test -- --run
npm run build
```

Those project-level commands are not replaced by this package's focused tests.

## 3. Configure the school host

The sample monitor config is `deployment/school-hosted/monitor/monitor.env.example`. The installer copies it to `/etc/termly/monitor.env` only if the file does not already exist.

Review at least:

- `TERMLY_WEB_DIR`, `TERMLY_WEB_COMPOSE_FILE` and `TERMLY_WEB_ENV_FILE` — exact Phase 2 paths;
- `TERMLY_BACKUP_ENV` — the Phase 3 root-only backup config;
- `TERMLY_HEALTHCHECK_SCRIPT` — exact Phase 3 health-check script path;
- `TERMLY_HEALTH_URL` — the real school HTTPS hostname plus `/healthz` (the hostname must resolve from the server and its TLS certificate must be trusted by the server OS);
- `TERMLY_UPDATE_STATUS_FILE` and `TERMLY_HEALTH_STATUS_FILE` — the Phase 5 and Phase 6 runtime status files;
- `TERMLY_MONITOR_STATE_FILE` — private transition/alert state.

The alert webhook is optional. Set `TERMLY_ALERT_WEBHOOK_URL` only to a trusted **HTTPS** webhook that accepts a JSON `text` field. Keep the URL secret in `/etc/termly/monitor.env`; it is never included in the alert body or support bundle. The webhook provider's expected JSON format may differ, so test it with a school-controlled endpoint before relying on it.

Install the monitor:

```bash
sudo bash scripts/install-school-hosted-monitor.sh
sudoedit /etc/termly/monitor.env
sudo chmod 0600 /etc/termly/monitor.env
sudo chown root:root /etc/termly/monitor.env
```

The installer creates a root-owned systemd oneshot service and a five-minute persistent timer. It also creates the minimal status JSON file if absent.

## 4. Activate the web status endpoint

Phase 6 adds a read-only Compose mount for `runtime/termly-health-status.json`, plus Nginx routes for `/healthz` and `/termly-health-status.json`. Recreate only the Termly web container to apply those configuration changes:

```bash
sudo docker compose \
  --env-file /opt/termly/app/deployment/school-hosted/.env \
  -f /opt/termly/app/deployment/school-hosted/compose.yml \
  up -d --no-deps termly-web
```

Use the actual paths from `TERMLY_WEB_DIR`; the sample command assumes `/opt/termly/app/deployment/school-hosted`. This does not restart Supabase or migrate the database.

Run and inspect the first check:

```bash
sudo systemctl start termly-monitor.service
sudo systemctl status termly-monitor.service
sudo journalctl -u termly-monitor.service -n 80 --no-pager
sudo systemctl list-timers termly-monitor.timer
```

Confirm these URLs from a trusted browser and from the host:

- `https://termly.school.example/healthz` — should return `ok` with HTTP 200;
- `https://termly.school.example/termly-health-status.json` — should return the minimal status JSON.

Use the real hostname configured in `TERMLY_HEALTH_URL`, not the example domain.

## 5. Alert behaviour

When a webhook is configured, the monitor sends a generic alert when the overall state moves into `degraded` or `critical`, optionally sends a recovery message after a return to `healthy`, and repeats an unresolved alert at the configured interval (60 minutes by default). It does not send raw health-check output, URLs, paths, container IDs, environment values or database data.

A webhook delivery failure is recorded in the systemd journal. The local health check still runs; webhook delivery is not a prerequisite for the Termly web app or database to operate. Without a configured webhook, inspect the local status file and journal.

## 6. Generate an encrypted support bundle

Obtain a Termly support team's **age public recipient** through the approved support channel. The matching private age identity remains with the recipient; the school does not receive it.

Run as root:

```bash
sudo python3 tools/ops/build-support-bundle.py \
  --config /etc/termly/monitor.env \
  --recipient age1REPLACE_WITH_TERMLY_SUPPORT_RECIPIENT \
  --output /var/tmp/termly-support-school-a.tar.gz.age
```

The collector refuses to overwrite an existing output. It creates a `0600` encrypted archive and a SHA-256 sidecar. Send both through an approved secure channel.

The archive contains OS/kernel/architecture summary, software versions, disk summaries, filtered Compose service state, systemd timer state, encrypted-backup count/age/size metadata, safe Phase 5 release metadata, the allowlisted Phase 6 health report and file-presence/permission metadata.

It deliberately excludes:

- PostgreSQL database contents or SQL dumps;
- Supabase Storage files and uploaded photographs/documents;
- raw container/application logs (which might contain personal data or tokens);
- `.env` and secret configuration values;
- API keys, passwords, service-role keys, payment credentials, private signing keys and backup identities;
- student, parent, teacher or payment records.

This is intentionally a privacy-limited first-line support bundle, not a full forensic image. When a specific error requires logs, the school administrator must select and redact the relevant lines separately before sharing them.

## 7. Useful operator commands

```bash
# Run a one-off monitoring pass
sudo systemctl start termly-monitor.service

# Latest monitor output
sudo journalctl -u termly-monitor.service -n 100 --no-pager

# Timer state
sudo systemctl list-timers termly-monitor.timer

# Current allowlisted status
cat deployment/school-hosted/runtime/termly-health-status.json

# Stop scheduled monitoring without uninstalling it
sudo systemctl disable --now termly-monitor.timer
```

## 8. Validation and limitations

The focused tests verify status allowlisting, configuration permission handling, Docker-state interpretation, HTTPS-only checks/webhooks, transition payload privacy and support-bundle file selection/encryption invocation. The support-bundle test uses a mocked `age` executable to inspect archive contents; it is not a live encryption-key test.

This phase has **not** been tested against a live school server, real Docker/Supabase containers, an actual webhook provider, a real age support recipient, or the full Termly Vite build. The patch was checked against a synthetic Phase 5 integration fixture; Antigravity must still reconcile it with the current Termly branch and run the actual project tests/build.

The monitor is observational. It does not restart containers, repair database problems, restore backups, rotate credentials, validate application business logic, run portal workflows or prove that marks/payments/student records are correct. It is also local to one school server; it is not a Termly cloud fleet console. The `/healthz` endpoint verifies Nginx liveness, while the Phase 3 script verifies configured backend/backup conditions.
