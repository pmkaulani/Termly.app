# Termly Manual Migration Center — Phase 1

## Purpose

The Migration Center supports administrator-led onboarding when a school has an old, disconnected, partially integrated or vendor-specific system. It does not attempt to automatically connect to every legacy product. The operator obtains an authorised export or report, then uses Termly's reviewed import workflows.

## Available in this phase

- Student spreadsheet imports reuse the existing student importer.
- Teacher spreadsheet imports reuse the existing teacher importer.
- Student migration mode preserves recognised enrollment statuses and skips automatic creation of current-term fee invoices.
- Teacher import creates directory profiles only; it does not create credentials or login accounts.
- Every completed importer run writes a school-scoped, append-only summary to `school_migration_batches`.
- The audit table stores counts and source labels only, not imported rows or original file contents. Notes must not contain learner names, admission numbers or other sensitive personal details.

## Not yet enabled

Finance/payment history, exam results, attendance history, library catalogues and library loans need dedicated importers with their own period, relationship, accounting and reconciliation rules. They are deliberately shown as assisted-migration datasets, not enabled import buttons. Do not load those records through the student or teacher importers.

## Operator workflow

1. Obtain the school's written authorisation and identify the old application's owner and vendor.
2. Agree the datasets and date range to migrate. Keep a read-only copy of the source export.
3. Record the source software name in the Migration Center.
4. Import students and teachers through their existing preview/mapping workflows.
5. Review failed and skipped rows, and resolve uncertain duplicates before another run.
6. Compare source and destination counts; sample-check admission IDs, staff codes and status values.
7. Have the school approve the migrated records before cutover.
8. Retain the original export under the school's retention and access rules; do not upload raw records into the migration audit table.

## Database deployment

Apply `supabase/migrations/20261109235900_create_school_migration_batches.sql` before using migration history. The policy allows only authenticated school Owners/Admins to read and insert records for their own school. No update or delete policy is provided: history is append-only.

## Important limitations

- The first phase does not perform a database-to-database migration or maintain live sync with the old product.
- Student and teacher importers support Excel/CSV/TSV files up to their existing limits.
- Historical finance, results, attendance and library data must not be represented as current-period data without explicit mapping and reconciliation.
- If the import succeeds but writing the audit summary fails, the data is not rolled back. The UI explicitly reports this distinction; reconcile the successful import and repair the audit entry separately.
