import { describe, it, expect } from 'vitest';
import {
  autoDetectColumnMappings,
  validateImportRows,
  FIELD_DEFINITIONS
} from '../utils/spreadsheetParser';

describe('Student Import & Validation Engine', () => {
  describe('autoDetectColumnMappings', () => {
    it('accurately maps common variations of column headers', () => {
      const headers = [
        'Student Name',
        'Adm No.',
        'Grade / Class',
        'Stream',
        'Gender',
        'Date of Birth',
        'Parent / Guardian',
        'Phone Number'
      ];

      const mappings = autoDetectColumnMappings(headers);

      expect(mappings.name).toBe(0);
      expect(mappings.admNo).toBe(1);
      expect(mappings.class).toBe(2);
      expect(mappings.stream).toBe(3);
      expect(mappings.gender).toBe(4);
      expect(mappings.dob).toBe(5);
      expect(mappings.parent).toBe(6);
      expect(mappings.parentPhone).toBe(7);
    });
  });

  describe('validateImportRows & No Dangerous Defaults', () => {
    const activeClasses = ['Grade 1', 'Grade 2', 'Grade 3', 'Form 1'];
    const streamsPerClass = { 'Grade 1': ['North', 'South'] };
    const existingStudents = [
      { id: 'ex1', adm_no: 'ADM-001', name: 'Existing Alice', class: 'Grade 1' }
    ];

    it('rejects missing class and missing gender without silently inventing defaults', () => {
      const rawRows = [
        ['Adm No', 'Student Name', 'Class', 'Gender'],
        ['ADM-100', 'Bob Smith', '', ''] // Missing class and gender
      ];
      const mappings = { admNo: 0, name: 1, class: 2, gender: 3 };

      const result = validateImportRows(rawRows, 0, mappings, {
        activeClasses,
        streamsPerClass,
        existingStudents
      });

      const row = result.rows[0];
      expect(row._isValid).toBe(false);
      expect(row._errors.class).toContain('Class is required');
      // Crucial: class must NOT be defaulted to Grade 1
      expect(row.class).toBe('');
      // Crucial: gender must NOT be defaulted to Male
      expect(row.gender).toBe('');
    });

    it('detects duplicate admission numbers in uploaded file and database', () => {
      const rawRows = [
        ['Adm No', 'Student Name', 'Class', 'Gender'],
        ['ADM-001', 'Bob Smith', 'Grade 1', 'Male'], // Matches existing DB student
        ['ADM-002', 'Charlie Brown', 'Grade 1', 'Male'],
        ['ADM-002', 'Charlie Duplicate', 'Grade 1', 'Male'] // Duplicate in file
      ];
      const mappings = { admNo: 0, name: 1, class: 2, gender: 3 };

      const result = validateImportRows(rawRows, 0, mappings, {
        activeClasses,
        streamsPerClass,
        existingStudents
      });

      expect(result.summary.dbDuplicateCount).toBe(1);
      expect(result.summary.fileDuplicateCount).toBe(1);

      // Row 0 is DB duplicate
      expect(result.rows[0]._isDbDuplicate).toBe(true);

      // Row 2 is internal file duplicate
      expect(result.rows[2]._errors.admNo).toContain('Duplicate admission number');
    });

    it('rejects unconfigured classes not in activeClasses list', () => {
      const rawRows = [
        ['Adm No', 'Student Name', 'Class'],
        ['ADM-300', 'David Miller', 'Grade 99'] // Invalid class
      ];
      const mappings = { admNo: 0, name: 1, class: 2 };

      const result = validateImportRows(rawRows, 0, mappings, {
        activeClasses,
        streamsPerClass,
        existingStudents
      });

      expect(result.rows[0]._isValid).toBe(false);
      expect(result.rows[0]._errors.class).toContain('not in school\'s active classes');
    });
  });
});
