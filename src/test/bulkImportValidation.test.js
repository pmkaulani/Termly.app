import { describe, it, expect } from 'vitest';
import {
  autoDetectColumnMappings,
  detectHeaderRow,
  normalizeImportDate,
  validateImportRows,
  validateTeacherImportRows,
  FIELD_DEFINITIONS,
  TEACHER_FIELD_DEFINITIONS
} from '../utils/spreadsheetParser';
import { calculateInitialStudentFee } from '../data/studentStore';

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

    it('normalizes punctuation and spacing consistently in headers', () => {
      const mappings = autoDetectColumnMappings(['Adm. Number', 'Learner Name', 'Grade / Class']);
      expect(mappings.admNo).toBe(0);
      expect(mappings.name).toBe(1);
      expect(mappings.class).toBe(2);
    });

    it('does not reuse parent email or phone columns as the parent name', () => {
      const mappings = autoDetectColumnMappings(['Parent Name', 'Parent Phone', 'Parent Email']);
      expect(mappings.parent).toBe(0);
      expect(mappings.parentPhone).toBe(1);
      expect(mappings.parentEmail).toBe(2);
    });
  });

  describe('detectHeaderRow', () => {
    it('finds a header row below school title rows', () => {
      const rows = [
        ['SUNRISE ACADEMY - STUDENT REGISTER'],
        ['Admissions for Academic Year 2026'],
        ['Admission No', 'Student Name', 'Grade / Class', 'Gender'],
        ['0012', 'Jane Doe', 'Grade 4', 'Female']
      ];
      expect(detectHeaderRow(rows, 10)).toBe(2);
    });

    it('defaults to row 0 if the first row is already the header', () => {
      const rows = [
        ['Admission Number', 'Student Name', 'Class'],
        ['001', 'Alice', 'Grade 1']
      ];
      expect(detectHeaderRow(rows, 10)).toBe(0);
    });
  });

  describe('normalizeImportDate', () => {
    it('normalizes Kenyan date strings, ISO dates, and Excel serial dates to ISO YYYY-MM-DD', () => {
      expect(normalizeImportDate('31/12/2010')).toBe('2010-12-31');
      expect(normalizeImportDate('2010-12-31')).toBe('2010-12-31');
      expect(normalizeImportDate(45292)).toBe('2024-01-01');
    });

    it('rejects impossible dates such as 31/02/2010', () => {
      // 31st of February does not exist in the calendar
      const result = normalizeImportDate('31/02/2010');
      expect(result).not.toBe('2010-02-31');
    });

    it('supports switching to MM/DD/YYYY convention when specified', () => {
      expect(normalizeImportDate('04/11/2012', 'MM/DD/YYYY')).toBe('2012-04-11');
      expect(normalizeImportDate('11/04/2012', 'DD/MM/YYYY')).toBe('2012-04-11');
    });
  });

  describe('validateImportRows & No Dangerous Defaults', () => {
    const activeClasses = ['Grade 1', 'Grade 2', 'Grade 3', 'Form 1'];
    const streamsPerClass = { 'Grade 1': ['North', 'South'] };
    const existingStudents = [
      { id: 'ex1', adm_no: 'ADM-001', name: 'Existing Alice', class: 'Grade 1' }
    ];

    it('preserves admission numbers as text with leading zeroes', () => {
      const rawRows = [
        ['Admission No', 'Student Name', 'Class'],
        ['00124', 'John Text', 'Grade 1']
      ];
      const mappings = { admNo: 0, name: 1, class: 2 };
      const result = validateImportRows(rawRows, 0, mappings, { activeClasses });
      expect(result.rows[0].admNo).toBe('00124');
    });

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
      expect(row.class).toBe('');
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
      expect(result.rows[0]._isDbDuplicate).toBe(true);
      expect(result.rows[2]._errors.admNo).toContain('Duplicate admission number');
    });

    it('rejects unconfigured classes not in activeClasses list', () => {
      const rawRows = [
        ['Adm No', 'Student Name', 'Class'],
        ['ADM-300', 'David Miller', 'Grade 99']
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

  describe('Teacher Importer Validation & Isolation', () => {
    const existingTeachers = [
      { id: 't1', staff_code: 'T-001', name: 'Existing Teacher', phone: '0711000000' }
    ];

    it('maps teacher column headers accurately', () => {
      const headers = ['Staff Code', 'Full Name', 'Phone Number', 'Email Address', 'TSC Number', 'Subjects Taught'];
      const mappings = autoDetectColumnMappings(headers, TEACHER_FIELD_DEFINITIONS);

      expect(mappings.staffCode).toBe(0);
      expect(mappings.name).toBe(1);
      expect(mappings.phone).toBe(2);
      expect(mappings.email).toBe(3);
      expect(mappings.tscNumber).toBe(4);
      expect(mappings.subjects).toBe(5);
    });

    it('validates required teacher fields and parses subjects cleanly', () => {
      const rawRows = [
        ['Staff Code', 'Full Name', 'Phone Number', 'Subjects'],
        ['T-002', 'Mary Mwangi', '0722334455', 'Maths, Physics, Chem; Biology'],
        ['T-003', '', '0733445566', 'English'] // Missing name
      ];
      const mappings = { staffCode: 0, name: 1, phone: 2, subjects: 3 };

      const result = validateTeacherImportRows(rawRows, 0, mappings, { existingTeachers });

      expect(result.rows[0]._isValid).toBe(true);
      expect(result.rows[0]._parsedSubjects).toEqual(['Maths', 'Physics', 'Chem', 'Biology']);
      expect(result.rows[1]._isValid).toBe(false);
      expect(result.rows[1]._errors.name).toContain('Full name is required');
    });

    it('detects duplicate staff code in file and database', () => {
      const rawRows = [
        ['Staff Code', 'Full Name', 'Phone'],
        ['T-001', 'Conflict Code', '0799887766'], // Matches existing T-001
        ['T-005', 'Valid Teacher', '0712345678'],
        ['T-005', 'File Duplicate Code', '0788776655'] // Duplicate in file
      ];
      const mappings = { staffCode: 0, name: 1, phone: 2 };

      const result = validateTeacherImportRows(rawRows, 0, mappings, { existingTeachers });
      expect(result.rows[0]._isDbDuplicate).toBe(true);
      expect(result.rows[2]._errors.staffCode).toContain('Duplicate staff code in file');
    });
  });

  describe('Initial Fee Calculation & Term-Aware Settings', () => {
    it('uses configured grade fees and residence type instead of static default', () => {
      const mockProfile = {
        gradeFees: {
          'Grade 1': {
            day: 15000,
            boarding: 32000,
            'Term 1': { day: 18000, boarding: 35000 }
          }
        }
      };

      const dayFee = calculateInitialStudentFee('Grade 1', 'day', mockProfile, 'Term 1');
      expect(dayFee).toBe(18000);

      const boardingFee = calculateInitialStudentFee('Grade 1', 'boarding', mockProfile, 'Term 1');
      expect(boardingFee).toBe(35000);

      const unconfiguredFee = calculateInitialStudentFee('Grade 9', 'day', mockProfile, 'Term 1');
      expect(unconfiguredFee).toBeGreaterThan(0);
    });
  });
});
