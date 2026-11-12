#!/usr/bin/env node
/**
 * Consolidated Termly Phase 1-6 remediation patcher.
 * Run from the Termly repository root:
 *   node patches/apply-termly-remediation.mjs --check
 *   node patches/apply-termly-remediation.mjs --apply
 *
 * Source anchors are exact and guarded. Unexpected branch drift stops the
 * operation before any file is written.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const APPLY = process.argv.includes('--apply');
const planned = new Map();
const edits = [];

function read(file) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) throw new Error(`Required file not found: ${file}`);
  return planned.has(file) ? planned.get(file) : fs.readFileSync(full, 'utf8');
}
function plan(file, content, label) {
  planned.set(file, content);
  edits.push({ file, label });
}
function adaptNewlines(text, targetSource) {
  if (typeof text !== 'string') return text;
  if (targetSource.includes('\r\n')) {
    return text.replace(/\r?\n/g, '\r\n');
  }
  return text.replace(/\r\n/g, '\n');
}

function replaceOnce(file, oldText, newText, label) {
  const source = read(file);
  const normalizedOld = adaptNewlines(oldText, source);
  const normalizedNew = adaptNewlines(newText, source);
  if (source.includes(normalizedNew)) return;
  const first = source.indexOf(normalizedOld);
  if (first < 0 || source.indexOf(normalizedOld, first + normalizedOld.length) >= 0) {
    throw new Error(`Could not uniquely locate "${label}" in ${file}. No files have been written.`);
  }
  plan(file, source.slice(0, first) + normalizedNew + source.slice(first + normalizedOld.length), label);
}
function replaceRegexOnce(file, regex, newText, alreadyAppliedNeedle, label) {
  const source = read(file);
  const normalizedNew = adaptNewlines(newText, source);
  const normalizedNeedle = adaptNewlines(alreadyAppliedNeedle, source);
  if (normalizedNeedle && source.includes(normalizedNeedle)) return;
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const matches = [...source.matchAll(new RegExp(regex.source, flags))];
  if (matches.length !== 1) {
    throw new Error(`Expected one match for "${label}" in ${file}; found ${matches.length}. No files have been written.`);
  }
  const match = matches[0];
  plan(file, source.slice(0, match.index) + normalizedNew + source.slice(match.index + match[0].length), label);
}
function addFile(file, content, label) {
  const full = path.join(ROOT, file);
  if (fs.existsSync(full)) {
    if (fs.readFileSync(full, 'utf8') === content) return;
    throw new Error(`Refusing to overwrite existing ${file}. Reconcile it manually.`);
  }
  plan(file, content, label);
}
function replaceAll(file, oldText, newText, expectedCount, label) {
  const source = read(file);
  const normalizedOld = adaptNewlines(oldText, source);
  const normalizedNew = adaptNewlines(newText, source);
  const count = source.split(normalizedOld).length - 1;
  if (count === 0 && source.includes(normalizedNew)) return;
  if (count !== expectedCount) throw new Error(`Expected ${expectedCount} occurrences for "${label}" in ${file}; found ${count}. No files have been written.`);
  plan(file, source.split(normalizedOld).join(normalizedNew), label);
}

// Phase 4 follow-up: use a new forward-only migration. Never rewrite the
// already-released Phase 4 migration because installations may have applied it.
addFile(
  'supabase/migrations/20261111000200_fix_perpetual_profile_upsert_trigger.sql',
  `-- Forward-only fix for sparse school_profiles upserts after perpetual licensing.
-- Existing deployments may already have applied 20261110000100; do not edit it.

CREATE OR REPLACE FUNCTION public.termly_protect_license_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_service_role BOOLEAN := COALESCE(current_setting('request.jwt.claim.role', true), '') = 'service_role';
  v_platform_admin BOOLEAN := FALSE;
  v_existing public.school_profiles%ROWTYPE;
BEGIN
  IF v_service_role THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- PostgREST upsert runs BEFORE INSERT before resolving ON CONFLICT. Omitted
    -- columns receive defaults (subscription/null), even when the existing row
    -- is perpetual. Preserve the current signed claims on every conflict
    -- candidate; user-supplied claim changes on this INSERT path are ignored.
    SELECT * INTO v_existing
    FROM public.school_profiles
    WHERE school_id = NEW.school_id
    FOR UPDATE;

    IF FOUND THEN
      NEW.license_type := v_existing.license_type;
      NEW.license_status := v_existing.license_status;
      NEW.license_id := v_existing.license_id;
      NEW.license_issued_at := v_existing.license_issued_at;
      NEW.license_support_until := v_existing.license_support_until;
      NEW.license_reference := v_existing.license_reference;
      NEW.license_document := v_existing.license_document;
      NEW.license_feature_keys := v_existing.license_feature_keys;
      RETURN NEW;
    END IF;

    -- A genuinely new profile may only begin with neutral subscription defaults.
    IF NEW.license_type IS DISTINCT FROM 'subscription'
       OR NEW.license_status IS DISTINCT FROM 'active'
       OR NEW.license_id IS NOT NULL
       OR NEW.license_issued_at IS NOT NULL
       OR NEW.license_support_until IS NOT NULL
       OR NEW.license_reference IS NOT NULL
       OR NEW.license_document IS NOT NULL
       OR COALESCE(array_length(NEW.license_feature_keys, 1), 0) <> 0 THEN
      RAISE EXCEPTION 'Licence claims can only be created by the verified Termly licensing service.';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.license_type, NEW.license_status, NEW.license_id, NEW.license_issued_at,
    NEW.license_support_until, NEW.license_reference, NEW.license_document,
    NEW.license_feature_keys
  ) IS NOT DISTINCT FROM ROW(
    OLD.license_type, OLD.license_status, OLD.license_id, OLD.license_issued_at,
    OLD.license_support_until, OLD.license_reference, OLD.license_document,
    OLD.license_feature_keys
  ) THEN
    RETURN NEW;
  END IF;

  v_platform_admin := public.is_platform_admin();
  -- The platform-admin workflow may change only the operational status of an
  -- already-issued perpetual licence. Signed licence claims remain immutable.
  IF v_platform_admin
     AND OLD.license_type = 'perpetual'
     AND NEW.license_type = OLD.license_type
     AND NEW.license_status IN ('active', 'suspended')
     AND ROW(
       NEW.license_id, NEW.license_issued_at, NEW.license_support_until,
       NEW.license_reference, NEW.license_document, NEW.license_feature_keys
     ) IS NOT DISTINCT FROM ROW(
       OLD.license_id, OLD.license_issued_at, OLD.license_support_until,
       OLD.license_reference, OLD.license_document, OLD.license_feature_keys
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'School licence claims are protected. Use the Termly licensing workflow.';
END;
$$;

NOTIFY pgrst, 'reload schema';
`,
  'add forward migration to fix perpetual licence sparse upserts'
);

// Settings panels must be available to both Admin and Owner roles.
replaceOnce(
  'src/pages/Settings.jsx',
  "          setIsAdmin(userData?.role === 'Admin');",
  "          setIsAdmin(['admin', 'owner'].includes(String(userData?.role || '').toLowerCase()));",
  'allow school owners to see Settings administration panels'
);

// A cancelled confirmation must stop a destructive Super Admin action.
replaceOnce(
  'src/pages/SuperAdmin/index.jsx',
  "    const ok = await confirm({ title: 'Deactivate School', message: `Are you sure you want to deactivate ${name}? This will lock all their features immediately.`, confirmText: 'Deactivate', variant: 'danger' });\n    const reason = await prompt({ title: 'Deactivation Reason', message: 'Why is this school being deactivated? (Optional)', inputPlaceholder: 'e.g. Non-payment, violation of terms...', confirmText: 'Confirm Deactivation' });",
  "    const ok = await confirm({ title: 'Deactivate School', message: `Are you sure you want to deactivate ${name}? This will lock all their features immediately.`, confirmText: 'Deactivate', variant: 'danger' });\n    if (!ok) return;\n    const reason = await prompt({ title: 'Deactivation Reason', message: 'Why is this school being deactivated? (Optional)', inputPlaceholder: 'e.g. Non-payment, violation of terms...', confirmText: 'Confirm Deactivation' });",
  'honour deactivation confirmation cancellation'
);

// Importers commit in batches. Warn operators explicitly that a later batch
// failure does not roll back earlier successful batches.
replaceOnce(
  'src/pages/MigrationCenter.jsx',
  '          These details are attached to the migration audit entry. Do not put learner names, admission numbers or sensitive personal details in the notes. Termly does not upload or retain the original spreadsheet in the migration history.',
  '          These details are attached to the migration audit entry. Do not put learner names, admission numbers or sensitive personal details in the notes. Termly does not upload or retain the original spreadsheet in the migration history. Imports are processed in batches; if a later batch fails, earlier successful rows remain saved. Review the result and reconcile failed rows before retrying the file.',
  'warn that partial imports are not transactionally rolled back'
);

// Migration history renders seven cells; all seven need headings.
replaceOnce(
  'src/pages/MigrationCenter.jsx',
  '<thead><tr><th>When</th><th>Dataset</th><th>Source</th><th>Result</th><th>Records</th><th>Status</th></tr></thead>',
  '<thead><tr><th>When</th><th>Dataset</th><th>Source system</th><th>File type</th><th>Import result</th><th>Rows</th><th>Status</th></tr></thead>',
  'align migration history headings to all row cells'
);

// The parent passes loadData; the child must destructure it.
replaceOnce(
  'src/pages/SuperAdmin/tabs/SettingsTab.jsx',
  '  handleUpdateSetting,\n  setMessage,',
  '  handleUpdateSetting,\n  loadData,\n  setMessage,',
  'restore Super Admin Settings refresh callback'
);

// Directory mount makes monitor atomic_json os.replace visible to Nginx.
replaceOnce(
  'deployment/school-hosted/compose.yml',
  '      - ./runtime/termly-update-status.json:/usr/share/nginx/html/termly-update-status.json:ro\n      - ./runtime/termly-health-status.json:/usr/share/nginx/html/termly-health-status.json:ro',
  '      # Directory mount keeps atomically replaced status files visible to Nginx.\n      - ./runtime:/termly-runtime:ro',
  'mount runtime directory for atomic status updates'
);
replaceOnce(
  'deployment/school-hosted/nginx.conf',
  '    # This status document contains only allowlisted operational status, no secrets or school data.\n    location = /termly-health-status.json {\n        default_type application/json;\n        add_header Cache-Control "no-store" always;\n        try_files $uri =404;\n    }',
  '    # Public status documents contain allowlisted operational metadata only.\n    # They are served from a directory bind mount so atomic host-side rename\n    # operations replace the file Nginx reads, rather than leaving a stale inode.\n    location = /termly-health-status.json {\n        default_type application/json;\n        add_header Cache-Control "no-store" always;\n        alias /termly-runtime/termly-health-status.json;\n    }\n\n    location = /termly-update-status.json {\n        default_type application/json;\n        add_header Cache-Control "no-store" always;\n        alias /termly-runtime/termly-update-status.json;\n    }',
  'serve health and release status via stable directory mount aliases'
);

// A single lock coordinates backup, restore and update. Nested backup calls
// inherit a marker while the parent process holds the actual flock descriptor.
replaceOnce(
  'scripts/backup-school-hosted.sh',
  "if command -v flock >/dev/null 2>&1; then\n  exec 9>/run/lock/termly-school-hosted-backup.lock\n  flock -n 9 || fail 'Another Termly backup is already running.'\nfi",
  'if [[ "${TERMLY_MAINTENANCE_LOCK_HELD:-0}" != "1" ]]; then\n  command -v flock >/dev/null 2>&1 || fail \'flock is required for safe Termly maintenance coordination.\'\n  MAINTENANCE_LOCK_FILE="${TERMLY_MAINTENANCE_LOCK_FILE:-/run/lock/termly-school-hosted-maintenance.lock}"\n  install -d -m 0755 "$(dirname "$MAINTENANCE_LOCK_FILE")"\n  exec 9>"$MAINTENANCE_LOCK_FILE"\n  flock -n 9 || fail \'Another Termly backup, restore or update is running.\'\nfi',
  'use shared maintenance lock for backups'
);
replaceOnce(
  'scripts/apply-school-hosted-update.sh',
  "exec 9>/run/lock/termly-school-hosted-update.lock\nflock -n 9 || fail 'Another Termly update is already running.'",
  'MAINTENANCE_LOCK_FILE="${TERMLY_MAINTENANCE_LOCK_FILE:-/run/lock/termly-school-hosted-maintenance.lock}"\ninstall -d -m 0755 "$(dirname "$MAINTENANCE_LOCK_FILE")"\nexec 9>"$MAINTENANCE_LOCK_FILE"\nflock -n 9 || fail \'Another Termly backup, restore or update is running.\'',
  'use shared maintenance lock for updates'
);
replaceOnce(
  'scripts/apply-school-hosted-update.sh',
  'TERMLY_BACKUP_ENV="$BACKUP_ENV" "$BACKUP_SCRIPT" --label "pre-update-$VERSION"',
  'TERMLY_BACKUP_ENV="$BACKUP_ENV" TERMLY_MAINTENANCE_LOCK_HELD=1 "$BACKUP_SCRIPT" --label "pre-update-$VERSION"',
  'allow updater to run its backup under the held shared lock'
);
replaceAll(
  'scripts/apply-school-hosted-update.sh',
  'dc up -d --no-deps --force-recreate termly-web',
  'dc up -d --no-build --no-deps --force-recreate termly-web',
  2,
  'prevent Compose from rebuilding the signed release from the working tree during deploy or rollback'
);

// Restore only takes the maintenance lock for --apply. --inspect is read-only.
replaceOnce(
  'scripts/restore-school-hosted.sh',
  '[[ -n "$BACKUP_FILE" ]] || { usage >&2; exit 2; }\n[[ -f "$BACKUP_FILE" ]] || { echo "Backup file not found: $BACKUP_FILE" >&2; exit 1; }',
  '[[ -n "$BACKUP_FILE" ]] || { usage >&2; exit 2; }\n[[ -f "$BACKUP_FILE" ]] || { echo "Backup file not found: $BACKUP_FILE" >&2; exit 1; }\n\nif [[ "$MODE" == "apply" ]]; then\n  command -v flock >/dev/null 2>&1 || { echo \'flock is required for safe Termly maintenance coordination.\' >&2; exit 1; }\n  MAINTENANCE_LOCK_FILE="${TERMLY_MAINTENANCE_LOCK_FILE:-/run/lock/termly-school-hosted-maintenance.lock}"\n  install -d -m 0755 "$(dirname "$MAINTENANCE_LOCK_FILE")"\n  exec 9>"$MAINTENANCE_LOCK_FILE"\n  flock -n 9 || { echo \'Another Termly backup, restore or update is running.\' >&2; exit 1; }\nfi',
  'coordinate restore with backup and update'
);
replaceOnce(
  'scripts/restore-school-hosted.sh',
  '"$SCRIPT_DIR/backup-school-hosted.sh" --label pre-restore',
  'TERMLY_MAINTENANCE_LOCK_HELD=1 "$SCRIPT_DIR/backup-school-hosted.sh" --label pre-restore',
  'reuse the held restore lock for its pre-restore backup'
);
replaceOnce(
  'scripts/restore-school-hosted.sh',
  'mkdir -p "$WORK/db-config"\ntar -xzf "$WORK/bundle/db-config.tar.gz" -C "$WORK/db-config"\n\ncd "$SUPABASE_DIR"',
  'mkdir -p "$WORK/db-config"\ntar -xzf "$WORK/bundle/db-config.tar.gz" -C "$WORK/db-config"\n\n# Do not silently discard the optional external configuration archive. Stage\n# it beside the restore for explicit review rather than overwriting arbitrary\n# absolute host paths from an archive.\nmkdir -p "$ROLLBACK_DIR/recovered-extra-config"\nchmod 700 "$ROLLBACK_DIR/recovered-extra-config"\ntar -xzf "$WORK/bundle/extra-config.tar.gz" -C "$ROLLBACK_DIR/recovered-extra-config"\n\ncd "$SUPABASE_DIR"',
  'stage external configuration for review during restore'
);
replaceOnce(
  'scripts/restore-school-hosted.sh',
  "docker compose ps\nRESTORE_STARTED=0\ntrap - ERR\n\necho \"[Termly restore] Database is healthy. Previous installation retained at: $ROLLBACK_DIR/previous-stack\"\necho '[Termly restore] Run the application acceptance checklist before deleting that rollback copy.'",
  "docker compose ps\nRESTORE_STARTED=0\ntrap - ERR\n\n# The encrypted pre-restore archive is the retained rollback copy. Remove the\n# temporary plaintext previous stack and db-config staging after PostgreSQL\n# is confirmed healthy. Keep only the protected extra-config review directory.\nif [[ -d \"$ROLLBACK_DIR/previous-stack\" ]]; then rm -rf \"$ROLLBACK_DIR/previous-stack\"; fi\nif [[ -d \"$ROLLBACK_DIR/db-config\" ]]; then rm -rf \"$ROLLBACK_DIR/db-config\"; fi\n\necho \"[Termly restore] Database is healthy. Encrypted pre-restore backup retained in $BACKUP_DIR.\"\necho \"[Termly restore] External configuration staged for review at: $ROLLBACK_DIR/recovered-extra-config\"\necho '[Termly restore] Review and copy back only the configuration files required by this host, then run the application acceptance checklist.'",
  'remove temporary plaintext rollback copy after successful restore'
);

// Safe import helpers are intentionally dependency-free so Node tests can exercise them.
addFile('src/utils/importSafety.mjs', `/** Shared rules for safe legacy imports. */\nexport function hasImportValue(value) {\n  if (value === null || value === undefined) return false;\n  if (Array.isArray(value)) return value.some(hasImportValue);\n  return String(value).trim().length > 0;\n}\n\nexport function normalizeTeacherImportStatus(value) {\n  if (!hasImportValue(value)) return '';\n  const key = String(value).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\\s+/g, ' ');\n  const statuses = {\n    active: 'Active', current: 'Active', employed: 'Active', working: 'Active',\n    left: 'Left', departed: 'Left', resigned: 'Left', exited: 'Left',\n    inactive: 'Inactive', disabled: 'Inactive', 'not active': 'Inactive',\n    suspended: 'Suspended', retired: 'Retired',\n    'on leave': 'On Leave', leave: 'On Leave'\n  };\n  return statuses[key] || null;\n}\n`, 'add import safety helpers');

replaceOnce(
  'src/data/studentStore.js',
  "import { jsPDF } from 'jspdf';",
  "import { jsPDF } from 'jspdf';\nimport { hasImportValue } from '../utils/importSafety.mjs';",
  'use shared non-blank semantics for student import updates'
);
replaceOnce(
  'src/data/studentStore.js',
  'export async function getNEMISComplianceReport() {',
  `/**\n * Authoritative cloud read for import duplicate checks. Unlike getStudents(),\n * this bypasses the offline-first cache and fetches every page before writes.\n */\nexport async function getStudentsFresh() {\n  if (!_currentSchoolId) return [];\n  const pageSize = 500;\n  const allRows = [];\n  for (let offset = 0; ; offset += pageSize) {\n    const { data, error } = await supabase\n      .from('students')\n      .select('*')\n      .eq('school_id', _currentSchoolId)\n      .order('name')\n      .range(offset, offset + pageSize - 1);\n    if (error) throw error;\n    const page = data || [];\n    allRows.push(...page);\n    if (page.length < pageSize) break;\n  }\n  await db.students.bulkPut(allRows.map((student) => ({ ...student, school_id: _currentSchoolId })));\n  window.dispatchEvent(new Event('studentsSynced'));\n  return allRows.map((s) => ({\n    ...s,\n    admNo: s.adm_no,\n    residenceType: s.residence_type || 'day',\n    house: s.house || null,\n    parentPhone: s.parent_phone,\n    joinDate: s.join_date,\n    birthCertNo: s.birth_cert_no,\n    fatherName: s.father_name,\n    fatherPhone: s.father_phone,\n    motherName: s.mother_name,\n    motherPhone: s.mother_phone,\n    nemisVerified: s.nemis_verified,\n    status: s.status || 'Active'\n  }));\n}\n\nexport async function getNEMISComplianceReport() {`,
  'add authoritative paginated student read'
);
replaceOnce(
  'src/data/studentStore.js',
  '  const existingStudents = await getStudents();\n  const existingMap = new Map();',
  '  const existingStudents = await getStudentsFresh();\n  const existingMap = new Map();',
  'use authoritative database rows for student import duplicate checks'
);
replaceOnce(
  'src/data/studentStore.js',
  '    if (existingMap.has(lowerAdm)) {\n      const existing = existingMap.get(lowerAdm);\n      if (duplicateAction === \'update\') {\n        toUpdate.push({ id: existing.id, ...record });\n      } else {\n        skippedCount++;\n      }\n    } else {',
  `    if (existingMap.has(lowerAdm)) {\n      const existing = existingMap.get(lowerAdm);\n      if (duplicateAction === 'update') {\n        // Blank spreadsheet cells mean \"not supplied\", not \"erase the\n        // existing school record\". Update only values actually provided.\n        const update = { id: existing.id, _rowNumber: rowNum };\n        const add = (key, value, transform = (item) => item) => {\n          if (hasImportValue(value)) update[key] = transform(value);\n        };\n        add('name', s.name, (value) => String(value).trim());\n        const incomingClass = s.class || s.class_grade;\n        add('class', incomingClass, (value) => String(value).trim());\n        if (hasImportValue(incomingClass)) update.subjects = getSubjectsForGrade(String(incomingClass).trim(), profile);\n        add('stream', s.stream);\n        add('gender', s.gender);\n        add('dob', s.dob);\n        add('parent', s.parent || s.parentName);\n        add('parent_phone', s.parentPhone || s.parent_phone);\n        add('parent_email', s.parentEmail || s.parent_email);\n        add('residence_type', s.residence || s.residenceType);\n        add('photo_path', s.photo_path);\n        add('status', s.status);\n        if (Array.isArray(s.subjects) && s.subjects.length > 0) update.subjects = s.subjects;\n        toUpdate.push(update);\n      } else {\n        skippedCount++;\n      }\n    } else {`,
  'preserve student values when incoming spreadsheet fields are blank'
);
replaceOnce(
  'src/components/StudentImporter.jsx',
  "import { bulkImportStudents, getStudents } from '../data/studentStore';",
  "import { bulkImportStudents, getStudentsFresh } from '../data/studentStore';",
  'use authoritative student read in import preview'
);
replaceOnce(
  'src/components/StudentImporter.jsx',
  '    getStudents().then(students => {',
  '    getStudentsFresh().then(students => {',
  'remove stale cache from student duplicate preview'
);

replaceOnce(
  'src/data/staffStore.js',
  "import { sanitizeString, sanitizeName } from '../utils/sanitize';",
  "import { sanitizeString, sanitizeName } from '../utils/sanitize';\nimport { hasImportValue } from '../utils/importSafety.mjs';",
  'use shared non-blank semantics for teacher import updates'
);
replaceOnce(
  'src/data/staffStore.js',
  'export async function getAllSchoolStaff(schoolId) {',
  `/** Authoritative, paginated cloud read for teacher imports (bypasses Dexie SWR). */\nexport async function getTeachersFreshBySchool(schoolId = _currentSchoolId) {\n  if (!schoolId) return [];\n  const pageSize = 500;\n  const allRows = [];\n  for (let offset = 0; ; offset += pageSize) {\n    const { data, error } = await supabase\n      .from('teachers')\n      .select('id, name, email, phone, subjects, school_id, on_leave, staff_code, status, tsc_number, photo_path, photo_updated_at')\n      .eq('school_id', schoolId)\n      .order('staff_code', { ascending: true, nullsFirst: false })\n      .order('name', { ascending: true })\n      .range(offset, offset + pageSize - 1);\n    if (error) throw error;\n    const page = data || [];\n    allRows.push(...page);\n    if (page.length < pageSize) break;\n  }\n  await db.teachers.bulkPut(allRows.map((teacher) => ({ ...teacher, school_id: schoolId })));\n  return allRows;\n}\n\nexport async function getAllSchoolStaff(schoolId) {`,
  'add authoritative paginated teacher read'
);
replaceOnce(
  'src/data/staffStore.js',
  '  const existingTeachers = await getTeachersBySchool(schoolId);',
  '  const existingTeachers = await getTeachersFreshBySchool(schoolId);',
  'use authoritative database rows for teacher duplicate checks'
);
replaceOnce(
  'src/data/staffStore.js',
  "    const status = String(t.status || 'Active').toLowerCase() === 'left' ? 'Left' : 'Active';",
  "    const rawStatus = String(t.status || '').trim();\n    const allowedStatuses = new Set(['Active', 'Left', 'Inactive', 'Suspended', 'Retired', 'On Leave']);\n    if (rawStatus && !allowedStatuses.has(rawStatus)) {\n      errors.push({ row: rowNum, name: name || 'Unknown', reason: `Unsupported teacher status: ${rawStatus}` });\n      return;\n    }\n    const status = rawStatus || 'Active';",
  'preserve explicit non-active teacher status'
);
replaceOnce(
  'src/data/staffStore.js',
  '    if (existing) {\n      if (duplicateAction === \'update\') {\n        toUpdate.push({ id: existing.id, ...record });\n      } else {\n        skippedCount++;\n      }\n    } else {',
  `    if (existing) {\n      if (duplicateAction === 'update') {\n        // Empty optional cells are omitted from UPDATE so they cannot erase\n        // contact details, staff codes, subjects or status already in Termly.\n        const update = { id: existing.id, _rowNumber: rowNum };\n        if (hasImportValue(t.name)) update.name = name;\n        if (hasImportValue(t.phone)) update.phone = phone;\n        if (hasImportValue(t.email)) update.email = email;\n        if (hasImportValue(t.subjects) || hasImportValue(t._parsedSubjects)) update.subjects = subjects;\n        if (hasImportValue(t.status)) update.status = status;\n        if (hasImportValue(t.tscNumber || t.tsc_number)) update.tsc_number = tscNumber;\n        if (hasImportValue(t.staffCode || t.staff_code)) update.staff_code = staffCode;\n        if (hasImportValue(t.photo_path)) update.photo_path = t.photo_path;\n        toUpdate.push(update);\n      } else {\n        skippedCount++;\n      }\n    } else {`,
  'preserve existing teacher fields when source columns are blank'
);
replaceOnce(
  'src/data/staffStore.js',
  '  // Check capacity before inserting new active teachers\n  const newActiveCount = toInsert.filter(r => r.status === \'Active\').length;\n  if (currentStaffCount !== null && (currentStaffCount + newActiveCount > configuredStaffLimit)) {\n    throw new Error(`This import would exceed your school\'s faculty capacity limit (${configuredStaffLimit}). Currently active: ${currentStaffCount}; new active: ${newActiveCount}.`);\n  }',
  `  // Include new staff and existing staff being reactivated by an update.\n  const newActiveCount = toInsert.filter((r) => r.status === 'Active').length;\n  const activeExistingIds = new Set(existingTeachers\n    .filter((teacher) => (teacher.status || 'Active') === 'Active')\n    .map((teacher) => teacher.id));\n  const reactivatedCount = toUpdate.filter((update) => update.status === 'Active' && !activeExistingIds.has(update.id)).length;\n  const deactivatedCount = toUpdate.filter((update) => update.status && update.status !== 'Active' && activeExistingIds.has(update.id)).length;\n  const projectedActiveCount = (currentStaffCount || 0) + newActiveCount + reactivatedCount - deactivatedCount;\n  if (currentStaffCount !== null && projectedActiveCount > configuredStaffLimit) {\n    throw new Error(\`This import would exceed your school's faculty capacity limit (\${configuredStaffLimit}). Currently active: \${currentStaffCount}; new/reactivated active: \${newActiveCount + reactivatedCount}; becoming inactive: \${deactivatedCount}.\`);\n  }`,
  'include reactivated teachers in staff capacity checks'
);

// Teacher spreadsheet statuses must not silently become Active when unknown.
replaceOnce(
  'src/utils/spreadsheetParser.js',
  'export function validateTeacherImportRows(rawRows, headerRowIdx, mappings, {',
  "import { normalizeTeacherImportStatus } from './importSafety.mjs';\n\nexport function validateTeacherImportRows(rawRows, headerRowIdx, mappings, {",
  'use explicit teacher status normalizer in spreadsheet parser'
);
replaceOnce(
  'src/utils/spreadsheetParser.js',
  "    // 5. Status normalization\n    if (!record.status || !['active', 'left'].includes(record.status.toLowerCase())) {\n      record.status = 'Active';\n    } else {\n      record.status = record.status.toLowerCase() === 'left' ? 'Left' : 'Active';\n    }",
  `    // 5. Preserve recognized employment states. Unknown values are errors;\n    // they must never silently reactivate a former or suspended employee.\n    if (record.status) {\n      const normalizedStatus = normalizeTeacherImportStatus(record.status);\n      if (!normalizedStatus) {\n        rowErrors.status = \`Unrecognised teacher status "\${record.status}". Map it to Active, Left, Inactive, Suspended, Retired or On Leave.\`;\n      } else {\n        record.status = normalizedStatus;\n      }\n    }`,
  'reject unknown teacher statuses instead of defaulting to Active'
);
replaceOnce(
  'src/components/TeacherImporter.jsx',
  "import { bulkImportTeachers, getTeachersBySchool } from '../data/staffStore';",
  "import { bulkImportTeachers, getTeachersFreshBySchool } from '../data/staffStore';",
  'use authoritative teacher read in import preview'
);
replaceOnce(
  'src/components/TeacherImporter.jsx',
  '      getTeachersBySchool(schoolId)',
  '      getTeachersFreshBySchool(schoolId)',
  'remove stale teacher cache from duplicate preview'
);

// CI targets the actual default branch, uses Node 22, and makes operational tests mandatory.
replaceOnce(
  '.github/workflows/ci.yml',
  'on:\n  push:\n    branches: [main, develop]\n  pull_request:\n    branches: [main]',
  'on:\n  push:\n    branches: [master, main, develop]\n  pull_request:\n    branches: [master, main, develop]',
  'run CI on default master branch'
);
replaceOnce(
  '.github/workflows/ci.yml',
  '        node-version: [20]',
  '        node-version: [22]',
  'use Node 22 in CI to match the updater'
);
replaceOnce(
  '.github/workflows/ci.yml',
  '      - name: Run lint\n        run: npm run lint\n        continue-on-error: true\n\n      - name: Run tests\n        run: npm test -- --run --reporter=verbose',
  '      - name: Run application tests\n        run: npm test -- --run --reporter=verbose\n\n      - name: Run Phase 3 backup/restore package tests\n        run: bash tests/test-phase3-backup.sh\n\n      - name: Run Phase 5 signed release/updater tests\n        run: sudo env "PATH=$PATH" bash scripts/run-phase5-tests.sh\n\n      - name: Run Phase 6 operations and remediation regression tests\n        run: sudo env "PATH=$PATH" bash scripts/run-phase6-tests.sh',
  'make application and operations tests blocking CI checks'
);

// Test harnesses use isolated lock files to avoid requiring /run/lock.
replaceOnce(
  'tests/test-phase3-backup.sh',
  'export PATH="$TMP/bin:$PATH"\nexport MOCK_DB_CONFIG="$TMP/mock-db-config"',
  'export PATH="$TMP/bin:$PATH"\nexport MOCK_DB_CONFIG="$TMP/mock-db-config"\nexport TERMLY_MAINTENANCE_LOCK_FILE="$TMP/maintenance.lock"',
  'isolate Phase 3 backup maintenance lock in tests'
);
replaceOnce(
  'tests/test-updater-dry-run.sh',
  'TERMLY_VERIFY_SCRIPT=$ROOT_DIR/tools/releases/verify-release.mjs\nEOF2',
  'TERMLY_VERIFY_SCRIPT=$ROOT_DIR/tools/releases/verify-release.mjs\nTERMLY_MAINTENANCE_LOCK_FILE=$WORK/maintenance.lock\nEOF2',
  'isolate Phase 5 updater maintenance lock in tests'
);
replaceOnce(
  'scripts/run-phase6-tests.sh',
  "python3 -m unittest discover -s tests -p 'test_phase6_*.py' -v",
  "python3 -m unittest discover -s tests -p 'test_phase6_*.py' -v\nnode --test tests/termly-remediation-regression.test.mjs",
  'run remediation regression tests as part of Phase 6'
);

// Documentation must not imply remote Super Admin control over isolated local databases.
replaceOnce(
  'docs/PHASE4_PERPETUAL_LICENSING.md',
  'Platform administrators may use the existing Deactivate/Activate school workflow. For perpetual schools, deactivation changes the licence status to `suspended` without converting it to a monthly/annual subscription. A school admin cannot bypass that suspension by uploading the same signed file again. Restoring a suspended perpetual school through the platform-admin workflow restores its active workspace and clears expiry only for the enabled features in its signed licence entitlement. It does not add subscription months.\n\nUse suspension only for a documented operational/security reason and record the reason in the existing school activity log. This is not an automated payment collection system.',
  'On the central cloud deployment, platform administrators may use the existing Deactivate/Activate school workflow. For perpetual schools, deactivation changes the licence status to `suspended` without converting it to a monthly/annual subscription. A school admin cannot bypass that suspension by uploading the same signed file again. Restoring a suspended perpetual school through the platform-admin workflow restores its active workspace and clears expiry only for the enabled features in its signed licence entitlement. It does not add subscription months.\n\n**School-hosted isolation boundary:** each independently hosted school has its own Supabase database. The central Termly Super Admin dashboard cannot remotely suspend or restore that isolated database merely by changing a record in the cloud database. In a school-hosted installation, suspension/restore is effective only for an administrator authenticated against that installation’s own database. Do not promise remote revocation for an isolated school-hosted deployment. A remote control plane would require a separately designed, authenticated, auditable communication channel; it must not become a compulsory online check for an already-purchased perpetual installation.\n\nUse suspension only for a documented operational/security reason and record the reason in the applicable installation’s audit log. This is not an automated payment collection system.',
  'document isolated school-hosted licence suspension boundary'
);

// Portable regression tests for the high-risk defects corrected above.
const regressionTests = `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasImportValue, normalizeTeacherImportStatus } from '../src/utils/importSafety.mjs';

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('blank values are treated as omitted during import updates', () => {
  assert.equal(hasImportValue('   '), false);
  assert.equal(hasImportValue(null), false);
  assert.equal(hasImportValue(undefined), false);
  assert.equal(hasImportValue([]), false);
  assert.equal(hasImportValue(['', '  ']), false);
  assert.equal(hasImportValue('0'), true);
  assert.equal(hasImportValue(0), true);
  assert.equal(hasImportValue(['English']), true);
});

test('teacher status aliases preserve non-active employment states', () => {
  assert.equal(normalizeTeacherImportStatus('current'), 'Active');
  assert.equal(normalizeTeacherImportStatus('resigned'), 'Left');
  assert.equal(normalizeTeacherImportStatus('inactive'), 'Inactive');
  assert.equal(normalizeTeacherImportStatus('suspended'), 'Suspended');
  assert.equal(normalizeTeacherImportStatus('retired'), 'Retired');
  assert.equal(normalizeTeacherImportStatus('on leave'), 'On Leave');
  assert.equal(normalizeTeacherImportStatus(''), '');
  assert.equal(normalizeTeacherImportStatus('unknown custom status'), null);
});

test('perpetual licence trigger preserves existing claims on conflict inserts', () => {
  const sql = read('supabase/migrations/20261111000200_fix_perpetual_profile_upsert_trigger.sql');
  assert.match(sql, /SELECT \\* INTO v_existing[\\s\\S]*?FROM public\\.school_profiles[\\s\\S]*?FOR UPDATE;/);
  for (const field of ['license_type', 'license_status', 'license_id', 'license_document', 'license_feature_keys']) {
    assert.ok(sql.includes('NEW.' + field + ' := v_existing.' + field + ';'), 'missing preserved field ' + field);
  }
});

test('runtime status directory bind mount exposes atomic status replacements', () => {
  const compose = read('deployment/school-hosted/compose.yml');
  const nginx = read('deployment/school-hosted/nginx.conf');
  assert.ok(compose.includes('./runtime:/termly-runtime:ro'));
  assert.ok(!compose.includes('./runtime/termly-health-status.json:/usr/share/nginx/html/termly-health-status.json'));
  assert.ok(nginx.includes('alias /termly-runtime/termly-health-status.json;'));
  assert.ok(nginx.includes('alias /termly-runtime/termly-update-status.json;'));
});

test('backup, restore and update share the same maintenance lock', () => {
  for (const file of ['scripts/backup-school-hosted.sh', 'scripts/restore-school-hosted.sh', 'scripts/apply-school-hosted-update.sh']) {
    assert.ok(read(file).includes('termly-school-hosted-maintenance.lock'), file + ' missing shared lock');
  }
  assert.ok(read('scripts/restore-school-hosted.sh').includes('TERMLY_MAINTENANCE_LOCK_HELD=1'));
  assert.ok(read('scripts/apply-school-hosted-update.sh').includes('TERMLY_MAINTENANCE_LOCK_HELD=1'));
});

test('restore stages external configuration and removes plaintext previous stack after success', () => {
  const script = read('scripts/restore-school-hosted.sh');
  assert.ok(script.includes('recovered-extra-config'));
  assert.ok(script.includes('rm -rf "$ROLLBACK_DIR/previous-stack"'));
});

test('administrator safety, history columns, Settings refresh and owner panels are corrected', () => {
  assert.match(read('src/pages/SuperAdmin/index.jsx'), /if \\(!ok\\) return;\\s*const reason = await prompt/);
  assert.match(read('src/pages/Settings.jsx'), /\\['admin', 'owner'\\]\\.includes/);
  assert.match(read('src/pages/MigrationCenter.jsx'), /<th>Source system<\\/th><th>File type<\\/th>/);
  assert.match(read('src/pages/SuperAdmin/tabs/SettingsTab.jsx'), /handleUpdateSetting,\\s*loadData,/);
});

test('CI targets master and requires operational tests on Node 22', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /branches: \\[master, main, develop\\]/);
  assert.match(workflow, /node-version: \\[22\\]/);
  assert.ok(workflow.includes('bash tests/test-phase3-backup.sh'));
  assert.ok(workflow.includes('bash scripts/run-phase5-tests.sh'));
  assert.ok(workflow.includes('bash scripts/run-phase6-tests.sh'));
  assert.ok(!workflow.includes('continue-on-error: true'));
});
`;
addFile('tests/termly-remediation-regression.test.mjs', regressionTests, 'add consolidated remediation regression tests');

if (APPLY) {
  for (const [file, content] of planned.entries()) {
    const full = path.join(ROOT, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  console.log(`Applied ${planned.size} file updates (${edits.length} guarded changes). Review the result with git diff.`);
} else {
  console.log(`Source check passed: ${edits.length} guarded changes across ${planned.size} files are ready.`);
  console.log(edits.map((entry) => `  ${entry.file} — ${entry.label}`).join('\n'));
  console.log('\nNo files were changed. Re-run with --apply to write the planned changes.');
}
