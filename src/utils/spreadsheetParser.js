import * as XLSX from 'xlsx';
import Papa from 'papaparse';

export const FIELD_DEFINITIONS = [
  { key: 'admNo', label: 'Admission Number', required: true, aliases: ['admission number', 'admission no', 'adm no', 'adm no.', 'adm number', 'adm', 'registration number', 'reg no', 'student id', 'adm_no'] },
  { key: 'name', label: 'Student Name', required: true, aliases: ['student name', 'name', 'full name', 'learner name', 'jina', 'student', 'names'] },
  { key: 'class', label: 'Class / Grade', required: true, aliases: ['class', 'grade', 'level', 'form', 'class/grade', 'standard'] },
  { key: 'stream', label: 'Stream / Section', required: false, aliases: ['stream', 'section', 'house', 'arm'] },
  { key: 'gender', label: 'Gender', required: false, aliases: ['gender', 'sex', 'm/f'] },
  { key: 'dob', label: 'Date of Birth', required: false, aliases: ['date of birth', 'dob', 'birth date', 'birthdate'] },
  { key: 'parent', label: 'Parent / Guardian Name', required: false, aliases: ['parent name', 'parent', 'guardian name', 'guardian', 'father', 'mother', 'parent / guardian'] },
  { key: 'parentPhone', label: 'Parent Phone Number', required: false, aliases: ['parent phone', 'phone', 'phone number', 'contact', 'mobile', 'parent contact', 'guardian phone', 'parent_phone'] },
  { key: 'parentEmail', label: 'Parent Email', required: false, aliases: ['parent email', 'email', 'email address', 'guardian email', 'parent_email'] },
  { key: 'residence', label: 'Residence / Boarding', required: false, aliases: ['residence', 'residence type', 'boarding', 'day/boarding', 'day or boarding', 'hostel'] },
  { key: 'upi', label: 'UPI / NEMIS No', required: false, aliases: ['upi', 'nemis', 'nemis no', 'upi no', 'upi/nemis'] },
  { key: 'birthCertNo', label: 'Birth Certificate No', required: false, aliases: ['birth cert no', 'birth certificate', 'birth certificate no', 'cert no'] },
  { key: 'status', label: 'Enrollment Status', required: false, aliases: ['status', 'student status', 'learner status', 'enrollment status', 'enrolment status'] },
  { key: 'photoFile', label: 'Photo Filename', required: false, aliases: ['photo', 'photo filename', 'image', 'picture', 'photo file'] }
];

export const TEACHER_FIELD_DEFINITIONS = [
  { key: 'staffCode', label: 'Staff Code / Index', required: false, aliases: ['staff code', 'staff id', 'teacher id', 'code', 'index', 'staff no', 'staff_code', 't-code'] },
  { key: 'name', label: 'Full Name', required: true, aliases: ['teacher name', 'full name', 'name', 'staff name', 'instructor', 'names', 'jina'] },
  { key: 'phone', label: 'Phone Number', required: true, aliases: ['phone', 'phone number', 'mobile', 'telephone', 'contact', 'cell', 'tel'] },
  { key: 'email', label: 'Email Address', required: false, aliases: ['email', 'email address', 'e-mail', 'mail'] },
  { key: 'tscNumber', label: 'TSC Number', required: false, aliases: ['tsc', 'tsc number', 'tsc no', 'tsc_number', 'registration no'] },
  { key: 'subjects', label: 'Subjects Taught', required: false, aliases: ['subjects', 'subject', 'specialization', 'teaching subjects', 'subject taught'] },
  { key: 'status', label: 'Status', required: false, aliases: ['status', 'employment status', 'active/left', 'state'] },
  { key: 'photoFile', label: 'Photo Filename', required: false, aliases: ['photo', 'photo filename', 'image', 'picture', 'photo file'] }
];

export const normalizeHeader = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

function formatDateParts(year, month, day) {
  if (!year || !month || !day) return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return ''; // Invalid calendar day (e.g. Feb 31)
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Normalizes input date from Excel serials, ISO dates, or formatted strings.
 * Defaults ambiguous slash dates to DD/MM/YYYY (Kenya convention).
 */
export function normalizeImportDate(value, formatConvention = 'DD/MM/YYYY') {
  if (value === null || value === undefined || value === '') return '';

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatDateParts(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  // Excel serial number (1 = 1900-01-01, max 73050 = ~2100)
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 73050) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
    return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }

  const input = String(value).trim();
  if (!input) return '';

  // ISO: YYYY-MM-DD or YYYY/MM/DD
  const iso = input.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    const formatted = formatDateParts(y, m, d);
    if (formatted) return formatted;
  }

  // Slash or dash formatted: e.g. 31/12/2010 or 12/31/2010
  const slashMatch = input.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/);
  if (slashMatch) {
    let day = Number(slashMatch[1]);
    let month = Number(slashMatch[2]);
    const year = Number(slashMatch[3]);

    if (formatConvention === 'MM/DD/YYYY') {
      month = Number(slashMatch[1]);
      day = Number(slashMatch[2]);
    } else {
      // If day > 12 and month <= 12, it's definitely DD/MM/YYYY regardless
      // If month > 12 and day <= 12, invert if possible
      if (month > 12 && day <= 12) {
        const temp = day;
        day = month;
        month = temp;
      }
    }

    const formatted = formatDateParts(year, month, day);
    if (formatted) return formatted;
  }

  // Numeric serial in string form
  if (/^\d{1,7}(?:\.\d+)?$/.test(input)) {
    const serial = Number(input);
    if (serial >= 1 && serial <= 73050) {
      return normalizeImportDate(serial, formatConvention);
    }
  }

  return input;
}

/**
 * Detects header row in the first scanLimit rows.
 * Allows spreadsheets with title rows, metadata, or blank rows at the top.
 */
export function detectHeaderRow(rows = [], scanLimit = 20, fieldDefs = FIELD_DEFINITIONS) {
  const requiredKeys = fieldDefs.filter(f => f.required).map(f => f.key);
  let bestIndex = 0;
  let bestScore = -1;

  rows.slice(0, scanLimit).forEach((row, index) => {
    if (!Array.isArray(row)) return;
    const mapped = autoDetectColumnMappings(row, fieldDefs);
    const requiredMatches = requiredKeys.filter(key => mapped[key] !== undefined).length;
    const totalMatches = Object.keys(mapped).length;
    const score = requiredMatches * 100 + totalMatches;

    if (requiredMatches >= Math.min(2, requiredKeys.length) && score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  });

  return bestIndex;
}

/**
 * Reads a spreadsheet file (.xlsx, .xls, .csv, .tsv)
 * Returns { sheetNames, getSheetData(sheetName) }
 */
export async function readSpreadsheetFile(file) {
  const extension = file.name.split('.').pop().toLowerCase();

  // If CSV or TSV, can use PapaParse or SheetJS
  if (extension === 'csv' || extension === 'tsv') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const content = e.target.result;
          const parsed = Papa.parse(content, {
            header: false,
            skipEmptyLines: 'greedy'
          });

          const rawRows = parsed.data || [];
          resolve({
            sheetNames: ['Sheet1'],
            getSheetData: () => rawRows
          });
        } catch (err) {
          reject(new Error(`Failed to parse CSV/TSV: ${err.message}`));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }

  // If Excel (.xlsx, .xls)
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const buffer = e.target.result;
        const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
        const sheetNames = workbook.SheetNames || [];

        if (sheetNames.length === 0) {
          throw new Error('Workbook contains no sheets.');
        }

        resolve({
          sheetNames,
          getSheetData: (sheetName) => {
            const targetSheet = sheetName || sheetNames[0];
            const ws = workbook.Sheets[targetSheet];
            if (!ws) return [];
            return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, dateNF: 'yyyy-mm-dd' });
          }
        });
      } catch (err) {
        reject(new Error(`Failed to read Excel workbook: ${err.message}`));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file buffer'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Automatically maps raw spreadsheet headers to standard fields using aliases
 */
export function autoDetectColumnMappings(headers = [], fieldDefs = FIELD_DEFINITIONS) {
  const mappings = {}; // { [standardFieldKey]: rawHeaderIndex }
  const normalizedHeaders = headers.map(normalizeHeader);
  const usedHeaderIndexes = new Set();

  // 1. Resolve exact alias matches for every field first.
  // This prevents broad aliases like "parent" from consuming "parent email" or "parent phone".
  fieldDefs.forEach(field => {
    const aliases = field.aliases.map(normalizeHeader).filter(Boolean);
    const matchedIdx = normalizedHeaders.findIndex((header, index) =>
      Boolean(header) && !usedHeaderIndexes.has(index) && aliases.includes(header)
    );
    if (matchedIdx !== -1) {
      mappings[field.key] = matchedIdx;
      usedHeaderIndexes.add(matchedIdx);
    }
  });

  // 2. Resolve longest partial matches for remaining unmapped fields
  fieldDefs.forEach(field => {
    if (mappings[field.key] !== undefined) return;
    const aliases = field.aliases
      .map(normalizeHeader)
      .filter(alias => alias.length >= 4)
      .sort((a, b) => b.length - a.length);

    let best = null;
    normalizedHeaders.forEach((header, index) => {
      if (!header || usedHeaderIndexes.has(index)) return;
      const alias = aliases.find(candidate => header.includes(candidate));
      if (alias && (!best || alias.length > best.alias.length)) {
        best = { index, alias };
      }
    });

    if (best) {
      mappings[field.key] = best.index;
      usedHeaderIndexes.add(best.index);
    }
  });

  return mappings;
}

/**
 * Validates student mapped rows
 */
export function validateImportRows(rawRows, headerRowIdx, mappings, {
  activeClasses = [],
  streamsPerClass = {},
  existingStudents = [],
  dateFormat = 'DD/MM/YYYY'
} = {}) {
  const dataRows = rawRows.slice(headerRowIdx + 1).filter(r => r.some(c => String(c ?? '').trim() !== ''));
  const seenFileAdmNos = new Set();
  const existingAdmMap = new Map();

  existingStudents.forEach(s => {
    const adm = String(s.admNo || s.adm_no || '').trim().toLowerCase();
    if (adm) existingAdmMap.set(adm, s);
  });

  const validatedRows = [];
  let validCount = 0;
  let fileDuplicateCount = 0;
  let dbDuplicateCount = 0;
  let missingRequiredCount = 0;
  let invalidClassCount = 0;

  dataRows.forEach((row, rowIdx) => {
    const record = { _rowNumber: headerRowIdx + 2 + rowIdx, _rawRow: row };
    const rowErrors = {};
    const rowWarnings = {};

    // Extract mapped values
    FIELD_DEFINITIONS.forEach(def => {
      const colIdx = mappings[def.key];
      const rawVal = colIdx !== undefined ? row[colIdx] : '';
      if (def.key === 'dob') {
        record[def.key] = normalizeImportDate(rawVal, dateFormat);
      } else {
        record[def.key] = String(rawVal ?? '').trim();
      }
    });

    // 1. Admission Number Validation (preserve text & leading zeroes)
    const rawAdm = record.admNo;
    if (!rawAdm) {
      rowErrors.admNo = 'Admission number is required';
      missingRequiredCount++;
    } else {
      const lowerAdm = rawAdm.toLowerCase();
      // Internal file duplicate check
      if (seenFileAdmNos.has(lowerAdm)) {
        rowErrors.admNo = `Duplicate admission number in this file (${rawAdm})`;
        fileDuplicateCount++;
      } else {
        seenFileAdmNos.add(lowerAdm);
      }

      // Existing DB duplicate check
      if (existingAdmMap.has(lowerAdm)) {
        record._isDbDuplicate = true;
        record._existingRecord = existingAdmMap.get(lowerAdm);
        rowWarnings.admNo = `Matches existing student in database: ${record._existingRecord.name}`;
        dbDuplicateCount++;
      }
    }

    // 2. Name Validation
    if (!record.name || record.name.length < 2) {
      rowErrors.name = 'Student name is required (min 2 characters)';
      missingRequiredCount++;
    }

    // 3. Class Validation (NO DANGEROUS DEFAULTS)
    if (!record.class) {
      rowErrors.class = 'Class is required (no default will be assigned)';
      missingRequiredCount++;
    } else {
      const matchedClass = activeClasses.find(c => c.toLowerCase() === record.class.toLowerCase());
      if (!matchedClass && activeClasses.length > 0) {
        rowErrors.class = `"${record.class}" is not in school's active classes list`;
        invalidClassCount++;
      } else if (matchedClass) {
        record.class = matchedClass; // Normalize casing
      }
    }

    // 4. Stream Validation
    if (record.stream && record.class) {
      const validStreams = streamsPerClass[record.class] || [];
      if (validStreams.length > 0) {
        const matchedStream = validStreams.find(s => s.toLowerCase() === record.stream.toLowerCase());
        if (!matchedStream) {
          rowWarnings.stream = `Stream "${record.stream}" is unconfigured for class ${record.class}`;
        } else {
          record.stream = matchedStream;
        }
      }
    }

    // 5. Gender Normalization
    if (record.gender) {
      const g = record.gender.toLowerCase();
      if (g.startsWith('m')) record.gender = 'Male';
      else if (g.startsWith('f')) record.gender = 'Female';
      else rowWarnings.gender = `Unrecognized gender "${record.gender}"`;
    }

    // 6. Date of Birth Validation
    if (record.dob && !/^\d{4}-\d{2}-\d{2}$/.test(record.dob)) {
      rowErrors.dob = 'Date of birth must be a valid date. Use DD/MM/YYYY or YYYY-MM-DD.';
    }

    // 7. Residence Type Normalization
    if (record.residence) {
      const resLower = record.residence.toLowerCase();
      if (resLower.includes('board') || resLower.includes('hostel')) {
        record.residence = 'Boarding';
      } else {
        record.residence = 'Day';
      }
    }

    // Preserve known historical enrollment states. Unknown values must be
    // reviewed rather than silently turning former learners into active ones.
    if (record.status) {
      const statusValue = normalizeHeader(record.status);
      const statusMap = {
        active: 'Active', current: 'Active', enrolled: 'Active',
        inactive: 'Inactive', archived: 'Inactive',
        transferred: 'Transferred', 'transferred out': 'Transferred',
        graduated: 'Graduated', alumni: 'Graduated', completed: 'Graduated',
        left: 'Left', withdrawn: 'Left', discontinued: 'Left',
        suspended: 'Suspended'
      };
      if (statusMap[statusValue]) {
        record.status = statusMap[statusValue];
      } else {
        rowErrors.status = `Unrecognised enrollment status "${record.status}". Map it to a supported status before importing.`;
      }
    }

    const hasErrors = Object.keys(rowErrors).length > 0;
    if (!hasErrors) validCount++;

    validatedRows.push({
      ...record,
      _errors: rowErrors,
      _warnings: rowWarnings,
      _isValid: !hasErrors
    });
  });

  return {
    rows: validatedRows,
    summary: {
      totalRows: dataRows.length,
      validCount,
      fileDuplicateCount,
      dbDuplicateCount,
      missingRequiredCount,
      invalidClassCount
    }
  };
}

/**
 * Validates teacher mapped rows
 */
import { normalizeTeacherImportStatus } from './importSafety.mjs';

export function validateTeacherImportRows(rawRows, headerRowIdx, mappings, {
  existingTeachers = [],
  availableSubjects = []
} = {}) {
  const dataRows = rawRows.slice(headerRowIdx + 1).filter(r => r.some(c => String(c ?? '').trim() !== ''));
  const seenFileStaffCodes = new Set();
  const seenFilePhones = new Set();
  const existingCodeMap = new Map();
  const existingPhoneMap = new Map();

  existingTeachers.forEach(t => {
    const code = String(t.staff_code || t.staffCode || '').trim().toLowerCase();
    if (code) existingCodeMap.set(code, t);
    const phone = String(t.phone || '').trim().replace(/\s+/g, '');
    if (phone) existingPhoneMap.set(phone, t);
  });

  const validatedRows = [];
  let validCount = 0;
  let fileDuplicateCount = 0;
  let dbDuplicateCount = 0;
  let missingRequiredCount = 0;

  dataRows.forEach((row, rowIdx) => {
    const record = { _rowNumber: headerRowIdx + 2 + rowIdx, _rawRow: row };
    const rowErrors = {};
    const rowWarnings = {};

    TEACHER_FIELD_DEFINITIONS.forEach(def => {
      const colIdx = mappings[def.key];
      const rawVal = colIdx !== undefined ? row[colIdx] : '';
      record[def.key] = String(rawVal ?? '').trim();
    });

    // 1. Full Name (Required)
    if (!record.name || record.name.length < 2) {
      rowErrors.name = 'Full name is required (min 2 characters)';
      missingRequiredCount++;
    }

    // 2. Phone Number (Required)
    if (!record.phone) {
      rowErrors.phone = 'Phone number is required';
      missingRequiredCount++;
    } else {
      const cleanPhone = record.phone.replace(/[\s-]/g, '');
      if (seenFilePhones.has(cleanPhone)) {
        rowErrors.phone = `Duplicate phone number in file: ${record.phone}`;
        fileDuplicateCount++;
      } else {
        seenFilePhones.add(cleanPhone);
      }
      if (existingPhoneMap.has(cleanPhone)) {
        record._isDbDuplicate = true;
        record._existingRecord = existingPhoneMap.get(cleanPhone);
        rowWarnings.phone = `Phone matches existing teacher: ${record._existingRecord.name}`;
        dbDuplicateCount++;
      }
    }

    // 3. Staff Code (Optional, but if present must be unique per school)
    if (record.staffCode) {
      const lowerCode = record.staffCode.toLowerCase();
      if (seenFileStaffCodes.has(lowerCode)) {
        rowErrors.staffCode = `Duplicate staff code in file: ${record.staffCode}`;
        fileDuplicateCount++;
      } else {
        seenFileStaffCodes.add(lowerCode);
      }
      if (existingCodeMap.has(lowerCode)) {
        record._isDbDuplicate = true;
        record._existingRecord = existingCodeMap.get(lowerCode);
        rowWarnings.staffCode = `Staff code matches existing teacher: ${record._existingRecord.name}`;
        dbDuplicateCount++;
      }
    }

    // 4. Subjects Parsing (Support commas, semicolons, slashes)
    if (record.subjects) {
      const subjectList = record.subjects
        .split(/[,;/|]+/)
        .map(s => s.trim())
        .filter(Boolean);
      record._parsedSubjects = subjectList;
    } else {
      record._parsedSubjects = [];
    }

    // 5. Preserve recognized employment states. Unknown values are errors;
    // they must never silently reactivate a former or suspended employee.
    if (record.status) {
      const normalizedStatus = normalizeTeacherImportStatus(record.status);
      if (!normalizedStatus) {
        rowErrors.status = `Unrecognised teacher status "${record.status}". Map it to Active, Left, Inactive, Suspended, Retired or On Leave.`;
      } else {
        record.status = normalizedStatus;
      }
    }

    const hasErrors = Object.keys(rowErrors).length > 0;
    if (!hasErrors) validCount++;

    validatedRows.push({
      ...record,
      _errors: rowErrors,
      _warnings: rowWarnings,
      _isValid: !hasErrors
    });
  });

  return {
    rows: validatedRows,
    summary: {
      totalRows: dataRows.length,
      validCount,
      fileDuplicateCount,
      dbDuplicateCount,
      missingRequiredCount
    }
  };
}

/**
 * Downloads student template
 */
export function downloadImportTemplate(format = 'xlsx') {
  const headers = [
    'Admission Number *',
    'Student Name *',
    'Class *',
    'Stream',
    'Gender',
    'Date of Birth (DD/MM/YYYY)',
    'Parent Name',
    'Parent Phone',
    'Parent Email',
    'Residence (Day/Boarding)'
  ];

  const sampleRows = [
    [
      'ADM-1001',
      'John Kamau',
      'Grade 1',
      'North',
      'Male',
      '14/05/2018',
      'James Kamau',
      '+254712345678',
      'j.kamau@gmail.com',
      'Day'
    ],
    [
      'ADM-1002',
      'Mary Wanjiku',
      'Grade 1',
      'South',
      'Female',
      '22/09/2018',
      'Grace Wanjiku',
      '+254722987654',
      'wanjiku.g@yahoo.com',
      'Boarding'
    ]
  ];

  if (format === 'csv') {
    const csvContent = Papa.unparse([headers, ...sampleRows]);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'Termly_Student_Import_Template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return;
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
  ws['!cols'] = [
    { wch: 18 }, { wch: 24 }, { wch: 14 }, { wch: 14 },
    { wch: 10 }, { wch: 22 }, { wch: 22 }, { wch: 18 },
    { wch: 24 }, { wch: 20 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Students');
  XLSX.writeFile(wb, 'Termly_Student_Import_Template.xlsx');
}

/**
 * Downloads teacher template
 */
export function downloadTeacherImportTemplate(format = 'xlsx') {
  const headers = [
    'Staff Code',
    'Full Name *',
    'Phone Number *',
    'Email Address',
    'TSC Number',
    'Subjects (comma separated)',
    'Status (Active/Left)'
  ];

  const sampleRows = [
    [
      'T-001',
      'Grace Mutua',
      '+254711223344',
      'grace.mutua@school.ac.ke',
      'TSC-892144',
      'Mathematics, Physics',
      'Active'
    ],
    [
      'T-002',
      'David Omondi',
      '+254722334455',
      'david.omondi@school.ac.ke',
      'TSC-781920',
      'English, Literature',
      'Active'
    ]
  ];

  if (format === 'csv') {
    const csvContent = Papa.unparse([headers, ...sampleRows]);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'Termly_Teacher_Import_Template.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return;
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
  ws['!cols'] = [
    { wch: 16 }, { wch: 24 }, { wch: 18 }, { wch: 26 },
    { wch: 16 }, { wch: 30 }, { wch: 16 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Teachers');
  XLSX.writeFile(wb, 'Termly_Teacher_Import_Template.xlsx');
}

/**
 * Generates and downloads an error report workbook explaining why rows failed
 */
export function downloadErrorReport(failedRows = [], filename = 'Import_Error_Report') {
  if (failedRows.length === 0) return;

  const exportData = failedRows.map(row => ({
    'Spreadsheet Row #': row._rowNumber || '',
    'Identifier': row.admNo || row.staffCode || '',
    'Name': row.name || '',
    'Failure Reason': Object.values(row._errors || {}).join('; ') || row.reason || 'Validation error'
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(exportData);
  XLSX.utils.book_append_sheet(wb, ws, 'Errors');
  XLSX.writeFile(wb, `${filename}_${new Date().toISOString().split('T')[0]}.xlsx`);
}
