import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useDialog } from '../contexts/DialogContext';
import { bulkImportStudents, getStudents } from '../data/studentStore';
import {
  readSpreadsheetFile,
  autoDetectColumnMappings,
  detectHeaderRow,
  validateImportRows,
  downloadImportTemplate,
  downloadErrorReport,
  FIELD_DEFINITIONS
} from '../utils/spreadsheetParser';
import {
  UploadIcon, CheckIcon, AlertIcon, DeleteIcon,
  XIcon, FileIcon
} from './CommonIcons';

export default function StudentImporter({ profile = {}, onImport, onClose, mode = 'standard' }) {
  const { alert, confirm } = useDialog();

  // Step 1: Upload, Step 2: Select Sheet, Step 3: Map Columns, Step 4 & 5 & 6: Validate/Preview/Fix, Step 7 & 8: Import, Step 9: Result
  const [step, setStep] = useState(1);
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState(null);
  const [sheetNames, setSheetNames] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [rawRows, setRawRows] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [headerRowIndex, setHeaderRowIndex] = useState(0);
  const [dateFormat, setDateFormat] = useState('DD/MM/YYYY');
  const [mappings, setMappings] = useState({});
  const [validatedData, setValidatedData] = useState({ rows: [], summary: {} });
  const [duplicateAction, setDuplicateAction] = useState('skip'); // 'skip' or 'update'
  const [existingDbStudents, setExistingDbStudents] = useState([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [importResult, setImportResult] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const fileInputRef = useRef(null);

  // Load existing DB students on mount for duplicate detection
  useEffect(() => {
    getStudents().then(students => {
      setExistingDbStudents(students || []);
    }).catch(() => {
      setExistingDbStudents([]);
    });
  }, []);

  const activeClasses = profile?.activeClasses || [];
  const streamsPerClass = profile?.streamsPerClass || {};

  // Step 1: File Selection & Parsing
  const handleFileChange = async (selectedFile) => {
    if (!selectedFile) return;
    const extension = selectedFile.name?.split('.').pop()?.toLowerCase();
    if (!['xlsx', 'xls', 'csv', 'tsv'].includes(extension)) {
      alert({ title: 'Unsupported File', message: 'Choose an Excel (.xlsx/.xls), CSV or TSV file.', variant: 'warning' });
      return;
    }
    if (selectedFile.size > 10 * 1024 * 1024) {
      alert({ title: 'File Too Large', message: 'Keep each import file below 10 MB. Split larger files into smaller batches.', variant: 'warning' });
      return;
    }
    setFile(selectedFile);
    setIsProcessing(true);

    try {
      const parsed = await readSpreadsheetFile(selectedFile);
      setSheetNames(parsed.sheetNames);

      if (parsed.sheetNames.length > 1) {
        setSelectedSheet(parsed.sheetNames[0]);
        setStep(2); // Sheet Selection Step
      } else {
        const sheetRows = parsed.getSheetData(parsed.sheetNames[0]);
        processSheetData(sheetRows);
      }
    } catch (err) {
      alert({ title: 'File Error', message: err.message, variant: 'danger' });
      setFile(null);
    } finally {
      setIsProcessing(false);
    }
  };

  const processSheetData = (rows) => {
    if (!rows || rows.length < 2) {
      alert({ title: 'Empty Sheet', message: 'The sheet must have a header row and at least one student data row.', variant: 'warning' });
      return;
    }

    setRawRows(rows);
    const detectedHeaderIndex = detectHeaderRow(rows, 20);
    setHeaderRowIndex(detectedHeaderIndex);
    const headerRow = (rows[detectedHeaderIndex] || []).map(h => String(h || '').trim());
    setHeaders(headerRow);

    // Auto detect column mappings
    const detected = autoDetectColumnMappings(headerRow);
    setMappings(detected);

    // Run initial validation
    const validation = validateImportRows(rows, detectedHeaderIndex, detected, {
      activeClasses,
      streamsPerClass,
      existingStudents: existingDbStudents,
      dateFormat
    });
    setValidatedData(validation);
    setStep(3); // Column Mapping & Validation Step
  };

  const handleSelectSheetConfirm = async () => {
    setIsProcessing(true);
    try {
      const parsed = await readSpreadsheetFile(file);
      const sheetRows = parsed.getSheetData(selectedSheet);
      processSheetData(sheetRows);
    } catch (err) {
      alert({ title: 'Error', message: err.message, variant: 'danger' });
    } finally {
      setIsProcessing(false);
    }
  };

  // Step 3: Column Mapping Adjustment
  const handleMappingChange = (fieldKey, rawColIdx) => {
    const updated = { ...mappings };
    if (rawColIdx === '' || rawColIdx === null) {
      delete updated[fieldKey];
    } else {
      updated[fieldKey] = Number(rawColIdx);
    }
    setMappings(updated);

    // Re-run validation with updated mappings
    const validation = validateImportRows(rawRows, headerRowIndex, updated, {
      activeClasses,
      streamsPerClass,
      existingStudents: existingDbStudents,
      dateFormat
    });
    setValidatedData(validation);
  };

  // Step 6: Fix Straightforward Errors Inline
  const handleInlineCellChange = (rowIdx, fieldKey, newVal) => {
    const updatedRows = [...validatedData.rows];
    updatedRows[rowIdx][fieldKey] = newVal;

    // Recalculate validation for this row
    const row = updatedRows[rowIdx];
    const errors = {};

    if (!row.name || row.name.length < 2) errors.name = 'Student name is required (min 2 chars)';
    if (!row.admNo) errors.admNo = 'Admission number is required';
    if (!row.class) errors.class = 'Class is required';
    else if (activeClasses.length > 0 && !activeClasses.includes(row.class)) {
      errors.class = `"${row.class}" is not in active classes`;
    }
    if (row.status && !['Active', 'Inactive', 'Transferred', 'Graduated', 'Left', 'Suspended'].includes(row.status)) {
      errors.status = 'Use Active, Inactive, Transferred, Graduated, Left or Suspended.';
    }

    row._errors = errors;
    row._isValid = Object.keys(errors).length === 0;

    const validCount = updatedRows.filter(r => r._isValid).length;
    setValidatedData({
      ...validatedData,
      rows: updatedRows,
      summary: {
        ...validatedData.summary,
        validCount
      }
    });
  };

  // Step 8: Execute Import
  const handleStartImport = async () => {
    const validRows = validatedData.rows.filter(r => r._isValid);
    if (validRows.length === 0) {
      alert({ title: 'No Valid Rows', message: 'There are no valid student rows to import. Please correct errors first.', variant: 'warning' });
      return;
    }

    const uncorrectedErrors = validatedData.rows.length - validRows.length;
    if (uncorrectedErrors > 0) {
      const proceed = await confirm({
        title: 'Import with Skipped Rows?',
        message: `${uncorrectedErrors} rows have errors and will be skipped. Only ${validRows.length} valid students will be imported. Proceed?`,
        variant: 'warning'
      });
      if (!proceed) return;
    }

    setStep(8); // Importing
    setProgress({ current: 0, total: validRows.length });

    try {
      const result = await bulkImportStudents(validRows, (current, total) => {
        setProgress({ current, total });
      }, {
        duplicateAction,
        // A historical migration must not create a fresh current-term invoice.
        createInitialFees: mode !== 'migration'
      });

      const completedResult = {
        ...result,
        totalRows: validatedData.summary.totalRows || validatedData.rows.length,
        failed: (result.errors?.length || 0) + uncorrectedErrors,
        sourceFileName: file?.name ? String(file.name).split('.').pop().toLowerCase() : null
      };
      setImportResult(completedResult);
      setStep(9); // Done

      if (onImport) onImport(completedResult);
    } catch (err) {
      alert({ title: 'Import Failed', message: err.message, variant: 'danger' });
      setStep(5);
    }
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileChange(e.dataTransfer.files[0]);
    }
  };

  const failedRows = useMemo(() => {
    return validatedData.rows.filter(r => !r._isValid);
  }, [validatedData.rows]);

  return (
    <div className="importer-overlay" onClick={onClose} style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(15, 23, 42, 0.7)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 9999,
      backdropFilter: 'blur(4px)', padding: '16px'
    }}>
      <div className="importer-card" onClick={e => e.stopPropagation()} style={{
        background: '#ffffff', borderRadius: '16px', width: '100%',
        maxWidth: '900px', maxHeight: '90vh', display: 'flex',
        flexDirection: 'column', overflow: 'hidden', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.25)',
        border: '1px solid #cbd5e1'
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid #e2e8f0',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: '#f8fafc'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <div style={{
              width: '38px', height: '38px', borderRadius: '10px',
              background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff'
            }}>
              <UploadIcon size={20} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: '#0f172a' }}>
                Bulk Student Importer
              </h3>
              <p style={{ margin: '3px 0 0', fontSize: '0.8rem', color: '#64748b' }}>
                {step === 1 && 'Step 1: Upload Excel (.xlsx/.xls) or CSV/TSV file'}
                {step === 2 && 'Step 2: Select Worksheet'}
                {step === 3 && 'Step 3: Map Columns & Detect Data'}
                {step >= 4 && step <= 6 && `Step 4: Review & Fix Validation (${validatedData.summary.validCount || 0} valid / ${validatedData.summary.totalRows || 0} rows)`}
                {step === 8 && 'Importing students into database...'}
                {step === 9 && 'Import Complete!'}
              </p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.4rem', cursor: 'pointer', color: '#94a3b8' }}>
            <XIcon size={20} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '24px', flex: 1, overflowY: 'auto' }}>
          {/* STEP 1: CHOOSE FILE */}
          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div
                onDragEnter={handleDrag}
                onDragOver={handleDrag}
                onDragLeave={handleDrag}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  height: '240px',
                  border: dragActive ? '2px dashed #2563eb' : '2px dashed #cbd5e1',
                  borderRadius: '14px',
                  background: dragActive ? '#eff6ff' : '#f8fafc',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  padding: '20px'
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx, .xls, .csv, .tsv"
                  style={{ display: 'none' }}
                  onChange={e => handleFileChange(e.target.files?.[0])}
                />
                <div style={{
                  width: '54px', height: '54px', borderRadius: '50%',
                  background: '#e0e7ff', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', color: '#4338ca', marginBottom: '14px'
                }}>
                  <UploadIcon size={26} />
                </div>
                <h4 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: '#1e293b' }}>
                  Click to browse or drag and drop student file
                </h4>
                <p style={{ margin: '6px 0 0', fontSize: '0.85rem', color: '#64748b' }}>
                  Supports Microsoft Excel (.xlsx, .xls) and Delimited text (.csv, .tsv)
                </p>
                <span style={{ marginTop: '12px', fontSize: '0.75rem', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Max 5,000 students per upload
                </span>
              </div>

              {/* Sample Template Downloads */}
              <div style={{
                background: '#f1f5f9',
                borderRadius: '10px',
                padding: '14px 18px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '12px'
              }}>
                <div>
                  <strong style={{ fontSize: '0.88rem', color: '#1e293b' }}>Need an import format template?</strong>
                  <p style={{ margin: '2px 0 0', fontSize: '0.78rem', color: '#64748b' }}>
                    Download a pre-formatted template with example rows and required column annotations.
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => downloadImportTemplate('xlsx')}
                    style={{
                      padding: '6px 14px', borderRadius: '6px', border: '1px solid #cbd5e1',
                      background: '#ffffff', color: '#1e293b', fontSize: '0.82rem', fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    Download Excel (.xlsx)
                  </button>
                  <button
                    onClick={() => downloadImportTemplate('csv')}
                    style={{
                      padding: '6px 14px', borderRadius: '6px', border: '1px solid #cbd5e1',
                      background: '#ffffff', color: '#1e293b', fontSize: '0.82rem', fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    Download CSV
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* STEP 2: SELECT WORKSHEET */}
          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <p style={{ fontSize: '0.9rem', color: '#475569', margin: 0 }}>
                This Excel workbook contains multiple worksheets. Please select the sheet that contains student enrollment data:
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {sheetNames.map(name => (
                  <label key={name} style={{
                    display: 'flex', alignItems: 'center', gap: '12px',
                    padding: '12px 16px', borderRadius: '8px',
                    border: selectedSheet === name ? '2px solid #2563eb' : '1px solid #cbd5e1',
                    background: selectedSheet === name ? '#eff6ff' : '#ffffff',
                    cursor: 'pointer'
                  }}>
                    <input
                      type="radio"
                      name="sheetSelect"
                      checked={selectedSheet === name}
                      onChange={() => setSelectedSheet(name)}
                      style={{ width: '18px', height: '18px', accentColor: '#2563eb' }}
                    />
                    <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#1e293b' }}>{name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* STEP 3: MAP COLUMNS */}
          {step === 3 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <p style={{ margin: 0, fontSize: '0.88rem', color: '#475569' }}>
                  Verify that the detected file columns match the standard student fields:
                </p>
                <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                  {headers.length} headers found in sheet
                </span>
              </div>

              <div style={{ border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '1px solid #cbd5e1' }}>
                      <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700 }}>Standard Field</th>
                      <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700 }}>Requirement</th>
                      <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700 }}>Mapped File Column</th>
                    </tr>
                  </thead>
                  <tbody>
                    {FIELD_DEFINITIONS.map(field => {
                      const currentMappedIdx = mappings[field.key];
                      const isMapped = currentMappedIdx !== undefined;

                      return (
                        <tr key={field.key} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '8px 14px', fontWeight: 600 }}>
                            {field.label}
                          </td>
                          <td style={{ padding: '8px 14px' }}>
                            {field.required ? (
                              <span style={{ background: '#fee2e2', color: '#991b1b', padding: '2px 8px', borderRadius: '4px', fontSize: '0.72rem', fontWeight: 700 }}>
                                Required
                              </span>
                            ) : (
                              <span style={{ background: '#f1f5f9', color: '#64748b', padding: '2px 8px', borderRadius: '4px', fontSize: '0.72rem' }}>
                                Optional
                              </span>
                            )}
                          </td>
                          <td style={{ padding: '8px 14px' }}>
                            <select
                              value={isMapped ? currentMappedIdx : ''}
                              onChange={e => handleMappingChange(field.key, e.target.value)}
                              style={{
                                width: '100%',
                                maxWidth: '280px',
                                padding: '6px 10px',
                                borderRadius: '6px',
                                border: isMapped ? '1.5px solid #10b981' : (field.required ? '1.5px solid #ef4444' : '1px solid #cbd5e1'),
                                background: isMapped ? '#f0fdf4' : '#ffffff',
                                fontWeight: isMapped ? 600 : 400,
                                fontSize: '0.82rem'
                              }}
                            >
                              <option value="">-- Not mapped --</option>
                              {headers.map((h, hIdx) => (
                                <option key={hIdx} value={hIdx}>
                                  Column {hIdx + 1}: {h || `[Col ${hIdx + 1}]`}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* STEP 4 & 5 & 6: VALIDATE, PREVIEW, AND FIX ERRORS */}
          {(step === 4 || step === 5 || step === 6) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Validation Summary Metrics */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: '10px'
              }}>
                <div style={{ background: '#f8fafc', padding: '10px 14px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                  <span style={{ fontSize: '0.72rem', color: '#64748b', textTransform: 'uppercase', fontWeight: 700 }}>Total Rows</span>
                  <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#1e293b' }}>{validatedData.summary.totalRows}</div>
                </div>
                <div style={{ background: '#f0fdf4', padding: '10px 14px', borderRadius: '8px', border: '1px solid #bbf7d0' }}>
                  <span style={{ fontSize: '0.72rem', color: '#15803d', textTransform: 'uppercase', fontWeight: 700 }}>Valid Records</span>
                  <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#16a34a' }}>{validatedData.summary.validCount}</div>
                </div>
                {validatedData.summary.missingRequiredCount > 0 && (
                  <div style={{ background: '#fee2e2', padding: '10px 14px', borderRadius: '8px', border: '1px solid #fecaca' }}>
                    <span style={{ fontSize: '0.72rem', color: '#991b1b', textTransform: 'uppercase', fontWeight: 700 }}>Missing Required</span>
                    <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#dc2626' }}>{validatedData.summary.missingRequiredCount}</div>
                  </div>
                )}
                {validatedData.summary.dbDuplicateCount > 0 && (
                  <div style={{ background: '#fffbeb', padding: '10px 14px', borderRadius: '8px', border: '1px solid #fef3c7' }}>
                    <span style={{ fontSize: '0.72rem', color: '#b45309', textTransform: 'uppercase', fontWeight: 700 }}>Existing in DB</span>
                    <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#d97706' }}>{validatedData.summary.dbDuplicateCount}</div>
                  </div>
                )}
                {validatedData.summary.invalidClassCount > 0 && (
                  <div style={{ background: '#fef2f2', padding: '10px 14px', borderRadius: '8px', border: '1px solid #fee2e2' }}>
                    <span style={{ fontSize: '0.72rem', color: '#991b1b', textTransform: 'uppercase', fontWeight: 700 }}>Invalid Class</span>
                    <div style={{ fontSize: '1.3rem', fontWeight: 800, color: '#dc2626' }}>{validatedData.summary.invalidClassCount}</div>
                  </div>
                )}
              </div>

              {/* Duplicate Handling Strategy */}
              {validatedData.summary.dbDuplicateCount > 0 && (
                <div style={{
                  background: '#fefce8',
                  border: '1px solid #fef08a',
                  borderRadius: '8px',
                  padding: '12px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '12px'
                }}>
                  <div>
                    <strong style={{ fontSize: '0.85rem', color: '#854d0e' }}>
                      Duplicate Handling ({validatedData.summary.dbDuplicateCount} existing students matched)
                    </strong>
                    <p style={{ margin: '2px 0 0', fontSize: '0.78rem', color: '#a16207' }}>
                      Choose how to handle records whose admission numbers match existing students in the database.
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="dupAction"
                        checked={duplicateAction === 'skip'}
                        onChange={() => setDuplicateAction('skip')}
                      />
                      Skip existing
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="dupAction"
                        checked={duplicateAction === 'update'}
                        onChange={() => setDuplicateAction('update')}
                      />
                      Update existing
                    </label>
                  </div>
                </div>
              )}

              {/* Spreadsheet Preview & Inline Error Fix Table */}
              <div style={{ border: '1px solid #cbd5e1', borderRadius: '8px', overflow: 'auto', maxHeight: '350px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '2px solid #cbd5e1' }}>
                      <th style={{ padding: '8px 10px', borderRight: '1px solid #e2e8f0', textAlign: 'center' }}>#</th>
                      <th style={{ padding: '8px 10px', borderRight: '1px solid #e2e8f0', textAlign: 'left' }}>Status</th>
                      <th style={{ padding: '8px 10px', borderRight: '1px solid #e2e8f0', textAlign: 'left' }}>Adm No *</th>
                      <th style={{ padding: '8px 10px', borderRight: '1px solid #e2e8f0', textAlign: 'left' }}>Student Name *</th>
                      <th style={{ padding: '8px 10px', borderRight: '1px solid #e2e8f0', textAlign: 'left' }}>Class *</th>
                      <th style={{ padding: '8px 10px', borderRight: '1px solid #e2e8f0', textAlign: 'left' }}>Stream</th>
                      <th style={{ padding: '8px 10px', borderRight: '1px solid #e2e8f0', textAlign: 'left' }}>Gender</th>
                      <th style={{ padding: '8px 10px', textAlign: 'left' }}>Parent Contact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validatedData.rows.slice(0, 50).map((row, idx) => {
                      const hasErr = !row._isValid;
                      const isDup = row._isDbDuplicate;

                      return (
                        <tr key={idx} style={{
                          background: hasErr ? '#fef2f2' : isDup ? '#fffbeb' : '#ffffff',
                          borderBottom: '1px solid #e2e8f0'
                        }}>
                          <td style={{ padding: '6px 8px', borderRight: '1px solid #e2e8f0', textAlign: 'center', color: '#64748b' }}>
                            {row._rowNumber}
                          </td>
                          <td style={{ padding: '6px 8px', borderRight: '1px solid #e2e8f0', whiteSpace: 'nowrap' }}>
                            {hasErr ? (
                              <span style={{ background: '#fee2e2', color: '#991b1b', padding: '2px 6px', borderRadius: '4px', fontSize: '0.72rem', fontWeight: 700 }} title={Object.values(row._errors).join('; ')}>
                                ⚠ Error
                              </span>
                            ) : isDup ? (
                              <span style={{ background: '#fef3c7', color: '#92400e', padding: '2px 6px', borderRadius: '4px', fontSize: '0.72rem', fontWeight: 700 }}>
                                🔁 {duplicateAction === 'update' ? 'Update' : 'Skip'}
                              </span>
                            ) : (
                              <span style={{ background: '#dcfce7', color: '#15803d', padding: '2px 6px', borderRadius: '4px', fontSize: '0.72rem', fontWeight: 700 }}>
                                ✓ Valid
                              </span>
                            )}
                          </td>
                          <td style={{ padding: '4px 6px', borderRight: '1px solid #e2e8f0' }}>
                            <input
                              type="text"
                              value={row.admNo}
                              onChange={e => handleInlineCellChange(idx, 'admNo', e.target.value)}
                              style={{
                                width: '100%', padding: '4px 6px', borderRadius: '4px',
                                border: row._errors.admNo ? '1.5px solid #dc2626' : '1px solid #cbd5e1',
                                fontSize: '0.8rem', fontWeight: 600
                              }}
                            />
                            {row._errors.admNo && <span style={{ color: '#dc2626', fontSize: '0.68rem', display: 'block' }}>{row._errors.admNo}</span>}
                          </td>
                          <td style={{ padding: '4px 6px', borderRight: '1px solid #e2e8f0' }}>
                            <input
                              type="text"
                              value={row.name}
                              onChange={e => handleInlineCellChange(idx, 'name', e.target.value)}
                              style={{
                                width: '100%', padding: '4px 6px', borderRadius: '4px',
                                border: row._errors.name ? '1.5px solid #dc2626' : '1px solid #cbd5e1',
                                fontSize: '0.8rem'
                              }}
                            />
                            {row._errors.name && <span style={{ color: '#dc2626', fontSize: '0.68rem', display: 'block' }}>{row._errors.name}</span>}
                          </td>
                          <td style={{ padding: '4px 6px', borderRight: '1px solid #e2e8f0' }}>
                            <input
                              type="text"
                              value={row.class}
                              onChange={e => handleInlineCellChange(idx, 'class', e.target.value)}
                              style={{
                                width: '100%', padding: '4px 6px', borderRadius: '4px',
                                border: row._errors.class ? '1.5px solid #dc2626' : '1px solid #cbd5e1',
                                fontSize: '0.8rem'
                              }}
                            />
                            {row._errors.class && <span style={{ color: '#dc2626', fontSize: '0.68rem', display: 'block' }}>{row._errors.class}</span>}
                          </td>
                          <td style={{ padding: '4px 6px', borderRight: '1px solid #e2e8f0' }}>
                            <input
                              type="text"
                              value={row.stream}
                              onChange={e => handleInlineCellChange(idx, 'stream', e.target.value)}
                              style={{ width: '100%', padding: '4px 6px', borderRadius: '4px', border: '1px solid #cbd5e1', fontSize: '0.8rem' }}
                            />
                          </td>
                          <td style={{ padding: '4px 6px', borderRight: '1px solid #e2e8f0' }}>
                            <input
                              type="text"
                              value={row.gender}
                              onChange={e => handleInlineCellChange(idx, 'gender', e.target.value)}
                              style={{ width: '100%', padding: '4px 6px', borderRadius: '4px', border: '1px solid #cbd5e1', fontSize: '0.8rem' }}
                            />
                          </td>
                          <td style={{ padding: '4px 6px' }}>
                            <input
                              type="text"
                              value={row.parentPhone}
                              onChange={e => handleInlineCellChange(idx, 'parentPhone', e.target.value)}
                              style={{ width: '100%', padding: '4px 6px', borderRadius: '4px', border: '1px solid #cbd5e1', fontSize: '0.8rem' }}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {validatedData.rows.length > 50 && (
                <div style={{ fontSize: '0.75rem', color: '#64748b', textAlign: 'center' }}>
                  Showing first 50 rows of {validatedData.rows.length} total rows.
                </div>
              )}
            </div>
          )}

          {/* STEP 8: IMPORTING PROGRESS */}
          {step === 8 && (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <div style={{
                width: '60px', height: '60px', borderRadius: '50%',
                background: '#eff6ff', color: '#2563eb', margin: '0 auto 16px',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
                <UploadIcon size={30} />
              </div>
              <h4 style={{ margin: '0 0 8px', fontSize: '1.2rem', fontWeight: 700 }}>
                Importing Students...
              </h4>
              <p style={{ margin: '0 0 20px', fontSize: '0.88rem', color: '#64748b' }}>
                Inserting student records, assigning subjects, and creating term fee schedules.
              </p>
              <div style={{
                background: '#e2e8f0', borderRadius: '10px', height: '12px',
                overflow: 'hidden', maxWidth: '400px', margin: '0 auto 10px'
              }}>
                <div style={{
                  background: '#2563eb', height: '100%',
                  width: `${progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0}%`,
                  transition: 'width 0.3s ease'
                }} />
              </div>
              <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#475569' }}>
                {progress.current} of {progress.total} processed ({progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0}%)
              </span>
            </div>
          )}

          {/* STEP 9: RESULT & ERROR REPORT */}
          {step === 9 && importResult && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', textAlign: 'center', padding: '20px 0' }}>
              <div style={{
                width: '60px', height: '60px', borderRadius: '50%',
                background: '#dcfce7', color: '#16a34a', margin: '0 auto',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
                <CheckIcon size={32} />
              </div>
              <div>
                <h4 style={{ margin: '0 0 6px', fontSize: '1.25rem', fontWeight: 700 }}>
                  Import Completed!
                </h4>
                <p style={{ margin: 0, fontSize: '0.85rem', color: '#64748b' }}>
                  Student database records have been successfully synchronized.
                </p>
              </div>

              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: '12px',
                maxWidth: '600px',
                margin: '0 auto',
                width: '100%'
              }}>
                <div style={{ background: '#f0fdf4', padding: '14px', borderRadius: '10px', border: '1px solid #bbf7d0' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#15803d', textTransform: 'uppercase' }}>Imported</span>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#16a34a', marginTop: '2px' }}>{importResult.inserted}</div>
                </div>
                <div style={{ background: '#eff6ff', padding: '14px', borderRadius: '10px', border: '1px solid #bfdbfe' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase' }}>Updated</span>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#2563eb', marginTop: '2px' }}>{importResult.updated}</div>
                </div>
                <div style={{ background: '#f8fafc', padding: '14px', borderRadius: '10px', border: '1px solid #e2e8f0' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>Skipped</span>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#475569', marginTop: '2px' }}>{importResult.skipped}</div>
                </div>
                <div style={{ background: importResult.errors.length > 0 ? '#fef2f2' : '#f8fafc', padding: '14px', borderRadius: '10px', border: importResult.errors.length > 0 ? '1px solid #fecaca' : '1px solid #e2e8f0' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 700, color: importResult.errors.length > 0 ? '#991b1b' : '#64748b', textTransform: 'uppercase' }}>Failed</span>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: importResult.errors.length > 0 ? '#dc2626' : '#64748b', marginTop: '2px' }}>{importResult.errors.length}</div>
                </div>
              </div>

              {failedRows.length > 0 && (
                <div style={{ marginTop: '10px' }}>
                  <button
                    onClick={() => downloadErrorReport(failedRows)}
                    style={{
                      padding: '8px 18px',
                      borderRadius: '8px',
                      border: '1px solid #fca5a5',
                      background: '#fff1f2',
                      color: '#be123c',
                      fontWeight: 600,
                      fontSize: '0.85rem',
                      cursor: 'pointer'
                    }}
                  >
                    📥 Download Error Report (.xlsx)
                  </button>
                  <p style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '6px' }}>
                    Download the failed rows with annotations explaining the reason for each issue.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Navigation */}
        <div style={{
          padding: '16px 24px', borderTop: '1px solid #e2e8f0',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: '#f8fafc'
        }}>
          <div>
            {step > 1 && step < 8 && (
              <button
                onClick={() => setStep(prev => prev === 5 || prev === 4 ? 3 : prev - 1)}
                style={{
                  padding: '8px 16px', borderRadius: '6px', border: '1px solid #cbd5e1',
                  background: '#ffffff', color: '#475569', fontWeight: 600, fontSize: '0.85rem',
                  cursor: 'pointer'
                }}
              >
                ← Back
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            {step < 8 && (
              <button
                onClick={onClose}
                style={{
                  padding: '8px 16px', borderRadius: '6px', border: '1px solid #cbd5e1',
                  background: '#ffffff', color: '#475569', fontWeight: 600, fontSize: '0.85rem',
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            )}

            {step === 2 && (
              <button
                onClick={handleSelectSheetConfirm}
                disabled={!selectedSheet || isProcessing}
                style={{
                  padding: '8px 20px', borderRadius: '6px', border: 'none',
                  background: '#2563eb', color: '#ffffff', fontWeight: 600, fontSize: '0.85rem',
                  cursor: selectedSheet ? 'pointer' : 'not-allowed'
                }}
              >
                Next: Map Columns →
              </button>
            )}

            {step === 3 && (
              <button
                onClick={() => setStep(5)}
                disabled={!mappings.name || !mappings.admNo || !mappings.class}
                style={{
                  padding: '8px 20px', borderRadius: '6px', border: 'none',
                  background: (mappings.name && mappings.admNo && mappings.class) ? '#2563eb' : '#94a3b8',
                  color: '#ffffff', fontWeight: 600, fontSize: '0.85rem',
                  cursor: (mappings.name && mappings.admNo && mappings.class) ? 'pointer' : 'not-allowed'
                }}
              >
                Next: Validate & Preview →
              </button>
            )}

            {(step === 4 || step === 5 || step === 6) && (
              <button
                onClick={handleStartImport}
                disabled={validatedData.summary.validCount === 0}
                style={{
                  padding: '8px 22px', borderRadius: '6px', border: 'none',
                  background: validatedData.summary.validCount > 0 ? '#16a34a' : '#94a3b8',
                  color: '#ffffff', fontWeight: 600, fontSize: '0.85rem',
                  cursor: validatedData.summary.validCount > 0 ? 'pointer' : 'not-allowed'
                }}
              >
                Import {validatedData.summary.validCount} Valid Students →
              </button>
            )}

            {step === 9 && (
              <button
                onClick={onClose}
                style={{
                  padding: '8px 22px', borderRadius: '6px', border: 'none',
                  background: '#2563eb', color: '#ffffff', fontWeight: 600, fontSize: '0.85rem',
                  cursor: 'pointer'
                }}
              >
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
