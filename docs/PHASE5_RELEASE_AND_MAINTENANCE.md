# Termly Phase 5 — Signed releases, updates and maintenance

## Goal and scope

Phase 5 provides a controlled release pipeline for Termly's **school-hosted web edition**. Termly builds a release bundle, signs its manifest, and supplies that bundle to an eligible school. The school server verifies the signature and file digests before backing up, applying selected migrations and replacing the web image.

Cloud-hosted deployments keep their existing hosting/update process. Electron and Android/iOS packaged releases are not covered by this phase; they need their own signed installers and platform-specific migration/rollback plans.

A perpetual school may continue using the version it purchased. The support-through date in Phase 4 describes the commercial period in which Termly provides support/future release access; it does not lock the installed version. For now, Termly controls distribution of future signed bundles manually. This phase does not implement online DRM or an automatic update entitlement service.

## 1. Separate release-signing keys

Release signing is separate from Phase 4 product licensing. Do not reuse a Phase 4 licence-signing keypair.

Run on a secure Termly/vendor machine only:

```powershell
$env:TERMLY_RELEASE_KEY_PASSPHRASE = 'a-unique-long-passphrase-from-your-password-manager'
node tools/releases/generate-keypair.mjs --out-dir termly-release-keys
Remove-Item Env:TERMLY_RELEASE_KEY_PASSPHRASE
```

Outputs:

- `termly-release-keys/release-private-key.pem` — encrypted private Ed25519 key; vendor-only.
- `termly-release-keys/release-public-key.pem` — public verification key; this is the only key copied to school hosts.

Back up the encrypted private key and passphrase separately. Losing the private key means Termly cannot issue new releases for that key. The school host must never receive it.

## 2. Build Termly and create a signed release

From the Termly source root, run the usual test/build workflow first. The release tool consumes the already-built Vite `dist/` output and Phase 2 Nginx config:

```powershell
npm test -- --run
npm run build
$env:TERMLY_RELEASE_KEY_PASSPHRASE = 'the-same-vendor-passphrase'
node tools/releases/build-release.mjs `
  --source . `
  --version 1.2.0 `
  --channel stable `
  --private-key termly-release-keys/release-private-key.pem `
  --out release-bundles/termly-1.2.0
Remove-Item Env:TERMLY_RELEASE_KEY_PASSPHRASE
```

The bundle contains the static `dist/`, a release-specific Nginx Dockerfile, Nginx configuration, a signed JSON manifest and detached Ed25519 signature. All included files have SHA-256 digests and sizes in the manifest.

### Include database migrations only when needed

Use `--migration <exact-file-name>` once per new SQL migration, and add `--confirm-backward-compatible-migrations` only after a database engineer has reviewed every included migration:

```powershell
node tools/releases/build-release.mjs `
  --source . `
  --version 1.2.1 `
  --private-key termly-release-keys/release-private-key.pem `
  --out release-bundles/termly-1.2.1 `
  --migration 20261110000100_perpetual_school_licensing.sql `
  --confirm-backward-compatible-migrations
```

This example is illustrative; do not include an old migration that already ran in that school database. Include only migrations intended for the customer's current schema. Existing historical migrations are not automatically replayed or inferred by this updater.

The builder rejects explicit `BEGIN`/`COMMIT`/`ROLLBACK`, `CREATE INDEX CONCURRENTLY`, psql client meta-commands and symbolic links in automatic migration inputs. A reviewer must still ensure a migration is additive/forward-compatible with the old app, because successful migrations are not automatically reversed if a later stage fails.

The `release-manifest.json` and `release-manifest.sig` files are part of the deliverable. To create a ZIP without an extra parent folder:

```powershell
Compress-Archive -Path release-bundles/termly-1.2.0/* -DestinationPath termly-1.2.0.termly-release.zip
```

Never include `termly-release-keys/` in a release archive.

## 3. Prepare the school host

Prerequisites:

- Phase 2 school-hosted web installation is working.
- Phase 3 encrypted backup and restore scripts are installed and a backup has already been test-restored.
- Docker Engine/Compose v2, Node.js 22+, Python 3 and PostgreSQL access through the pinned local Supabase `db` service are available.
- The Termly web Compose deployment contains exactly one `termly-web` service and one current image, unless the updater has been explicitly adapted for the local stack.

Copy the Phase 5 package to the Termly source checkout on the host, then:

```bash
sudo ./scripts/install-school-hosted-updater.sh
sudo install -m 0644 release-public-key.pem /etc/termly/release-public-key.pem
sudo chown root:root /etc/termly/release-public-key.pem
sudo chmod 0644 /etc/termly/release-public-key.pem
sudoedit /etc/termly/update.env
sudo chmod 0600 /etc/termly/update.env
sudo chown root:root /etc/termly/update.env
```

Use the **release public key** generated for Phase 5, not the Phase 4 licence public key. The installer creates `/etc/termly/update.env` only if it does not exist. Review every path; do not assume `/opt/termly/app` if the local installation uses another location.

After confirming `TERMLY_WEB_DIR`, ensure that directory contains `runtime/termly-update-status.json` (copy it from `runtime/termly-update-status.json.example` if needed). Apply the new read-only status-file bind mount to the existing web container without rebuilding its image:

```bash
sudo docker compose --env-file /opt/termly/app/deployment/school-hosted/.env \
  -f /opt/termly/app/deployment/school-hosted/compose.yml \
  up -d --no-deps termly-web
```

Replace the paths with the exact `TERMLY_WEB_DIR` value in your updater configuration. This recreates only the Termly web container so it mounts the status file; it does not run a database migration.

The updater configuration points to:

- the Phase 2 Termly web Compose directory;
- the school-hosted Supabase stack directory;
- the Phase 5 release verifier and Phase 5 public key;
- the Phase 3 encrypted backup script and root-only backup configuration.

The backup config should include the Termly runtime config and any TLS proxy config in the Phase 3 extra-config paths file. Ensure encrypted backup storage is on a separate mounted volume or independent off-site target.

## 4. Transfer and inspect a release

Transfer the ZIP to the school server using a trusted channel. Extract it with the supplied safe extractor (not a browser-side script or a shell `unzip` command):

```bash
sudo python3 /opt/termly/app/tools/releases/extract-release.py \
  /secure-transfer/termly-1.2.0.termly-release.zip \
  /var/tmp/termly-release-1.2.0
```

The extractor rejects absolute paths, `..`, Windows-style traversal, symbolic links, unsupported ZIP entry types and archives with more than 2 GiB of expanded data.

Verify the release and run the updater's dry-run:

```bash
node /opt/termly/app/tools/releases/verify-release.mjs \
  --release-dir /var/tmp/termly-release-1.2.0 \
  --public-key /etc/termly/release-public-key.pem

sudo TERMLY_UPDATE_ENV=/etc/termly/update.env \
  /usr/local/sbin/termly-apply-school-hosted-update \
  --release-dir /var/tmp/termly-release-1.2.0 --dry-run
```

A dry-run verifies the signed manifest, all artifact digests, release channel/version and migration count. It does not run a backup, change the database or restart the web service.

## 5. Apply the update

After school approval and a successful dry-run:

```bash
sudo TERMLY_UPDATE_ENV=/etc/termly/update.env \
  /usr/local/sbin/termly-apply-school-hosted-update \
  --release-dir /var/tmp/termly-release-1.2.0
```

The updater:

1. requires root and takes an exclusive update lock;
2. verifies the signed release with the configured vendor public key;
3. refuses preview channel releases, same/older versions and changed checksums for previously applied migrations;
4. builds the new versioned web image without replacing the running app;
5. creates a Phase 3 encrypted pre-update cold backup; if backup config is absent or the backup fails, it stops before SQL/web changes;
6. creates the `public.termly_release_migrations` ledger and applies only the migrations listed in the signed manifest, one transaction at a time, inserting the migration/checksum record in the same transaction;
7. retags the current web image for rollback, points the Compose image tag at the new build, writes `runtime/termly-update-status.json` and recreates only the `termly-web` service;
8. waits for the container health check before declaring success.

The Compose volume addition serves the status JSON at `/termly-update-status.json`. The school Settings panel displays installed version, last successful update and the Phase 4 perpetual licence support date. It does not contain a download/install button.

## 6. Failure and rollback behavior

- **Signature/digest/path/version failure:** no backup, SQL or web change occurs.
- **Build failure:** current app and database remain unchanged; the newly built image tag may not be created.
- **Backup failure:** no SQL or web deployment takes place.
- **Migration failure:** the failing migration and its ledger insert are rolled back together by PostgreSQL. The existing app remains deployed. Earlier migrations from the same release, if already committed, remain recorded; retrying the release skips those matching checksums and continues.
- **New web app fails its health check:** the updater re-tags the previous Docker image to the Phase 2 Compose image name, restores the previous status JSON and recreates the web service. The previous image is also retained under a timestamped rollback tag.

**Database changes are not automatically rolled back when the app image is restored.** Only use migrations reviewed as backward-compatible with the current app. If an incompatible database migration has already committed, stop and use the Phase 3 restore procedure only after deciding the data-loss window and restore point with the school. Do not run a database restore automatically as part of an app rollback.

Retain the encrypted backup and previous image until the school has completed acceptance checks. Do not delete a rollback image or backup simply because the container became healthy.

## 7. Migration ledger and repeat behavior

The updater records each applied SQL migration by filename, SHA-256 digest, app version and timestamp in `public.termly_release_migrations`. If the same filename and digest are listed in another release, the migration is skipped. If the filename exists with a different digest, the updater refuses to run. Never edit a migration after release; add a new forward migration instead.

Only explicitly listed new migration files are applied. Phase 5 does not replay the repository's historical migration directory or the large consolidated SQL snapshot. For existing installations, the team must know which migrations each school has already applied before including migrations in a release.

## 8. Perpetual licence and update support

A school with a valid Phase 4 perpetual licence keeps using its installed version even after the support-through date. Future signed update bundles are distributed by Termly according to the school's support arrangement. The Phase 5 updater does not lock the installed app or school data when update support expires.

If an organisation wants automatic update entitlement lookup, download portal or licence renewal reporting, that should be a separately authenticated service. It must not be required for the already-purchased school-hosted version to start or continue working.

## 9. Validation checklist

- [ ] Separate Phase 5 release keypair created on the vendor machine.
- [ ] Vendor private key is encrypted and absent from Git and school server.
- [ ] Stable release bundle builds and signature verifies with the public key.
- [ ] A single-artifact tamper causes signature/digest verification failure.
- [ ] ZIP traversal and symlink archives are rejected.
- [ ] School host has the correct release public key and root-only update configuration.
- [ ] Phase 3 backup works and a restore was tested before first update.
- [ ] Dry-run reports the exact expected version and migration list.
- [ ] Same migration filename/checksum skips on repeat.
- [ ] Changed checksum for an existing migration name is rejected.
- [ ] Migration failure leaves old app deployed and rolls back the failing transaction.
- [ ] Health-check failure restores the previous web image and status file.
- [ ] New version passes school acceptance tests for admin, parent and staff portals.
- [ ] School Settings displays installed version and perpetual support-through date.
- [ ] Expired support does not disable the installed lifetime-licensed version.

## 10. Operations and limitations

- This updater is intended for the Phase 2 Nginx web container only; it does not update the Supabase stack, PostgreSQL image, Electron packages or mobile apps.
- Supabase version upgrades are a distinct high-risk operation; follow the pinned upstream upgrade procedure and the Phase 3 backup/restore guide.
- The Phase 3 cold backup briefly stops Supabase services. Schedule updates during an agreed school maintenance window.
- There is no online automatic updater or release CDN in this phase. Transfer signed packages securely and retain the signed original for audit.
- The web rollback is automatic; database rollback is not.
