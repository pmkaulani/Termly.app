import React, { useState, useRef, useEffect } from 'react';
import { useDialog } from '../contexts/DialogContext';
import { bulkImportTeachers, getTeachersBySchool } from '../data/staffStore';
import {
  readSpreadsheetFile,
  autoDetectColumnMappings,
  detectHeaderRow,
  validateTeacherImportRows,
  downloadTeacherImportTemplate,
  downloadErrorReport,
  TEACHER_FIELD_DEFINITIONS
} from '../utils/spreadsheetParser';
import {
  UploadIcon, CheckIcon, AlertIcon, DeleteIcon,
  XIcon, FileIcon, DownloadIcon, TeacherIcon
} from './CommonIcons';

export default function TeacherImporter({ profile = {}, onImport, onClose }) {
  const { alert, confirm } = useDialog();

  const [step, setStep] = useState(1);
  const [dragActive, setDragActive] = useState(false);
  const [file, setFile] = useState(null);
  const [sheetNames, setSheetNames] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState('');
  const [rawRows, setRawRows] = useState([]);
  const [headers, setHeaders] = useState([]);
  const [headerRowIndex, setHeaderRowIndex] = useState(0);
  const [mappings, setMappings] = useState({});
  const [validatedData, setValidatedData] = useState({ rows: [], summary: {} });
  const [duplicateAction, setDuplicateAction] = useState('skip'); // 'skip' or 'update'
  const [existingTeachers, setExistingTeachers] = useState([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [importResult, setImportResult] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const fileInputRef = useRef(null);
  const schoolId = profile?.school_id || profile?.schoolId;

  // Load existing teachers on mount
  useEffect(() => {
    if (schoolId) {
      getTeachersBySchool(schoolId)
        .then(teachers => setExistingTeachers(teachers || []))
        .catch(() => setExistingTeachers([]));
    }
  }, [schoolId]);

  // Step 1: File Selection & Parsing
  const handleFileChange = async (selectedFile) => {
    if (!selectedFile) return;

    const extension = selectedFile.name?.split('.').pop()?.toLowerCase();
    if (!['xlsx', 'xls', 'csv', 'tsv'].includes(extension)) {
      alert({ title: 'Unsupported File', message: 'Choose an Excel (.xlsx/.xls), CSV or TSV file.', variant: 'warning' });
      return;
    }

    if (selectedFile.size > 10 * 1024 * 1024) {
      alert({ title: 'File Too Large', message: 'Keep import file below 10 MB. Split larger files into batches.', variant: 'warning' });
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
      alert({ title: 'Empty Sheet', message: 'The sheet must have a header row and at least one teacher record row.', variant: 'warning' });
      return;
    }

    setRawRows(rows);
    const detectedHeaderIndex = detectHeaderRow(rows, 20, TEACHER_FIELD_DEFINITIONS);
    setHeaderRowIndex(detectedHeaderIndex);
    const headerRow = (rows[detectedHeaderIndex] || []).map(h => String(h || '').trim());
    setHeaders(headerRow);

    // Auto detect column mappings
    const detected = autoDetectColumnMappings(headerRow, TEACHER_FIELD_DEFINITIONS);
    setMappings(detected);

    // Run initial validation
    const validation = validateTeacherImportRows(rows, detectedHeaderIndex, detected, {
      existingTeachers
    });
    setValidatedData(validation);
    setStep(3); // Column Mapping & Preview Step
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

  const handleHeaderRowChange = (newHeaderIdx) => {
    const idx = Math.max(0, Math.min(Number(newHeaderIdx) || 0, rawRows.length - 1));
    setHeaderRowIndex(idx);
    const newHeaders = (rawRows[idx] || []).map(h => String(h || '').trim());
    setHeaders(newHeaders);
    const detected = autoDetectColumnMappings(newHeaders, TEACHER_FIELD_DEFINITIONS);
    setMappings(detected);
    const validation = validateTeacherImportRows(rawRows, idx, detected, { existingTeachers });
    setValidatedData(validation);
  };

  const handleMappingChange = (fieldKey, rawColIdx) => {
    const updated = { ...mappings };
    if (rawColIdx === '' || rawColIdx === null) {
      delete updated[fieldKey];
    } else {
      updated[fieldKey] = Number(rawColIdx);
    }
    setMappings(updated);

    const validation = validateTeacherImportRows(rawRows, headerRowIndex, updated, {
      existingTeachers
    });
    setValidatedData(validation);
  };

  const handleStartImport = async () => {
    const validRows = validatedData.rows.filter(r => r._isValid);
    if (validRows.length === 0) {
      alert({ title: 'No Valid Rows', message: 'There are no valid teacher records to import. Please resolve the errors first.', variant: 'warning' });
      return;
    }

    const uncorrectedErrors = validatedData.rows.length - validRows.length;
    if (uncorrectedErrors > 0) {
      const proceed = await confirm({
        title: 'Import with Skipped Rows?',
        message: `${uncorrectedErrors} rows have errors and will be skipped. Only ${validRows.length} valid teachers will be imported. Proceed?`,
        variant: 'warning'
      });
      if (!proceed) return;
    }

    setStep(5); // Importing progress
    setProgress({ current: 0, total: validRows.length });

    try {
      const result = await bulkImportTeachers(validRows, (current, total) => {
        setProgress({ current, total });
      }, { duplicateAction });

      setImportResult(result);
      setStep(6); // Results Report

      if (onImport) onImport(result);
    } catch (err) {
      alert({ title: 'Import Failed', message: err.message, variant: 'danger' });
      setStep(4);
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.75)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px'
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '920px',
          maxHeight: '90vh',
          background: 'var(--bg-card, #ffffff)',
          color: 'var(--text-main, #0f172a)',
          borderRadius: '16px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.4)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          padding: '18px 24px',
          borderBottom: '1px solid var(--border, #e2e8f0)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '40px', height: '40px', borderRadius: '10px',
              background: 'var(--primary-light, #e0f2fe)', color: 'var(--primary, #0284c7)',
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <TeacherIcon size={22} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700 }}>
                Bulk Teacher Importer
              </h3>
              <p style={{ margin: '2px 0 0', fontSize: '0.8rem', color: 'var(--text-muted, #64748b)' }}>
                {step === 1 && 'Upload faculty spreadsheet (.xlsx, .xls, .csv, .tsv)'}
                {step === 2 && 'Select Worksheet'}
                {step === 3 && 'Map Columns & Review Sample Rows'}
                {step === 4 && `Validate & Preview (${validatedData.summary.validCount || 0} valid / ${validatedData.summary.totalRows || 0} rows)`}
                {step === 5 && 'Importing teachers into directory...'}
                {step === 6 && 'Import Complete!'}
              </p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted, #94a3b8)' }}>
            <XIcon size={20} />
          </button>
        </div>

        {/* Content Body */}
        <div style={{ padding: '24px', flex: 1, overflowY: 'auto' }}>
          {/* STEP 1: Upload */}
          {step === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  border: `2px dashed ${dragActive ? 'var(--primary, #0284c7)' : 'var(--border, #cbd5e1)'}`,
                  borderRadius: '12px',
                  padding: '48px 24px',
                  textAlign: 'center',
                  background: dragActive ? 'var(--primary-light, #f0f9ff)' : 'var(--bg, #f8fafc)',
                  cursor: 'pointer',
                  transition: 'all 0.2s'
                }}
              >
                <div style={{
                  width: '56px', height: '56px', borderRadius: '50%',
                  background: 'var(--primary-light, #e0f2fe)', color: 'var(--primary, #0284c7)',
                  margin: '0 auto 16px', display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>
                  <UploadIcon size={28} />
                </div>
                <h4 style={{ margin: '0 0 6px', fontSize: '1rem', fontWeight: 600 }}>
                  Drag and drop your teacher register spreadsheet here
                </h4>
                <p style={{ margin: '0 0 16px', fontSize: '0.85rem', color: 'var(--text-muted, #64748b)' }}>
                  Supports Microsoft Excel (.xlsx, .xls) and CSV/TSV files up to 10 MB
                </p>
                <button type="button" className="btn btn-primary" onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}>
                  Browse File
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  hidden
                  accept=".xlsx,.xls,.csv,.tsv"
                  onChange={(e) => handleFileChange(e.target.files?.[0])}
                />
              </div>

              {/* Sample Templates & Notice */}
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'var(--bg, #f8fafc)',
                padding: '14px 18px',
                borderRadius: '10px',
                border: '1px solid var(--border, #e2e8f0)',
                flexWrap: 'wrap',
                gap: '12px'
              }}>
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>Need the standard teacher template?</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted, #64748b)' }}>
                    Download the pre-formatted template with example faculty rows.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => downloadTeacherImportTemplate('xlsx')}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  >
                    <DownloadIcon size={14} /> Excel Template (.xlsx)
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => downloadTeacherImportTemplate('csv')}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                  >
                    <DownloadIcon size={14} /> CSV Template (.csv)
                  </button>
                </div>
              </div>

              <div style={{
                padding: '12px 16px',
                borderRadius: '8px',
                background: '#fef3c7',
                color: '#92400e',
                fontSize: '0.8rem',
                lineHeight: 1.5
              }}>
                <strong>Security Notice:</strong> Teacher profile imports register faculty directory records ONLY.
                They never create login credentials, default PINs, or user login accounts.
              </div>
            </div>
          )}

          {/* STEP 2: Worksheet Selection */}
          {step === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <p style={{ margin: 0, fontSize: '0.9rem' }}>
                Your Excel workbook contains multiple worksheets. Please choose the sheet containing your teacher register:
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {sheetNames.map(name => (
                  <label
                    key={name}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '12px',
                      padding: '12px 16px', borderRadius: '8px',
                      border: `1px solid ${selectedSheet === name ? 'var(--primary, #0284c7)' : 'var(--border, #cbd5e1)'}`,
                      background: selectedSheet === name ? 'var(--primary-light, #f0f9ff)' : 'transparent',
                      cursor: 'pointer'
                    }}
                  >
                    <input
                      type="radio"
                      name="selectedSheet"
                      checked={selectedSheet === name}
                      onChange={() => setSelectedSheet(name)}
                    />
                    <span style={{ fontWeight: 600 }}>{name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* STEP 3 & 4: Column Mapping & Header Row Selector */}
          {(step === 3 || step === 4) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Header row override bar */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 14px',
                background: 'var(--bg, #f8fafc)',
                borderRadius: '8px',
                border: '1px solid var(--border, #e2e8f0)',
                flexWrap: 'wrap',
                gap: '10px'
              }}>
                <div style={{ fontSize: '0.85rem' }}>
                  <strong>Header Row Index:</strong> Row {headerRowIndex + 1}
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted, #64748b)', marginLeft: '8px' }}>
                    (Skipped {headerRowIndex} title/metadata row{headerRowIndex === 1 ? '' : 's'})
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-muted, #64748b)' }}>Change Header Row:</label>
                  <select
                    className="form-input"
                    value={headerRowIndex}
                    onChange={(e) => handleHeaderRowChange(Number(e.target.value))}
                    style={{ padding: '4px 8px', fontSize: '0.8rem', width: 'auto' }}
                  >
                    {rawRows.slice(0, Math.min(15, rawRows.length)).map((_, idx) => (
                      <option key={idx} value={idx}>Row {idx + 1}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Column Mapping Table */}
              <div>
                <h4 style={{ margin: '0 0 10px', fontSize: '0.95rem', fontWeight: 600 }}>
                  Match Spreadsheet Columns to Teacher Fields
                </h4>
                <div style={{
                  border: '1px solid var(--border, #e2e8f0)',
                  borderRadius: '8px',
                  overflow: 'hidden'
                }}>
                  <table className="data-table" style={{ margin: 0, width: '100%' }}>
                    <thead>
                      <tr>
                        <th style={{ width: '35%' }}>Termly Field</th>
                        <th style={{ width: '40%' }}>Spreadsheet Column</th>
                        <th style={{ width: '25%' }}>Sample Values</th>
                      </tr>
                    </thead>
                    <tbody>
                      {TEACHER_FIELD_DEFINITIONS.map(field => {
                        const currentMappedIdx = mappings[field.key];
                        const sampleVals = (rawRows.slice(headerRowIndex + 1, headerRowIndex + 4) || [])
                          .map(r => r[currentMappedIdx])
                          .filter(Boolean)
                          .join(', ');

                        return (
                          <tr key={field.key}>
                            <td>
                              <strong>{field.label}</strong>
                              {field.required && <span style={{ color: '#ef4444', marginLeft: 4 }}>*</span>}
                            </td>
                            <td>
                              <select
                                className="form-input"
                                value={currentMappedIdx !== undefined ? currentMappedIdx : ''}
                                onChange={(e) => handleMappingChange(field.key, e.target.value)}
                                style={{
                                  padding: '6px 10px',
                                  fontSize: '0.85rem',
                                  borderColor: field.required && currentMappedIdx === undefined ? '#ef4444' : undefined
                                }}
                              >
                                <option value="">-- Ignore this column --</option>
                                {headers.map((h, hIdx) => (
                                  <option key={hIdx} value={hIdx}>
                                    Column {hIdx + 1}: {h || `(Column ${hIdx + 1})`}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td style={{ fontSize: '0.8rem', color: 'var(--text-muted, #64748b)' }}>
                              {sampleVals || '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Duplicate Handling Options */}
              <div style={{
                padding: '14px',
                borderRadius: '8px',
                background: 'var(--bg, #f8fafc)',
                border: '1px solid var(--border, #e2e8f0)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: '12px'
              }}>
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>Duplicate Teacher Record Policy</div>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted, #64748b)' }}>
                    Matched by staff code or registered phone number.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '16px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="teacherDupAction"
                      value="skip"
                      checked={duplicateAction === 'skip'}
                      onChange={() => setDuplicateAction('skip')}
                    />
                    Skip duplicates (Keep existing)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="teacherDupAction"
                      value="update"
                      checked={duplicateAction === 'update'}
                      onChange={() => setDuplicateAction('update')}
                    />
                    Update existing with mapped fields
                  </label>
                </div>
              </div>

              {/* Validation Summary Bar */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                gap: '12px'
              }}>
                <div style={{ padding: '10px', background: '#dcfce7', color: '#15803d', borderRadius: '8px', textAlign: 'center' }}>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{validatedData.summary.validCount || 0}</div>
                  <div style={{ fontSize: '0.75rem' }}>Valid Rows</div>
                </div>
                <div style={{ padding: '10px', background: '#fee2e2', color: '#b91c1c', borderRadius: '8px', textAlign: 'center' }}>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>
                    {(validatedData.summary.totalRows || 0) - (validatedData.summary.validCount || 0)}
                  </div>
                  <div style={{ fontSize: '0.75rem' }}>Rows with Errors</div>
                </div>
                <div style={{ padding: '10px', background: '#fef3c7', color: '#92400e', borderRadius: '8px', textAlign: 'center' }}>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{validatedData.summary.dbDuplicateCount || 0}</div>
                  <div style={{ fontSize: '0.75rem' }}>Existing Duplicates</div>
                </div>
                <div style={{ padding: '10px', background: 'var(--bg, #f1f5f9)', color: 'var(--text-main, #0f172a)', borderRadius: '8px', textAlign: 'center' }}>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{validatedData.summary.totalRows || 0}</div>
                  <div style={{ fontSize: '0.75rem' }}>Total Rows</div>
                </div>
              </div>
            </div>
          )}

          {/* STEP 5: Importing Progress */}
          {step === 5 && (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <h4 style={{ margin: '0 0 16px', fontSize: '1.15rem', fontWeight: 600 }}>
                Importing Teacher Directory Records...
              </h4>
              <div style={{
                width: '100%', height: '10px', borderRadius: '6px',
                background: 'var(--border, #e2e8f0)', overflow: 'hidden', margin: '0 auto 12px'
              }}>
                <div style={{
                  width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
                  height: '100%',
                  background: 'var(--primary, #0284c7)',
                  transition: 'width 0.3s ease'
                }} />
              </div>
              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-muted, #64748b)' }}>
                {progress.current} of {progress.total} processed
              </span>
            </div>
          )}

          {/* STEP 6: Results Report */}
          {step === 6 && importResult && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', textAlign: 'center', padding: '16px 0' }}>
              <div style={{
                width: '56px', height: '56px', borderRadius: '50%',
                background: '#dcfce7', color: '#16a34a', margin: '0 auto',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}>
                <CheckIcon size={32} />
              </div>

              <div>
                <h4 style={{ margin: '0 0 6px', fontSize: '1.25rem', fontWeight: 700 }}>
                  Teacher Import Finished
                </h4>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-muted, #64748b)' }}>
                  Processed {importResult.count} teacher records in your directory.
                </p>
              </div>

              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                gap: '12px'
              }}>
                <div style={{ padding: '12px', background: '#dcfce7', borderRadius: '8px' }}>
                  <div style={{ fontSize: '1.3rem', fontWeight: 700, color: '#15803d' }}>{importResult.inserted}</div>
                  <div style={{ fontSize: '0.8rem', color: '#15803d' }}>Added New</div>
                </div>
                <div style={{ padding: '12px', background: '#dbeafe', borderRadius: '8px' }}>
                  <div style={{ fontSize: '1.3rem', fontWeight: 700, color: '#1d4ed8' }}>{importResult.updated}</div>
                  <div style={{ fontSize: '0.8rem', color: '#1d4ed8' }}>Updated Existing</div>
                </div>
                <div style={{ padding: '12px', background: '#fef3c7', borderRadius: '8px' }}>
                  <div style={{ fontSize: '1.3rem', fontWeight: 700, color: '#92400e' }}>{importResult.skipped}</div>
                  <div style={{ fontSize: '0.8rem', color: '#92400e' }}>Skipped (Duplicates)</div>
                </div>
                <div style={{ padding: '12px', background: '#fee2e2', borderRadius: '8px' }}>
                  <div style={{ fontSize: '1.3rem', fontWeight: 700, color: '#b91c1c' }}>{importResult.errors?.length || 0}</div>
                  <div style={{ fontSize: '0.8rem', color: '#b91c1c' }}>Failed Rows</div>
                </div>
              </div>

              {importResult.errors && importResult.errors.length > 0 && (
                <div style={{ textAlign: 'left', marginTop: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#b91c1c' }}>
                      Errors Encountered ({importResult.errors.length})
                    </span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => downloadErrorReport(importResult.errors, 'Teacher_Import_Errors')}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem' }}
                    >
                      <DownloadIcon size={14} /> Download Error Log (.xlsx)
                    </button>
                  </div>
                  <div style={{
                    maxHeight: '160px', overflowY: 'auto',
                    border: '1px solid #fecaca', borderRadius: '8px', background: '#fff5f5', padding: '10px'
                  }}>
                    {importResult.errors.map((err, errIdx) => (
                      <div key={errIdx} style={{ fontSize: '0.8rem', color: '#7f1d1d', padding: '4px 0', borderBottom: '1px solid #fee2e2' }}>
                        <strong>Row {err.row}:</strong> {err.name} — {err.reason}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Navigation */}
        <div style={{
          padding: '16px 24px',
          borderTop: '1px solid var(--border, #e2e8f0)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <div>
            {step > 1 && step < 5 && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setStep(step === 3 && sheetNames.length <= 1 ? 1 : step - 1)}
              >
                ← Back
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            {step < 5 && (
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
            )}

            {step === 2 && (
              <button type="button" className="btn btn-primary" onClick={handleSelectSheetConfirm}>
                Continue with "{selectedSheet}" →
              </button>
            )}

            {(step === 3 || step === 4) && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleStartImport}
                disabled={validatedData.summary.validCount === 0}
              >
                Import {validatedData.summary.validCount || 0} Valid Teachers →
              </button>
            )}

            {step === 6 && (
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
