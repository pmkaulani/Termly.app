import test from 'node:test';
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
  assert.match(sql, /SELECT \* INTO v_existing[\s\S]*?FROM public\.school_profiles[\s\S]*?FOR UPDATE;/);
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
  assert.match(read('src/pages/SuperAdmin/index.jsx'), /if \(!ok\) return;\s*const reason = await prompt/);
  assert.match(read('src/pages/Settings.jsx'), /\['admin', 'owner'\]\.includes/);
  assert.match(read('src/pages/MigrationCenter.jsx'), /<th>Source system<\/th><th>File type<\/th>/);
  assert.match(read('src/pages/SuperAdmin/tabs/SettingsTab.jsx'), /handleUpdateSetting,\s*loadData,/);
});

test('CI targets master and requires operational tests on Node 22', () => {
  const workflow = read('.github/workflows/ci.yml');
  assert.match(workflow, /branches: \[master, main, develop\]/);
  assert.match(workflow, /node-version: \[22\]/);
  assert.ok(workflow.includes('bash tests/test-phase3-backup.sh'));
  assert.ok(workflow.includes('bash scripts/run-phase5-tests.sh'));
  assert.ok(workflow.includes('bash scripts/run-phase6-tests.sh'));
  assert.ok(!workflow.includes('continue-on-error: true'));
});
