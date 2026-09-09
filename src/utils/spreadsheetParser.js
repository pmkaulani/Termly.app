import * as XLSX from 'xlsx';
import Papa from 'papaparse';

export const FIELD_DEFINITIONS = [
  { key: 'admNo', label: 'Admission Number', required: true, aliases: ['admission number', 'admission no', 'adm no', 'adm no.', 'adm', 'registration number', 'reg no', 'student id', 'adm_no'] },
  { key: 'name', label: 'Student Name', required: true, aliases: ['student name', 'name', 'full name', 'learner name', 'jina', 'student', 'names'] },
  { key: 'class', label: 'Class / Grade', required: true, aliases: ['class', 'grade', 'level', 'form', 'class/grade', 'standard'] },
  { key: 'stream', label: 'Stream / Section', required: false, aliases: ['stream', 'section', 'house', 'arm'] },
  { key: 'gender', label: 'Gender', required: false, aliases: ['gender', 'sex', 'm/f'] },
  { key: 'dob', label: 'Date of Birth', required: false, aliases: ['date of birth', 'dob', 'birth date', 'birthdate'] },
  { key: 'parent', label: 'Parent / Guardian Name', required: false, aliases: ['parent name', 'parent', 'guardian name', 'guardian', 'father', 'mother', 'parent / guardian'] },
  { key: 'parentPhone', label: 'Parent Phone Number', required: false, aliases: ['parent phone', 'phone', 'phone number', 'contact', 'mobile', 'parent contact', 'guardian phone', 'parent_phone'] },
  { key: 'parentEmail', label: 'Parent Email', required: false, aliases: ['parent email', 'email', 'email address', 'guardian email', 'parent_email'] }
];

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
        const workbook = XLSX.read(buffer, { type: 'array' });
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
            return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
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
export function autoDetectColumnMappings(headers = []) {
  const mappings = {}; // { [standardFieldKey]: rawHeaderIndex }
  const normalizedHeaders = headers.map(h => String(h || '').trim().toLowerCase().replace(/[^\w\s]/g, ''));

  FIELD_DEFINITIONS.forEach(field => {
    let matchedIdx = -1;

    // Exact alias check
    for (let i = 0; i < normalizedHeaders.length; i++) {
      const h = normalizedHeaders[i];
      if (!h) continue;
      if (field.aliases.some(alias => h === alias || h === alias.replace(/[^\w\s]/g, ''))) {
        matchedIdx = i;
        break;
      }
    }

    // Partial contains check if no exact match
    if (matchedIdx === -1) {
      for (let i = 0; i < normalizedHeaders.length; i++) {
        const h = normalizedHeaders[i];
        if (!h) continue;
        if (field.aliases.some(alias => h.includes(alias))) {
          matchedIdx = i;
          break;
        }
      }
    }

    if (matchedIdx !== -1) {
      mappings[field.key] = matchedIdx;
    }
  });

  return mappings;
}

/**
 * Validates mapped data rows against business rules & existing database students
 *
 * @param {Array<Array<any>>} rawRows 2D array of rows from sheet
 * @param {number} headerRowIdx Index of header row (usually 0)
 * @param {object} mappings { [fieldKey]: headerIndex }
 * @param {object} options
 * @param {Array<string>} options.activeClasses Valid school classes
 * @param {object} options.streamsPerClass Valid streams per class
 * @param {Array<object>} options.existingStudents Existing DB students { admNo, name, class, stream }
 */
export function validateImportRows(rawRows, headerRowIdx, mappings, {
  activeClasses = [],
  streamsPerClass = {},
  existingStudents = []
} = {}) {
  const dataRows = rawRows.slice(headerRowIdx + 1).filter(r => r.some(c => String(c).trim() !== ''));
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
      const rawVal = colIdx !== undefined ? String(row[colIdx] || '').trim() : '';
      record[def.key] = rawVal;
    });

    // 1. Admission Number Validation
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
 * Generates and downloads a sample student import template in .xlsx and .csv formats
 */
export function downloadImportTemplate(format = 'xlsx') {
  const headers = [
    'Admission Number *',
    'Student Name *',
    'Class *',
    'Stream',
    'Gender',
    'Date of Birth',
    'Parent Name',
    'Parent Phone',
    'Parent Email'
  ];

  const sampleRows = [
    [
      'ADM-1001',
      'John Kamau',
      'Grade 1',
      'North',
      'Male',
      '2018-05-14',
      'James Kamau',
      '+254712345678',
      'j.kamau@gmail.com'
    ],
    [
      'ADM-1002',
      'Mary Wanjiku',
      'Grade 1',
      'South',
      'Female',
      '2018-09-22',
      'Grace Wanjiku',
      '+254722987654',
      'wanjiku.g@yahoo.com'
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

  // Excel format
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
  ws['!cols'] = [
    { wch: 18 }, // Admission No
    { wch: 24 }, // Student Name
    { wch: 14 }, // Class
    { wch: 14 }, // Stream
    { wch: 10 }, // Gender
    { wch: 14 }, // DOB
    { wch: 22 }, // Parent Name
    { wch: 18 }, // Parent Phone
    { wch: 24 }  // Parent Email
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Students');
  XLSX.writeFile(wb, 'Termly_Student_Import_Template.xlsx');
}

/**
 * Generates and downloads an error report workbook explaining why rows failed
 */
export function downloadErrorReport(failedRows = []) {
  if (failedRows.length === 0) return;

  const exportData = failedRows.map(row => ({
    'Row #': row._rowNumber || '',
    'Admission Number': row.admNo || '',
    'Student Name': row.name || '',
    'Class': row.class || '',
    'Stream': row.stream || '',
    'Gender': row.gender || '',
    'Failure Reason': Object.values(row._errors || {}).join('; ') || 'Validation error'
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(exportData);
  XLSX.utils.book_append_sheet(wb, ws, 'Import_Errors');
  XLSX.writeFile(wb, `Student_Import_Error_Report_${new Date().toISOString().split('T')[0]}.xlsx`);
}
