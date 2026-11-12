# Termly Phase 4 — Perpetual school licensing

## Purpose

Phase 4 introduces a signed, school-bound perpetual licence for a Termly installation. A school that buys a perpetual licence can continue using the purchased Termly version without a recurring subscription expiry. Cloud subscription schools keep their existing subscription behavior.

The support-through date is a separate commercial/support field. It is displayed for reference and is **not** used as an application, database, parent-portal, staff-portal or records expiry date. This phase does not yet build an automatic paid-update entitlement gate.

## What changes

- Adds licence type/status/ID/issue date/support date/reference and the signed document to `school_profiles`.
- Adds a `school_license_events` audit table.
- Adds a service-role-only database RPC used only after the Edge Function has verified the Ed25519 signature, plus a database trigger that prevents school users from editing licence claims directly through PostgREST.
- Adds `activate-perpetual-license`, which authenticates the school administrator/owner, validates the school binding and signature, then applies the signed entitlement.
- Adds an administrator panel under School Settings for uploading the JSON licence file, plus a restricted activation-only version of the expired-workspace screen so an expired school admin can activate a licence without regaining access to school data first.
- Makes the shared subscription access helper ignore subscription expiry for an active perpetual licence while still respecting suspension and workspace status. Parent and staff portal login already use this helper.
- Displays perpetual status separately from subscription expiry in Super Admin.
- Excludes perpetual schools from subscription-expiry reminder emails.
- Adds offline CLI tools to generate a signing keypair and issue school-bound licence files.

## Licence behavior

| Model | Access behavior | Support date |
|---|---|---|
| Subscription | Existing status and expiry rules remain in place. | Existing commercial subscription behavior. |
| Perpetual | No subscription expiry. Active workspace and active licence status are still required. | Informational only; does not switch off the purchased version. |
| Suspended perpetual | Access is blocked until a platform administrator restores the suspended workspace. | Does not change suspension behavior. |

A perpetual licence includes a school UUID and is not transferable by changing the JSON file. Reissue a correctly signed document when the school identity or licence terms genuinely change. Keep a written record of any transfer/reissue.

The `features` entitlement may be `['*']` to grant every feature registered in that Termly version, or a list of exact `features_registry.feature_key` values. A limited licence disables feature rows that are not included. Only features in the signed entitlement are enabled and cleared of expiry at activation. The restore path only clears expiry for features in the stored licence entitlement; it does not turn manually disabled features back on.

## 1. Generate the signing keypair (Termly/vendor machine only)

Use a secure machine that is not a school server. Keep the encrypted private key and its passphrase under separate access control. Back up both securely; losing the private key prevents issuing additional licences for this keypair. Never commit or upload the private key to GitHub, a school host, or the client bundle.

PowerShell example from the Termly repository root:

```powershell
$env:TERMLY_LICENSE_KEY_PASSPHRASE = 'use-a-long-unique-passphrase-from-your-password-manager'
node tools/licensing/generate-keypair.mjs
```

This creates:

- `termly-license-keys/private-key.pem` — encrypted private signing key; vendor-only.
- `termly-license-keys/public-key.base64.txt` — public SPKI key; configure this on Termly's Edge Function server.

Clear the environment variable after use:

```powershell
Remove-Item Env:TERMLY_LICENSE_KEY_PASSPHRASE
```

The scripts refuse to overwrite existing key material unless `--force` is provided. Do not use `--force` for routine operation.

## 2. Issue a school licence (Termly/vendor machine only)

Copy the school's exact `school_profiles.school_id` / `schools.id` UUID from the verified customer record. Do not issue a licence using a school name alone.

```powershell
$env:TERMLY_LICENSE_KEY_PASSPHRASE = 'the-same-long-unique-passphrase'
node tools/licensing/issue-perpetual-license.mjs `
  --private-key termly-license-keys/private-key.pem `
  --school-id 11111111-2222-4333-8444-555555555555 `
  --school-name "Example Academy" `
  --reference "INV-2026-001" `
  --support-until 2027-11-10 `
  --features "*" `
  --out example-academy-termly-license.json
Remove-Item Env:TERMLY_LICENSE_KEY_PASSPHRASE
```

`--support-until` is optional. `--features "*"` grants all features registered in the current Termly version. For a limited entitlement, pass comma-separated feature keys, for example `--features "parent_portal,teacher_portal,fees"`.

Deliver only the generated `*-termly-license.json` file to the customer. Never send the private key or passphrase.

## 3. Apply the database migration

Apply this migration to the target Termly database before deploying the Edge Function:

`supabase/migrations/20261110000100_perpetual_school_licensing.sql`

Cloud deployment using the Supabase CLI:

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

For school-hosted Supabase, apply the SQL migration to that school's database using the approved database migration process. Take a verified Phase 3 backup first. Confirm the migration succeeds and PostgREST has reloaded before moving on.

The migration defaults existing records to `license_type='subscription'`; it does not convert existing subscriptions to perpetual. It also aligns the existing repository's hard-coded platform-admin email with the `platform_admins` table used by the database RLS helper, so the existing Super Admin suspend/restore actions can update perpetual licence status.

## 4. Configure and deploy the licensing Edge Function

Configure the public key as an Edge Function/server environment variable. It is a public verification key, not a secret, but it must still be kept out of the browser build configuration:

```bash
supabase secrets set --project-ref YOUR_PROJECT_REF TERMLY_LICENSE_PUBLIC_KEY="$(cat termly-license-keys/public-key.base64.txt)"
supabase functions deploy activate-perpetual-license --project-ref YOUR_PROJECT_REF
```

Do not disable JWT verification for the function. It requires a signed-in user and performs its own school-admin/owner authorization check. Existing Supabase `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` server environment variables must be present.

For school-hosted Supabase:

1. Copy `supabase/functions/activate-perpetual-license/` into the self-hosted stack's `docker/volumes/functions/activate-perpetual-license/` directory.
2. Add `TERMLY_LICENSE_PUBLIC_KEY=<contents of public-key.base64.txt>` to the server-only functions environment file (for example `.env.functions`).
3. Add the exact web origins for that school's Termly site to `TERMLY_ALLOWED_ORIGINS`, comma-separated. Do not use `*`.
4. Ensure the `functions` service loads that environment file, as set out in the Phase 2 school-hosted deployment guide.
5. Recreate the Edge Functions service using the pinned Supabase stack's procedure.

Never put `SUPABASE_SERVICE_ROLE_KEY` or the private licence key in `VITE_*`, runtime browser configuration, Electron renderer code or a school-delivered licence file.

## 5. Activate at the school

1. Sign in to Termly as the school's Admin (or registered school owner). An expired workspace still allows the administrator to authenticate, but the app remains in a restricted activation-only screen.
2. If the workspace is active, open **Settings**. If it is expired, use the **Termly Product Licence** panel on the restricted screen.
3. Find **Termly Product Licence**.
4. Confirm that the displayed school installation ID matches the ID used to issue the licence.
5. Upload the `.json` file supplied by Termly and confirm activation.
6. Confirm that the screen shows **LIFETIME LICENCE** and the expected support-through date.
7. Sign out and test the parent and staff portal logins for that school. Also test ordinary administrator login and a feature that is included in the licence.

The activation endpoint rejects a mismatched school ID, invalid signature, unsupported payload, non-admin user or a licence that is not for Termly/perpetual use. The restricted expired-workspace screen exposes only the activation panel and sign-out action; it does not restore normal school modules or records unless the signed licence activates successfully.

## 6. Suspend and restore

On the central cloud deployment, platform administrators may use the existing Deactivate/Activate school workflow. For perpetual schools, deactivation changes the licence status to `suspended` without converting it to a monthly/annual subscription. A school admin cannot bypass that suspension by uploading the same signed file again. Restoring a suspended perpetual school through the platform-admin workflow restores its active workspace and clears expiry only for the enabled features in its signed licence entitlement. It does not add subscription months.

**School-hosted isolation boundary:** each independently hosted school has its own Supabase database. The central Termly Super Admin dashboard cannot remotely suspend or restore that isolated database merely by changing a record in the cloud database. In a school-hosted installation, suspension/restore is effective only for an administrator authenticated against that installation’s own database. Do not promise remote revocation for an isolated school-hosted deployment. A remote control plane would require a separately designed, authenticated, auditable communication channel; it must not become a compulsory online check for an already-purchased perpetual installation.

Use suspension only for a documented operational/security reason and record the reason in the applicable installation’s audit log. This is not an automated payment collection system.

## 7. Validation checklist

- [ ] Migration applied successfully on a disposable/test database.
- [ ] Edge Function deployed with the matching public key.
- [ ] Valid licence for the exact school UUID activates.
- [ ] A licence signed by a different key is rejected.
- [ ] A valid licence for another school UUID is rejected.
- [ ] Non-admin/non-owner cannot activate.
- [ ] Perpetual licence with an old `subscription_expiry` still permits school, parent and staff access when active.
- [ ] Suspended perpetual school is blocked.
- [ ] Restore resumes the perpetual school without adding months.
- [ ] Limited feature entitlement disables unlicensed feature rows.
- [ ] Perpetual school is omitted from subscription-expiry reminder results.
- [ ] Existing subscription schools still obey their current expiry rules.
- [ ] A Phase 3 backup exists and its restore has been tested before production rollout.

Automated local tests in this package cover canonical signing/verification behavior and the shared school-access decision. They do not replace an integration test against the actual school database and deployed Edge Function.

## Security and product boundaries

- The private Ed25519 key stays under Termly/vendor custody. The server stores only its matching public key.
- The signature proves the licence document was issued by the holder of the signing key and has not been edited. The school UUID binds it to one installation record. A database trigger prevents school-level users from changing the protected licence columns directly; platform administrators can only suspend or restore the operational status of an existing licence through the protected workflow.
- A self-hosted customer who controls the server and database as root can technically modify their own software or database. This mechanism is a signed commercial entitlement and audit control, not tamper-proof DRM.
- The support-through date is informational in this phase. This patch does not enforce access to future updates, support tickets or paid add-ons. Those policies need a separate update/support entitlement service and clear customer terms.
- A licence cannot protect against a compromised signing machine. Keep the private key encrypted, offline where practicable, access-controlled and backed up securely.
- Do not use the production private key in local tests. Tests generate disposable in-memory Ed25519 keys.

## Rollback

Do not casually drop the new columns or delete `school_license_events`. To roll back application code, first stop issuing/activating new perpetual licences and restore the previous app build. Existing rows can remain harmlessly in the database; older code ignores the extra columns. A database rollback that removes active licence records should be performed only after exporting the signed documents and confirming the school's commercial entitlement with Termly.
