# Termly full remediation package

This package is based on `pmkaulani/Termly.app` `master` as inspected on **8 November 2026**, after the branding/photo/import changes were merged. It is a patch applier plus additive SQL and Edge Functions. It does not push to GitHub or change the live Supabase project.

## 1. Apply it to your local checkout

1. Download and extract the ZIP into the **root of your Termly repository**. It should create a folder named `termly-remediation-kit/`.
2. From the repository root, inspect your existing work and create a commit/backup first:

   ```bash
   git status --short
   git branch --show-current
   git diff > before-termly-remediation.diff
   ```

3. Run the patch applier:

   ```bash
   node termly-remediation-kit/apply-termly-remediation.mjs
   ```

   The applier checks that expected source blocks are present. If your local code has drifted from the inspected `master` snapshot, it stops at the first mismatch instead of guessing. Do not remove those checks just to force it through; compare that file with the current repository and reconcile the change.

4. Review the result:

   ```bash
   git status --short
   git diff --check
   git diff --stat
   git diff
   ```

5. Install dependencies if needed, then run the project tests and build. Use the scripts already defined in your `package.json`, for example:

   ```bash
   npm install
   npm test -- --run
   npm run build
   ```

   This package's tests include static invariants. The cross-school RLS test is skipped unless its test credentials and two-school fixture IDs are configured.

## 2. Deploy Supabase Edge Functions

The applier adds or replaces these functions:

```bash
supabase functions deploy communications-send
supabase functions deploy delete-school-user
supabase functions deploy mpesa-callback
supabase functions deploy mpesa-stk-push
```

The M-Pesa callback is called by Safaricom, not by an authenticated browser session. The package adds the following function settings to `supabase/config.toml` while preserving other settings:

```toml
[functions.mpesa-callback]
verify_jwt = false

[functions.mpesa-stk-push]
verify_jwt = false
```

Both functions still perform their own authentication: `mpesa-stk-push` validates either the Supabase user or the signed portal session token, and `mpesa-callback` validates `MPESA_CALLBACK_TOKEN`. Do not disable JWT verification for the communications or staff-deletion functions.

## 3. Configure server-side secrets

Do not put provider API keys in `VITE_*` variables or browser-readable school profile JSON. Configure the platform provider credentials as Supabase Edge Function secrets before applying the database migration; the migration then replaces the legacy JSON credentials with a non-secret `managed_by` marker.

### Africa's Talking

```bash
supabase secrets set AFRICASTALKING_API_KEY="..."
supabase secrets set AFRICASTALKING_USERNAME="..."
supabase secrets set AFRICASTALKING_SENDER_ID="..."
```

For sandbox testing, use the Africa's Talking sandbox username and corresponding sandbox API credentials. The connection test validates the provider account endpoint; it does not send a paid SMS.

### WhatsApp Business Cloud API

```bash
supabase secrets set WHATSAPP_ACCESS_TOKEN="..."
supabase secrets set WHATSAPP_PHONE_NUMBER_ID="..."
supabase secrets set WHATSAPP_GRAPH_VERSION="v23.0"
```

The function uses the official WhatsApp Cloud API. Provider acceptance is not delivery confirmation. Messages sent outside the permitted customer-service window may require approved message templates; the provider rejection is surfaced as a failure rather than reported as sent.

### M-Pesa Daraja

```bash
supabase secrets set MPESA_CONSUMER_KEY="..."
supabase secrets set MPESA_CONSUMER_SECRET="..."
supabase secrets set MPESA_PASSKEY="..."
supabase secrets set MPESA_SHORTCODE="..."
supabase secrets set MPESA_CALLBACK_URL="https://<project-ref>.supabase.co/functions/v1/mpesa-callback?token=<long-random-token>"
supabase secrets set MPESA_CALLBACK_TOKEN="<same-long-random-token>"
supabase secrets set MPESA_ENVIRONMENT="sandbox"
```

**Important multi-school limitation:** this implementation reads one Daraja credential set and one shortcode from Supabase project-level Edge Function secrets. That means all schools on this Supabase project would currently use the same paybill/shortcode. Before applying the migration, configure the correct project-level secrets and securely move any existing credentials out of school profiles. If schools on this Termly deployment require separate paybills/shortcodes or different SMS provider keys, do **not** apply this global-credential portion or onboard them yet; a server-side per-school credential vault (authenticated provisioning, encryption-at-rest, access isolation and rotation) is required first. The SQL migration has a preflight check and will abort if it detects more than one distinct legacy provider configuration. Do not put per-school secrets back into browser-readable `school_profiles`.

Use production credentials and `MPESA_ENVIRONMENT=production` only after Safaricom has approved the shortcode/callback configuration and a sandbox run has passed. This patch disables the prior fake-success mock branch. An STK Push request is not automatically retried because Safaricom may have accepted the first request even when the client times out. Check transaction status before initiating another push.

### Application origin

Set the deployed web origin for Edge Function CORS. The secrets must be configured before running the SQL migration because the migration scrubs the legacy browser-readable `mpesa_config` and `sms_config` JSON values:

```bash
supabase secrets set APP_ORIGIN="https://your-termly-domain.example"
```

## 4. Apply the database migration safely

Before deploying SQL, take a database backup and inspect Supabase's migration history. The historical file `20261107_portal_security_and_canonical_marks.sql` is corrected for clean migration runs. Editing an already-applied migration does **not** rerun it.

If the November 7 migration is not recorded as applied, run the normal migration flow so the corrected source is executed. If it is already recorded, leave its history intact and use the new additive migration:

```text
supabase/migrations/20261108224600_termly_reliability_remediation.sql
```

Then apply via your normal controlled Supabase migration process (for example `supabase db push` after reviewing the generated plan).

The migration intentionally stops if duplicate M-Pesa receipts already exist for the same school. Reconcile those records manually before rerunning; do not delete payment rows just to make the migration pass. Daraja request password timestamps are generated using the Africa/Nairobi clock (not UTC). Daraja's numeric `TransactionDate` is interpreted explicitly as Africa/Nairobi when converted to a PostgreSQL timestamp, avoiding dependence on the database server timezone. Callbacks whose received amount no longer fits the active balance are left in orphaned/manual-review state rather than silently capping the fee ledger. It adds session-aware attendance, aligns the canonical LMS tables, creates atomic fee/callback RPCs, and adds communication provider tracking fields.

## 5. Behaviour changes to expect

- SMS and WhatsApp requests go through Edge Functions. The migration adds a same-school RLS insert policy for authenticated staff to create queued SMS rows; provider credentials and actual sending remain server-side. `sending` rows are claimed and are never automatically returned to the queue, because the provider may have accepted a request before a network/logging failure. A network timeout is treated as an unknown outcome for manual provider-log reconciliation, not as a safe-to-retry failure. `accepted` means the provider accepted a request, not that the handset received it. Queue insertion is not labelled as delivery.
- WhatsApp bulk messaging requires a configured WhatsApp Business Cloud API account. A `wa.me` link is not treated as a sent broadcast.
- Manual fee payments use a database transaction that locks the fee row and rejects duplicate references and overpayments.
- M-Pesa STK requests retain the academic period selected when the prompt is created, so a term switch before Safaricom's callback cannot post into the next term. Callbacks update the receipt, fee ledger and callback state in one database transaction. A receipt is treated as a duplicate only when student, period and amount all match; conflicting or orphaned callbacks remain visible for reconciliation rather than being marked completed.
- Attendance sessions are persisted independently (`Morning`, `Afternoon`, `Evening`), and attendance dates use the device's local calendar date.
- LMS teacher/admin screens read and write the cloud `el_assignments` / `el_submissions` schema; the student portal uses its secured assignment RPC.
- Unknown offline queue items stay failed with an error instead of being marked synced. Failed items can be retried from the sync indicator. Offline student edits compare the last-known `updated_at` value; conflicts are retained for manual resolution instead of silently overwriting newer server data.
- Class promotion and bulk exam deletion now fail safely with an explicit message until transactional, auditable implementations exist. They no longer return a fake “complete” result.
- School data export covers more operational datasets and fails loudly if an enabled query fails. It is still **not a complete restorable backup**: identity-provider users, private storage objects, secrets and some auxiliary data are excluded, and cloud restore stays disabled. Do not rely on this export as your only disaster-recovery backup.
- Settings reports fields skipped by an older database schema. Dashboard data-source failures are surfaced rather than silently displayed as genuine zero counts.
- `/settings` and `/security` have UI role guards. Database RLS and server-side authorization remain the security boundary.

## 6. Tests that still require your Supabase project

Set the following environment variables to run the actual cross-tenant RLS integration test against a local/test Supabase instance with two seeded schools:

```bash
TEST_SUPABASE_URL="http://127.0.0.1:54321"
TEST_SUPABASE_ANON_KEY="..."
TEST_RLS_SCHOOL_A_EMAIL="..."
TEST_RLS_SCHOOL_A_PASSWORD="..."
TEST_RLS_SCHOOL_A_ID="..."
TEST_RLS_SCHOOL_B_ID="..."
```

Run the app against test data and verify: payment ledger updates under concurrent requests; duplicate Daraja callback replay; parent cannot pay another student's account; school-A user cannot read school-B data; LMS assignment creation/listing/submission from two devices; separate attendance sessions; offline retry after reconnect; and export-query failures. Do not test live payment prompts or bulk SMS against real parents without a controlled test number and explicit school approval.

## Scope and limitations

The applier was written against the inspected GitHub source blocks. This environment did not have a local checkout, Supabase credentials, PostgreSQL CLI, or Deno runtime, so it could not apply the changes to your actual working tree, compile Edge Functions, execute SQL, or run the real app test suite. Review the generated diff and run the validations above before deployment. The transactional class-promotion and full restore workflows are explicitly gated rather than approximated unsafely.
