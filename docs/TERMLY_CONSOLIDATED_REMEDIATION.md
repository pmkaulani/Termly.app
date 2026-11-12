# Termly consolidated remediation release

**Target repository:** `pmkaulani/Termly.app`  
**Target branch:** `feat/termly-phase6-operations-monitoring`  
**Inspected commit:** `730fb532cdc0caeb9a4de6c74b1f296d21d36b12`  
**Purpose:** harden the Phase 1–6 chain before merging it into `master`.

## What this remediation changes

### P0 — data integrity and destructive operations

- Adds a **new forward-only SQL migration** for the perpetual-licence trigger. Sparse `school_profiles` upserts now preserve existing signed licence claims instead of receiving neutral insert defaults and being rejected. The original Phase 4 migration is deliberately left unchanged because an existing database may already have applied it.
- Backup, restore and signed update now coordinate through one host maintenance lock. The updater/restore can invoke their own pre-operation backup without deadlocking.
- Restore no longer silently discards the optional extra-configuration archive. It stages its content in a root-protected `recovered-extra-config` directory for review instead of overwriting arbitrary absolute paths from an archive.
- After PostgreSQL becomes healthy, restore removes the temporary plaintext `previous-stack` and `db-config` copies. The encrypted pre-restore backup is retained as the rollback copy.
- Cancelling the first Super Admin deactivation confirmation now stops the operation.

### P1 — existing application and import workflows

- School owners receive the same Settings administration panels as Admin users.
- Student and teacher import duplicate checks use paginated live database reads, not an offline-first Dexie result that may be stale.
- Updating an existing student or teacher only writes non-blank values supplied by the file. Blank optional cells no longer erase existing contact details, subjects, status or identifiers; automatic student subject recalculation is not used for duplicate updates.
- Teacher status mapping preserves `Active`, `Left`, `Inactive`, `Suspended`, `Retired` and `On Leave`. Unknown non-empty statuses become validation errors instead of being silently converted to `Active`.
- Teacher capacity preflight counts existing staff being reactivated.
- Migration Center displays all seven columns with correct headings and explicitly warns that batch imports are not transactionally rolled back if a later batch fails.
- Super Admin Settings now invokes its supplied `loadData` callback after saving.

### P2 — deployment and quality gates

- Health and update status documents are served from a **directory bind mount**. This matters because the Phase 6 monitor writes with atomic file replacement; a single-file Docker bind mount can remain attached to the old inode.
- The Phase 5 updater passes `--no-build` when recreating the web service. Compose must use the image built from the verified signed release, not rebuild the checked-out source directory during the deployment/rollback.
- CI now targets `master`, uses Node 22, and makes Phase 3, Phase 5 and Phase 6 operational tests required steps. The Phase 5 and Phase 6 harnesses run under `sudo` so the root-only test paths are actually exercised.
- Adds a Node regression test suite covering import status/value rules, licence-trigger protection, status-file serving, shared locks, restore behavior, administrator safety and CI wiring.

### Licensing deployment boundary

The Phase 4 guide now makes the deployment distinction explicit: a central Termly Super Admin cannot change a record in a cloud database and thereby suspend a separate school's isolated school-hosted database. Suspension/restore in an isolated installation applies only to an administrator authenticated against that installation. A remote control plane would need a separately designed, authenticated and auditable channel; this remediation does not add a mandatory online check to perpetual installations.

## Applying the patch

1. Work from the current Phase 6 chain. Do not start from `master` alone.
2. Preserve all existing local/uncommitted changes. Commit or stash unrelated changes before applying, or ask Antigravity to reconcile the patch if the source anchors differ.
3. Extract this package into the Termly repository root, so the `patches/`, `docs/` and `tests/` folders merge into the corresponding repository folders.
4. From the repository root, run a non-writing source check:

   ```bash
   node patches/apply-termly-remediation.mjs --check
   ```

5. If the check passes, apply:

   ```bash
   node patches/apply-termly-remediation.mjs --apply
   ```

6. Inspect the result before doing anything else:

   ```bash
   git status --short
   git diff --check
   git diff
   ```

The patcher is deliberately conservative. It checks exact source anchors before writing any file, plans all edits first, and refuses to overwrite a file if a required anchor is missing, repeated or has drifted. If `--check` fails, no repository files are changed. Do not use broad replacement to force it through; have Antigravity reconcile that specific part with the current source.

This is a guarded Node.js patch runner, **not** a raw `git apply` unified-diff. It is designed to apply the reviewed changes to the matching Phase 6 source tree. A standalone copy of the new SQL migration is included under `database/` in this package for review.

## Required validation

Run from the repository root:

```bash
npm ci
npm test -- --run
npm run build
node --test tests/termly-remediation-regression.test.mjs
bash tests/test-phase3-backup.sh
bash scripts/run-phase5-tests.sh
bash scripts/run-phase6-tests.sh
```

The GitHub Actions workflow runs the complete application and operational suites on Node 22; it uses `sudo` for the Phase 5/6 harnesses that test root-only paths.

The patcher itself has been syntax-checked and exercised against a synthetic fixture containing the exact expected source anchors. The 8 new Node regression tests passed against the patched fixture. This does **not** replace running the full suite and build against the actual Termly checkout.

## Database deployment — important

The SQL fix is a **new forward migration**:

`supabase/migrations/20261111000200_fix_perpetual_profile_upsert_trigger.sql`

Do not edit or re-run `20261110000100_perpetual_school_licensing.sql` on databases where it has already been applied.

Apply the new migration to every affected database before deploying the matching application code:

- For the central Supabase project, use the established Termly migration process / `supabase db push` against the correct linked project.
- For school-hosted installations, include only this exact forward migration in the next signed Phase 5 release. Build the release with the reviewed migration selected and the backward-compatibility confirmation flag. The updater runs the included migration before replacing the web image.

Example release-builder arguments (use the normal vendor key and versioning procedure):

```bash
node tools/releases/build-release.mjs \
  --source . \
  --version <next-version> \
  --channel stable \
  --private-key termly-release-keys/release-private-key.pem \
  --out release-bundles/termly-<next-version> \
  --migration 20261111000200_fix_perpetual_profile_upsert_trigger.sql \
  --confirm-backward-compatible-migrations
```

Do not package the historical Phase 4 migration again. Confirm which exact schema migrations each school's database has already applied before including any other migration.

## Existing school-hosted servers

After deploying the patched Compose/Nginx files, recreate **only** the Termly web container so it receives the runtime-directory bind mount:

```bash
sudo docker compose \
  --env-file /opt/termly/app/deployment/school-hosted/.env \
  -f /opt/termly/app/deployment/school-hosted/compose.yml \
  up -d --no-deps --force-recreate termly-web
```

Replace the paths with that server's real `TERMLY_WEB_DIR`. This command does not migrate the database.

Use the same lock path in the host's root-only operations configuration if you override the default:

`/run/lock/termly-school-hosted-maintenance.lock`

After starting the Phase 6 monitor, confirm that `/termly-health-status.json` exposes an updated `checkedAt` after a monitor run. The directory mount is the essential correction; an individual status-file mount will reintroduce stale status.

### Restoring external configuration

The Phase 3 backup archives external config paths under `extra-config.tar.gz`. On `--apply`, the patched restore script decrypts and extracts that archive to:

`<BACKUP_DIR>/restore-rollback-<timestamp>/recovered-extra-config/`

It does not automatically overwrite host paths from the archive. Review the staged files and copy back only those that belong on this host (for example, the configured reverse-proxy file or Termly runtime config). This is intentional: external paths are administrator-defined, and silently extracting arbitrary absolute paths into `/` is not a safe restore default.

The temporary plaintext previous Supabase stack and its db-config copy are removed after PostgreSQL is confirmed healthy. The encrypted pre-restore archive remains the rollback source. Deletion from an SSD is not a guaranteed forensic secure erase; the host and backup volume should still use full-disk encryption and restrictive access.

## Known boundaries that this patch does not claim to solve

- Initial school-hosted installation still needs a controlled application of the full, ordered historical Termly SQL migration chain, Edge Function deployment/secrets and school-specific smoke tests. Phase 5's selected-migration updater is not a first-install schema bootstrapper.
- Student/teacher imports still commit progressively in batches. They now avoid stale duplicate decisions and blank-field overwrites and display the partial-import warning, but they do not provide an all-or-nothing transaction or automatic undo after some batches have committed. Reconcile the result before retrying.
- Phase 6 health checks run on the school host. A powered-off host cannot send its own webhook; production deployments still need an independent external watchdog if off-host outage detection is required.
- `/healthz` is an Nginx liveness response, not proof that login, marks, reports, photos, parent/staff portals or M-PESA workflows all work. Those still need real end-to-end acceptance tests.
- Remote suspension of an isolated perpetual school installation is not implemented. This patch documents the boundary; it does not add remote telemetry, DRM or a compulsory online licence check.
- The Phase 3/5 tests use mocks for Docker and `age`. They cannot prove a real customer's encrypted backup, database restore, storage restoration or M-PESA callback reachability. Perform a real restore drill on a disposable copy before onboarding a school.
- Electron and Android/iOS release/update processes remain separate from the school-hosted web updater.
