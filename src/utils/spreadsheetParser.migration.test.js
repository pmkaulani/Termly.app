import { describe, expect, it } from 'vitest';
import {
  autoDetectColumnMappings,
  validateImportRows
} from './spreadsheetParser';

describe('student migration status mapping', () => {
  const headers = ['Admission Number', 'Student Name', 'Class', 'Enrollment Status'];

  it('preserves recognised historical enrollment statuses', () => {
    const rows = [headers, ['ADM-001', 'Jane Learner', 'Grade 5', 'Transferred']];
    const mappings = autoDetectColumnMappings(headers);
    const result = validateImportRows(rows, 0, mappings);

    expect(result.rows[0].status).toBe('Transferred');
    expect(result.rows[0]._isValid).toBe(true);
  });

  it('normalises common legacy status labels', () => {
    const rows = [headers, ['ADM-002', 'John Learner', 'Grade 6', 'Alumni']];
    const result = validateImportRows(rows, 0, autoDetectColumnMappings(headers));

    expect(result.rows[0].status).toBe('Graduated');
    expect(result.rows[0]._isValid).toBe(true);
  });

  it('rejects unknown statuses rather than silently marking a former learner active', () => {
    const rows = [headers, ['ADM-003', 'Alex Learner', 'Grade 4', 'Archived 2019']];
    const result = validateImportRows(rows, 0, autoDetectColumnMappings(headers));

    expect(result.rows[0]._isValid).toBe(false);
    expect(result.rows[0]._errors.status).toMatch(/Unrecognised enrollment status/);
  });

  it("leaves a blank status for the importer's explicit default", () => {
    const rows = [headers, ['ADM-004', 'Sam Learner', 'Grade 3', '']];
    const result = validateImportRows(rows, 0, autoDetectColumnMappings(headers));

    expect(result.rows[0].status).toBe('');
    expect(result.rows[0]._isValid).toBe(true);
  });
});
