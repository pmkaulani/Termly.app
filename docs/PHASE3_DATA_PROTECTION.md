# Termly Phase 3 — School data protection and recovery

## Goal

Phase 2 gives a school its own Termly web installation and Supabase backend. Phase 3 makes that deployment recoverable when a disk, server, bad upgrade, accidental deletion or other incident damages the installation.

This package adds:

- an encrypted, consistent cold backup of the self-hosted Supabase stack;
- PostgreSQL data, uploaded Storage files, Supabase configuration, Edge Function code and the `db-config` named volume in the same backup set;
- optional backup of external configuration files (for example Caddy and the Termly runtime config);
- daily systemd scheduling, retention and optional off-site copy through rclone;
- a restore inspection mode and a guarded restore mode;
- basic health checks for core Supabase services, disk usage and backup freshness.

The backup deliberately stops the Supabase Compose stack while it copies the database and Storage directories. This creates a cold, internally consistent filesystem snapshot for the pinned self-hosted deployment, but causes a maintenance interruption. Schedule it outside school hours and test the duration with realistic data before enabling a daily timer. The Termly web container may remain online but data operations will fail while Supabase is stopped.

## Requirements and assumptions

- Phase 2 is applied and the school uses the local official Supabase Docker Compose stack at `/opt/termly/supabase` (or the path in `backup.env`).
- The Supabase stack uses the standard self-hosted file Storage backend and its local `volumes/db/data` and `volumes/storage` paths.
- The pinned compose file has a `db` service, a `storage` service and the `db-config` volume mounted at `/etc/postgresql-custom`.
- Linux, Docker Engine, the Docker Compose plugin, GNU tar, `age`, `sha256sum`, `find`, and `systemd` for automatic scheduling.
- Enough free disk space in `BACKUP_TEMP_DIR` for the compressed temporary archives and in `BACKUP_DIR` for the final encrypted bundle. The plaintext staging directory is outside the backup destination by default (`/var/tmp`) and is deleted after the backup; large schools should point it to a protected temporary filesystem with enough capacity.

The target `self-hosted/v0.8.4` official Compose file persists Postgres at `./volumes/db/data`, file Storage at `./volumes/storage`, and mounts the `db-config` named volume at `/etc/postgresql-custom`. The scripts use those exact paths and the `db`/`storage` service names. Reference: [pinned official Supabase Compose file](https://github.com/supabase/supabase/blob/self-hosted/v0.8.4/docker/docker-compose.yml). The backup script intentionally fails rather than guessing if the expected local DB/Storage paths or services do not exist. If the school changes Storage to S3 or uses an external database, this package must be adapted to back up that external system; copying `volumes/storage` is not enough for an S3 backend.

## 1. Prepare encryption keys

Install `age` on the Linux server. Generate an age identity:

```bash
sudo install -d -m 700 /root/termly-backup-keys
sudo age-keygen -o /root/termly-backup-keys/backup-identity.txt
sudo chmod 600 /root/termly-backup-keys/backup-identity.txt
sudo age-keygen -y /root/termly-backup-keys/backup-identity.txt
```

The last command prints the public recipient (`age1...`). Put that public value in `/etc/termly/backup.env` as `AGE_RECIPIENT`. Keep the private `backup-identity.txt` offline or on a separate secured device. **Do not copy the private identity into the Termly repository, the backup directory, an ordinary staff laptop or the same off-site storage account as the backups.** Without that private identity, encrypted backups cannot be restored.

## 2. Configure a backup destination

Copy the example file to `/etc/termly/backup.env` and edit it:

```bash
sudo install -d -m 700 /etc/termly
sudo cp deployment/school-hosted/backup/backup.env.example /etc/termly/backup.env
sudo chmod 600 /etc/termly/backup.env
sudo nano /etc/termly/backup.env
```

Set `SUPABASE_DIR`, `BACKUP_DIR`, `BACKUP_TEMP_DIR` and `AGE_RECIPIENT`. Keep `BACKUP_EXPECTED_MOUNT` set to the actual mountpoint shown in the example, or clear it only when you intentionally use a non-mounted path. The backup script refuses to run when the configured expected mount is absent, preventing it from silently filling the server root disk. Prefer a dedicated mounted disk for `BACKUP_DIR`, not the same filesystem as the live database. Confirm the mount exists after reboot; do not silently back up to the root filesystem if the backup disk is absent.

For an independent off-site copy, install/configure rclone and set `RCLONE_REMOTE`, for example `school-backups:termly-school-a/`. The account/remote should have restricted write access and versioning/retention appropriate to the school. The script uploads the encrypted archive and its checksum only. It does not configure rclone credentials or remote retention for you.

Optional external configuration backup: create `/etc/termly/backup-extra-paths.txt` with one absolute path per line. Example:

```text
/etc/caddy/Caddyfile
/opt/termly/Termly.app/deployment/school-hosted/runtime/termly-runtime-config.js
```

The files are encrypted inside the archive. They are kept in `extra-config.tar.gz` and are not automatically written back during restore; an administrator should extract and review them separately.

## 3. Run a manual backup first

```bash
sudo TERMLY_BACKUP_ENV=/etc/termly/backup.env \
  bash scripts/backup-school-hosted.sh --label first-test
```

Expected output is an encrypted `termly-schoolhosted-....tar.gz.age` and a `.sha256` sidecar in `BACKUP_DIR`. The script stops the services that were running, snapshots files, encrypts the bundle, and starts the same services again. It does not delete any source data.

Check:

```bash
sudo ls -lh /mnt/termly-backups/
sudo sha256sum -c /mnt/termly-backups/termly-schoolhosted-....tar.gz.age.sha256
```

Verify that the off-site copy exists as well. A local backup on the same server is not disaster recovery if the server or disk is lost.

## 4. Inspect a backup without changing the live stack

Copy the private age identity securely to the server temporarily, or run this on a controlled recovery machine:

```bash
sudo AGE_IDENTITY_FILE=/secure/path/backup-identity.txt \
  TERMLY_BACKUP_ENV=/etc/termly/backup.env \
  bash scripts/restore-school-hosted.sh /mnt/termly-backups/termly-schoolhosted-....tar.gz.age --inspect
```

Inspect mode verifies the checksum sidecar (when present), decrypts the archive, validates all internal SHA-256 checksums, checks the archive paths, and prints the manifest. It does not stop containers or change live files.

## 5. Restore a school installation

A restore replaces the current Supabase configuration, PostgreSQL data, file Storage objects and `db-config` named volume. It should only be done by the server administrator during a maintenance window.

Before applying:

1. Confirm this is the correct school's backup and the school has approved the restore point.
2. Confirm the Supabase release pin matches the installation and the PostgreSQL major version matches. The script refuses an exact release-pin or Postgres major mismatch.
3. Confirm the server has enough free disk for both restored data and a pre-restore rollback copy.
4. Have the age private identity and the backup file available.
5. Stop staff use of Termly and notify users that the service is in maintenance.

Then run:

```bash
sudo AGE_IDENTITY_FILE=/secure/path/backup-identity.txt \
  TERMLY_BACKUP_ENV=/etc/termly/backup.env \
  bash scripts/restore-school-hosted.sh /mnt/termly-backups/termly-schoolhosted-....tar.gz.age --apply
```

The script requires typing the exact `RESTORE <backup filename>` confirmation. It first creates a new encrypted `pre-restore` backup of the current live system. It retains the previous unencrypted stack directory and its data under `BACKUP_DIR/restore-rollback-*` while the restore starts. That rollback directory contains student and school data in plaintext and must be protected as carefully as the live database. Delete it only after a verified application acceptance test and after confirming the encrypted backup is available off-site.

If the restored database does not become healthy, the script attempts to return the previous stack files and `db-config` volume. Always inspect Docker logs and verify the rollback status; do not assume a script message replaces a recovery drill.

After restore, test at minimum:

- admin/staff login and portal sessions;
- student, class, parent and staff records;
- fee balances, payments, receipts and M-PESA reconciliation;
- report cards, exam records, attendance and timetables;
- library loans and returned books;
- uploaded student/staff photos and other documents;
- Storage uploads/downloads and signed URLs;
- Edge Functions and their server-side secrets;
- realtime updates and the Termly web app URL.

External config paths from `extra-config.tar.gz` are for administrator review and manual restoration. Verify DNS, Caddy/TLS, M-PESA callback reachability, SMS/email credentials and any other services separately.

## 6. Enable daily backups

The included systemd unit schedules a daily backup at 02:30 server-local time. Set the host timezone to the school's intended timezone first (for Kenya, `Africa/Nairobi`):

```bash
sudo timedatectl set-timezone Africa/Nairobi
sudo bash scripts/install-school-hosted-backup-timer.sh
```

On first run, the installer creates `/etc/termly/backup.env` and exits. Edit the file, set a valid `AGE_RECIPIENT`, and run the installer again. Then check:

```bash
systemctl list-timers termly-backup.timer
sudo systemctl start termly-backup.service
sudo journalctl -u termly-backup.service -n 100 --no-pager
```

Do not enable the timer until a manual backup and an off-site copy have succeeded. `KEEP_DAYS` controls local encrypted backup retention. Remote retention is managed by the configured remote/provider.

## 7. Health checks

Run:

```bash
sudo TERMLY_BACKUP_ENV=/etc/termly/backup.env bash scripts/healthcheck-school-hosted.sh
```

This checks that core services have containers and are running, reports unhealthy containers, checks disk utilisation, verifies that a recent encrypted backup and checksum sidecar exist, and optionally requests `TERMLY_HEALTH_URL`.

For scheduled reporting, call this script from the school's existing monitoring/alerting service. This package does not set up an alert destination, remote metrics stack, or 24/7 support service.

## Operational boundaries

- This is a **cold backup**. It interrupts the Supabase backend while copying files. Choose an off-hours window and test actual duration.
- This is not point-in-time recovery. It restores to the time of the last completed backup.
- The built-in backup covers the official local PostgreSQL data directory, file Storage directory, `db-config`, functions, stack configuration and explicitly listed extra files. It cannot discover arbitrary external databases, S3 buckets, mail systems, M-PESA provider data, DNS or host TLS private keys automatically.
- It does not create a second server, replication cluster or automatic failover.
- Keep backups encrypted, access-controlled and off-site. Test restores at least quarterly and after material upgrades.
- Do not run the Supabase `reset.sh` on a production school stack; the upstream reset procedure destroys database and Storage data.
- This package does not automatically upgrade Supabase or apply Termly's complete SQL migration history. Upgrade/migration automation should be a separately reviewed phase, preceded by a successful backup and restore drill.
