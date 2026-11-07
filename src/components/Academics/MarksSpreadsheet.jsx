import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  parseMarkValue,
  calculateStudentSummary,
  assignCompetitionRanks,
  calculatePerformanceStatistics,
  SPECIAL_CODES
} from '../../utils/assessmentCalculations';
import PastePreviewModal from './PastePreviewModal';
import SubjectStatisticsBar from './SubjectStatisticsBar';
import Select from '../Common/Select';
import {
  CheckIcon,
  AlertIcon,
  RefreshIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SearchIcon,
  ShieldIcon,
  SettingsIcon
} from '../../components/CommonIcons';

/**
 * High-Performance Excel-like Marks Spreadsheet Component
 */
export default function MarksSpreadsheet({
  students = [],
  subjects = [],
  subjectConfigs = {}, // { [sub]: { maxMark: 100, weight: 1.0 } }
  initialMarks = {},   // { [studentId]: { [sub]: mark } }
  assignments = {},    // teacher assignments
  currentUser = null,
  profile = null,
  selectedClass = '',
  examStatus = 'open', // draft, open, submitted, reviewed, finalized, published
  onSaveMarks,
  savingStatus = 'idle', // idle, saving, saved, error, offline
  onManageSubjects = null // Callback to open subject picker for a student
}) {
  const [marksState, setMarksState] = useState(initialMarks);
  const [activeCell, setActiveCell] = useState(null); // { rowIdx, colIdx, studentId, subject }
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterMissing, setFilterMissing] = useState(false);
  const [filterAbsent, setFilterAbsent] = useState(false);
  const [filterGrade, setFilterGrade] = useState('ALL');
  const [filterPassFail, setFilterPassFail] = useState('ALL'); // ALL, PASS, FAIL
  const [mobileMode, setMobileMode] = useState(false);
  const [mobileStudentIdx, setMobileStudentIdx] = useState(0);
  const [pasteModalData, setPasteModalData] = useState(null);
  const [selectedSubjectStat, setSelectedSubjectStat] = useState(null);
  const [focusSubject, setFocusSubject] = useState(false);
  const [hasPendingEdits, setHasPendingEdits] = useState(false);
  const [validationErrors, setValidationErrors] = useState({}); // { `${sId}_${sub}`: errorMsg }

  const autosaveTimerRef = useRef(null);
  const searchInputRef = useRef(null);
  const gridContainerRef = useRef(null);

  const isFinalized = examStatus === 'finalized' || examStatus === 'published';
  const isAdmin = currentUser?.role?.toLowerCase() === 'admin' || currentUser?.role?.toLowerCase() === 'superadmin';

  // Keep internal state synced when initialMarks updates externally
  useEffect(() => {
    setMarksState(initialMarks);
    setHasPendingEdits(false);
  }, [initialMarks]);

  // If selected subject is cleared, disable focus mode
  useEffect(() => {
    if (!selectedSubjectStat) {
      setFocusSubject(false);
    }
  }, [selectedSubjectStat]);

  // Displayed subjects: either all subjects, or only the focused subject
  const displayedSubjects = useMemo(() => {
    if (focusSubject && selectedSubjectStat && subjects.includes(selectedSubjectStat)) {
      return [selectedSubjectStat];
    }
    return subjects;
  }, [subjects, focusSubject, selectedSubjectStat]);

  // Responsive mobile mode detection
  useEffect(() => {
    const checkMobile = () => {
      if (window.innerWidth < 768) {
        setMobileMode(true);
      }
    };
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // Warn on navigation if unsaved changes exist
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (hasPendingEdits) {
        e.preventDefault();
        e.returnValue = 'You have unsaved marks! Are you sure you want to leave?';
        return e.returnValue;
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasPendingEdits]);

  // Calculate student results and ranks with standard competition ties (1, 2, 2, 4)
  const rankedResults = useMemo(() => {
    const calculated = students.map(student => {
      const sMarks = marksState[student.id] || {};
      return calculateStudentSummary(student, sMarks, subjects, subjectConfigs, profile);
    });
    return assignCompetitionRanks(calculated, 'total', 'average');
  }, [students, marksState, subjects, subjectConfigs, profile]);

  // Performance statistics across class and subjects
  const statistics = useMemo(() => {
    return calculatePerformanceStatistics(rankedResults, subjects, subjectConfigs, {
      className: selectedClass,
      profile
    });
  }, [rankedResults, subjects, subjectConfigs, selectedClass, profile]);

  // Filtered rows for display
  const displayedStudents = useMemo(() => {
    return rankedResults.filter(student => {
      if (searchTerm) {
        const s = searchTerm.toLowerCase();
        const matchesName = (student.name || '').toLowerCase().includes(s);
        const matchesAdm = (student.admNo || student.adm_no || '').toLowerCase().includes(s);
        if (!matchesName && !matchesAdm) return false;
      }
      if (filterMissing && student.countMissing === 0) return false;
      if (filterAbsent && student.countAbsent === 0) return false;
      if (filterGrade !== 'ALL' && student.grade !== filterGrade) return false;
      if (filterPassFail === 'PASS' && !student.isPass) return false;
      if (filterPassFail === 'FAIL' && student.isPass) return false;
      return true;
    });
  }, [rankedResults, searchTerm, filterMissing, filterAbsent, filterGrade, filterPassFail]);

  // Debounced Autosave Trigger
  const triggerAutosave = useCallback((newMarks) => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    setHasPendingEdits(true);

    autosaveTimerRef.current = setTimeout(() => {
      if (onSaveMarks) {
        onSaveMarks(newMarks);
        setHasPendingEdits(false);
      }
    }, 1500);
  }, [onSaveMarks]);

  // Handle a single mark value change with validation
  const handleMarkChange = useCallback((studentId, subject, rawValue) => {
    const config = subjectConfigs[subject] || { maxMark: 100 };
    const maxMark = Number(config.maxMark) > 0 ? Number(config.maxMark) : 100;
    const parsed = parseMarkValue(rawValue, maxMark);

    const cellKey = `${studentId}_${subject}`;
    setValidationErrors(prev => {
      const updated = { ...prev };
      if (parsed.error) {
        updated[cellKey] = parsed.error;
      } else {
        delete updated[cellKey];
      }
      return updated;
    });

    setMarksState(prev => {
      const currentStudentMarks = prev[studentId] || {};
      const oldVal = currentStudentMarks[subject];

      // Store in undo stack
      setUndoStack(uPrev => [...uPrev.slice(-30), { studentId, subject, oldVal, newVal: parsed.value }]);
      setRedoStack([]);

      const updated = {
        ...prev,
        [studentId]: {
          ...currentStudentMarks,
          [subject]: parsed.value // number, 'ABS', 'MISSING', 'EXEMPT', or null
        }
      };

      triggerAutosave(updated);
      return updated;
    });
  }, [subjectConfigs, triggerAutosave]);

  // Undo last action (Ctrl+Z)
  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const lastAction = undoStack[undoStack.length - 1];
    setUndoStack(prev => prev.slice(0, -1));

    if (lastAction.isBulk) {
      // Bulk undo
      setMarksState(lastAction.previousMarks);
      setRedoStack(rPrev => [...rPrev, { isBulk: true, previousMarks: marksState, newMarks: lastAction.previousMarks }]);
      triggerAutosave(lastAction.previousMarks);
    } else {
      // Single cell undo
      const { studentId, subject, oldVal } = lastAction;
      setMarksState(prev => {
        const updated = {
          ...prev,
          [studentId]: {
            ...(prev[studentId] || {}),
            [subject]: oldVal
          }
        };
        setRedoStack(rPrev => [...rPrev, lastAction]);
        triggerAutosave(updated);
        return updated;
      });
    }
  }, [undoStack, marksState, triggerAutosave]);

  // Focus a specific grid cell
  const focusCell = useCallback((rowIdx, colIdx) => {
    if (rowIdx < 0 || rowIdx >= displayedStudents.length) return;
    if (colIdx < 0 || colIdx >= displayedSubjects.length) return;

    const student = displayedStudents[rowIdx];
    const subject = displayedSubjects[colIdx];
    setActiveCell({ rowIdx, colIdx, studentId: student.id, subject });

    const inputId = `grid-mark-r${rowIdx}-c${colIdx}`;
    const el = document.getElementById(inputId);
    if (el) {
      el.focus();
      el.select();
    }
  }, [displayedStudents, displayedSubjects]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e, rowIdx, colIdx) => {
    // Ctrl+Z = Undo
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      handleUndo();
      return;
    }

    // Ctrl+F = Find/Search
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchInputRef.current?.focus();
      return;
    }

    // Ctrl+C = Copy cell value
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      const student = displayedStudents[rowIdx];
      const subject = displayedSubjects[colIdx];
      const val = marksState[student?.id]?.[subject];
      if (val !== undefined && val !== null) {
        navigator.clipboard.writeText(String(val));
      }
      return;
    }

    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        focusCell(rowIdx + 1, colIdx);
        break;
      case 'Tab':
        e.preventDefault();
        if (e.shiftKey) {
          focusCell(rowIdx, colIdx - 1);
        } else {
          focusCell(rowIdx, colIdx + 1);
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusCell(rowIdx - 1, colIdx);
        break;
      case 'ArrowDown':
        e.preventDefault();
        focusCell(rowIdx + 1, colIdx);
        break;
      case 'ArrowLeft':
        if (e.target.selectionStart === 0 && e.target.selectionEnd === 0) {
          e.preventDefault();
          focusCell(rowIdx, colIdx - 1);
        }
        break;
      case 'ArrowRight':
        if (e.target.selectionStart === e.target.value.length) {
          e.preventDefault();
          focusCell(rowIdx, colIdx + 1);
        }
        break;
      default:
        break;
    }
  }, [displayedStudents, displayedSubjects, marksState, handleUndo, focusCell]);

  // Multi-cell paste from Excel/Sheets
  const handlePaste = useCallback((e, startRowIdx, startColIdx) => {
    const text = e.clipboardData?.getData('text');
    if (!text) return;

    // Single value without tab or newline pastes normally
    if (!text.includes('\t') && !text.includes('\n')) return;

    e.preventDefault();
    const rawRows = text.replace(/\r/g, '').split('\n').filter(r => r.length > 0);
    const parsedGrid = [];
    let validCount = 0;
    let invalidCount = 0;

    const startStudent = displayedStudents[startRowIdx]?.name || `Row ${startRowIdx + 1}`;
    const startSubject = displayedSubjects[startColIdx] || `Col ${startColIdx + 1}`;

    rawRows.forEach((rowText, rOffset) => {
      const targetStudent = displayedStudents[startRowIdx + rOffset];
      if (!targetStudent) return;

      const cells = rowText.split('\t');
      const rowCells = [];

      cells.forEach((cellText, cOffset) => {
        const targetSub = displayedSubjects[startColIdx + cOffset];
        if (!targetSub) return;

        const config = subjectConfigs[targetSub] || { maxMark: 100 };
        const maxMark = Number(config.maxMark) > 0 ? Number(config.maxMark) : 100;
        const val = cellText.trim();
        const parsed = parseMarkValue(val, maxMark);

        if (parsed.type === 'invalid') {
          invalidCount++;
        } else {
          validCount++;
        }

        rowCells.push({
          studentId: targetStudent.id,
          subject: targetSub,
          displayValue: val,
          parsedValue: parsed.value,
          isSpecial: ['abs', 'missing', 'exempt'].includes(parsed.type),
          error: parsed.error
        });
      });

      parsedGrid.push({
        studentName: targetStudent.name,
        studentId: targetStudent.id,
        cells: rowCells
      });
    });

    if (parsedGrid.length === 0) return;

    // Trigger preview modal for user review
    setPasteModalData({
      rows: parsedGrid.length,
      cols: parsedGrid[0]?.cells.length || 0,
      parsedGrid,
      validCount,
      invalidCount,
      startStudent,
      startSubject
    });
  }, [displayedStudents, displayedSubjects, subjectConfigs]);

  // Commit verified paste from modal
  const commitPaste = useCallback(() => {
    if (!pasteModalData) return;

    const newMarks = JSON.parse(JSON.stringify(marksState));
    pasteModalData.parsedGrid.forEach(row => {
      if (!newMarks[row.studentId]) newMarks[row.studentId] = {};
      row.cells.forEach(cell => {
        if (!cell.error) {
          newMarks[row.studentId][cell.subject] = cell.parsedValue;
        }
      });
    });

    // Record bulk undo state
    setUndoStack(prev => [...prev, { isBulk: true, previousMarks: marksState, newMarks }]);
    setMarksState(newMarks);
    triggerAutosave(newMarks);
    setPasteModalData(null);
  }, [pasteModalData, marksState, triggerAutosave]);

  // Check if a cell can be edited by current user
  const canEditCell = useCallback((student, subject) => {
    if (isFinalized && !isAdmin) return false;
    if (isAdmin) return true;

    // Check teacher assignments
    const stream = student.stream || 'General';
    const streamAssignment = assignments[selectedClass]?.[stream]?.[subject];
    const generalAssignment = assignments[selectedClass]?.['General']?.[subject];

    return streamAssignment === currentUser?.id || generalAssignment === currentUser?.id;
  }, [isFinalized, isAdmin, assignments, selectedClass, currentUser]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '100%' }}>
      {/* EXCEL-LIKE CONTEXT BAR & ACTIVE CELL NAME BOX */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '8px',
        padding: '8px 14px',
        background: '#f8fafc',
        borderRadius: '8px',
        border: '1px solid #e2e8f0',
        fontSize: '0.8rem',
        marginBottom: '2px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{
            fontSize: '0.75rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            color: '#64748b'
          }}>Name Box:</span>
          <span style={{
            fontFamily: 'monospace',
            fontWeight: 800,
            background: '#ffffff',
            border: '1px solid #cbd5e1',
            padding: '2px 8px',
            borderRadius: '4px',
            color: '#1e293b'
          }}>
            {activeCell ? `${String.fromCharCode(65 + Math.min((activeCell.colIdx || 0) + 3, 25))}${(activeCell.rowIdx || 0) + 1}` : 'A1'}
          </span>
          <span style={{ color: '#64748b', fontSize: '0.78rem' }}>
            {activeCell && activeCell.subject ? `${activeCell.subject} — ${displayedStudents[activeCell.rowIdx]?.name || ''}` : 'Select a cell to edit mark'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', color: '#475569', fontWeight: 600, fontSize: '0.78rem' }}>
          <span>🏛 {profile?.schoolName || 'Termly Academy'}</span>
          <span>📅 {profile?.academicYear || '2026'}</span>
          <span>📌 {selectedClass || 'All Classes'}</span>
          <span style={{
            padding: '2px 8px',
            borderRadius: '4px',
            fontSize: '0.72rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            background: isFinalized ? '#fef2f2' : '#f0fdf4',
            color: isFinalized ? '#b91c1c' : '#15803d',
            border: isFinalized ? '1px solid #fecaca' : '1px solid #bbf7d0'
          }}>
            {examStatus?.toUpperCase() || 'OPEN'}
          </span>
        </div>
      </div>

      {/* Spreadsheet Controls Row — no extra card, flows beneath the main toolbar */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        paddingTop: '2px'
      }}>
        {/* Search and Filters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ position: 'relative' }}>
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search student or Adm No... (Ctrl+F)"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                fontSize: '0.82rem',
                width: '220px'
              }}
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                style={{
                  position: 'absolute',
                  right: '8px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: '#94a3b8',
                  cursor: 'pointer'
                }}
              >
                ×
              </button>
            )}
          </div>

          <button
            onClick={() => setFilterMissing(!filterMissing)}
            style={{
              padding: '6px 10px',
              borderRadius: '6px',
              border: filterMissing ? '1.5px solid #ef4444' : '1px solid #cbd5e1',
              background: filterMissing ? '#fee2e2' : '#ffffff',
              color: filterMissing ? '#991b1b' : '#475569',
              fontSize: '0.78rem',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            Missing Marks
          </button>

          <button
            onClick={() => setFilterAbsent(!filterAbsent)}
            style={{
              padding: '6px 10px',
              borderRadius: '6px',
              border: filterAbsent ? '1.5px solid #f59e0b' : '1px solid #cbd5e1',
              background: filterAbsent ? '#fef3c7' : '#ffffff',
              color: filterAbsent ? '#92400e' : '#475569',
              fontSize: '0.78rem',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            Absent (ABS)
          </button>

          <Select
            value={filterGrade}
            onChange={e => setFilterGrade(e.target.value)}
            options={[
              { id: 'ALL', label: 'All Grades' },
              { id: 'A', label: 'Grade A' },
              { id: 'B', label: 'Grade B' },
              { id: 'C', label: 'Grade C' },
              { id: 'D', label: 'Grade D' },
              { id: 'E', label: 'Grade E' }
            ]}
            size="sm"
            style={{ minWidth: 125 }}
          />
        </div>

        {/* Action Status and Indicators */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Undo Button */}
          <button
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            title="Undo last change (Ctrl+Z)"
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              background: undoStack.length > 0 ? '#ffffff' : '#f1f5f9',
              color: undoStack.length > 0 ? '#1e293b' : '#94a3b8',
              fontSize: '0.78rem',
              fontWeight: 600,
              cursor: undoStack.length > 0 ? 'pointer' : 'default',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            <RefreshIcon size={12} /> Undo
          </button>

          {/* Autosave Status Indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem' }}>
            {savingStatus === 'saving' || hasPendingEdits ? (
              <span style={{ color: '#2563eb', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span className="animate-spin" style={{ display: 'inline-flex' }}><RefreshIcon size={12} /></span> Saving...
              </span>
            ) : savingStatus === 'offline' ? (
              <span style={{ color: '#d97706', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                <ShieldIcon size={12} /> Offline (Local)
              </span>
            ) : savingStatus === 'error' ? (
              <span style={{ color: '#dc2626', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                <AlertIcon size={12} /> Save Error — Retrying
              </span>
            ) : (
              <span style={{ color: '#16a34a', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                <CheckIcon size={12} /> Saved
              </span>
            )}
          </div>

          {/* Mobile Mode Switcher */}
          <button
            onClick={() => setMobileMode(!mobileMode)}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              background: mobileMode ? '#e0e7ff' : '#ffffff',
              color: mobileMode ? '#4338ca' : '#475569',
              fontSize: '0.78rem',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            {mobileMode ? 'Spreadsheet Mode' : 'Mobile Card Mode'}
          </button>
        </div>
      </div>

      {/* Compact Subject Statistics Ribbon */}
      <SubjectStatisticsBar
        stats={statistics.subjectStats}
        subjects={subjects}
        selectedSubject={selectedSubjectStat}
        onSelectSubject={(sub) => {
          setSelectedSubjectStat(sub);
          if (!sub) setFocusSubject(false);
        }}
        focusSubject={focusSubject}
        onToggleFocusSubject={() => setFocusSubject(prev => !prev)}
      />

      {/* MOBILE STUDENT CARD MODE */}
      {mobileMode ? (
        <div style={{
          background: '#ffffff',
          borderRadius: '12px',
          border: '1px solid #e2e8f0',
          padding: '16px',
          boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)'
        }}>
          {displayedStudents.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
              No students found for this filter.
            </div>
          ) : (
            (() => {
              const currentStudent = displayedStudents[mobileStudentIdx] || displayedStudents[0];
              const sMarks = marksState[currentStudent.id] || {};

              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {/* Student Header */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    background: '#f8fafc',
                    padding: '12px',
                    borderRadius: '8px',
                    border: '1px solid #e2e8f0'
                  }}>
                    <div>
                      <span style={{
                        display: 'inline-block',
                        background: '#2563eb',
                        color: '#fff',
                        fontSize: '0.72rem',
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: '4px',
                        marginBottom: '4px'
                      }}>
                        Rank #{currentStudent.rank}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <h4 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700 }}>
                          {currentStudent.name}
                        </h4>
                        {onManageSubjects && (
                          <button
                            type="button"
                            onClick={() => onManageSubjects(currentStudent)}
                            style={{
                              padding: '3px 6px',
                              border: '1px solid #cbd5e1',
                              borderRadius: '4px',
                              background: '#ffffff',
                              color: '#475569',
                              cursor: 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              fontSize: '0.72rem',
                              fontWeight: 600
                            }}
                            title="Manage Student Subjects"
                          >
                            <SettingsIcon size={13} /> Subjects
                          </button>
                        )}
                      </div>
                      <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
                        ADM: {currentStudent.admNo || currentStudent.adm_no} | Stream: {currentStudent.stream || 'General'}
                      </span>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: '1.2rem', fontWeight: 800, color: currentStudent.gradeColor || '#1e293b' }}>
                        {currentStudent.grade}
                      </span>
                      <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                        Avg: {currentStudent.average}%
                      </div>
                    </div>
                  </div>

                  {/* Subject List Inputs */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {displayedSubjects.map(sub => {
                      const isEnrolled = !currentStudent.subjects || currentStudent.subjects.length === 0 || currentStudent.subjects.includes(sub);
                      const config = subjectConfigs[sub] || { maxMark: 100 };
                      const maxMark = config.maxMark || 100;
                      const editable = isEnrolled && canEditCell(currentStudent, sub);
                      const currentVal = !isEnrolled ? '—' : (sMarks[sub] !== undefined && sMarks[sub] !== null ? sMarks[sub] : '');

                      return (
                        <div key={sub} style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 12px',
                          border: selectedSubjectStat === sub ? '2px solid #2563eb' : '1px solid #e2e8f0',
                          borderRadius: '6px',
                          background: !isEnrolled ? '#f8fafc' : (editable ? '#ffffff' : '#f8fafc')
                        }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <strong style={{ fontSize: '0.85rem' }}>{sub}</strong>
                              {!isEnrolled && (
                                <span style={{ fontSize: '0.68rem', color: '#64748b', background: '#e2e8f0', padding: '1px 5px', borderRadius: '3px' }}>
                                  Not Enrolled
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: '0.72rem', color: '#64748b' }}>Max: {maxMark}</div>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <input
                              type="text"
                              disabled={!editable}
                              value={currentVal}
                              placeholder="—"
                              onChange={e => isEnrolled && handleMarkChange(currentStudent.id, sub, e.target.value)}
                              style={{
                                width: '70px',
                                padding: '6px',
                                textAlign: 'center',
                                borderRadius: '4px',
                                border: '1px solid #cbd5e1',
                                fontWeight: 700,
                                fontSize: '0.9rem',
                                color: !isEnrolled ? '#94a3b8' : 'inherit',
                                background: !editable ? '#e2e8f0' : '#ffffff',
                                cursor: editable ? 'text' : 'not-allowed'
                              }}
                            />
                            {editable && (
                              <button
                                onClick={() => handleMarkChange(currentStudent.id, sub, 'ABS')}
                                style={{
                                  padding: '4px 6px',
                                  borderRadius: '4px',
                                  border: '1px solid #cbd5e1',
                                  background: '#f1f5f9',
                                  fontSize: '0.68rem',
                                  fontWeight: 600,
                                  cursor: 'pointer'
                                }}
                              >
                                ABS
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Navigation Buttons */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '10px' }}>
                    <button
                      onClick={() => setMobileStudentIdx(prev => Math.max(0, prev - 1))}
                      disabled={mobileStudentIdx === 0}
                      style={{
                        padding: '8px 16px',
                        borderRadius: '6px',
                        border: '1px solid #cbd5e1',
                        background: '#ffffff',
                        fontWeight: 600,
                        fontSize: '0.85rem',
                        cursor: mobileStudentIdx > 0 ? 'pointer' : 'default',
                        opacity: mobileStudentIdx === 0 ? 0.5 : 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px'
                      }}
                    >
                      <ChevronLeftIcon size={14} /> Previous Student
                    </button>
                    <span style={{ fontSize: '0.8rem', color: '#64748b', alignSelf: 'center' }}>
                      {mobileStudentIdx + 1} of {displayedStudents.length}
                    </span>
                    <button
                      onClick={() => setMobileStudentIdx(prev => Math.min(displayedStudents.length - 1, prev + 1))}
                      disabled={mobileStudentIdx >= displayedStudents.length - 1}
                      style={{
                        padding: '8px 16px',
                        borderRadius: '6px',
                        border: '1px solid #cbd5e1',
                        background: '#ffffff',
                        fontWeight: 600,
                        fontSize: '0.85rem',
                        cursor: mobileStudentIdx < displayedStudents.length - 1 ? 'pointer' : 'default',
                        opacity: mobileStudentIdx >= displayedStudents.length - 1 ? 0.5 : 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px'
                      }}
                    >
                      Next Student <ChevronRightIcon size={14} />
                    </button>
                  </div>
                </div>
              );
            })()
          )}
        </div>
      ) : (
        /* DESKTOP EXCEL-GRADE DENSE SPREADSHEET */
        <div
          ref={gridContainerRef}
          style={{
            background: '#ffffff',
            border: '1px solid #cbd5e1',
            borderRadius: '6px',
            overflow: 'auto',
            maxHeight: '75vh',
            minHeight: '260px',
            boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.05)',
            position: 'relative'
          }}
        >
          <table style={{
            minWidth: '100%',
            width: 'max-content',
            borderCollapse: 'separate',
            borderSpacing: 0,
            fontSize: '0.82rem',
            fontVariantNumeric: 'tabular-nums'
          }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {/* Freeze Column 1: Rank */}
                <th style={{
                  position: 'sticky',
                  left: 0,
                  top: 0,
                  zIndex: 40,
                  background: '#f8fafc',
                  padding: '8px 6px',
                  borderBottom: '2px solid #cbd5e1',
                  borderRight: '1px solid #cbd5e1',
                  width: '56px',
                  minWidth: '56px',
                  maxWidth: '56px',
                  boxSizing: 'border-box',
                  textAlign: 'center',
                  fontWeight: 700,
                  color: '#475569'
                }}>
                  Rank
                </th>

                {/* Freeze Column 2: Adm No */}
                <th style={{
                  position: 'sticky',
                  left: '56px',
                  top: 0,
                  zIndex: 40,
                  background: '#f8fafc',
                  padding: '8px 10px',
                  borderBottom: '2px solid #cbd5e1',
                  borderRight: '1px solid #cbd5e1',
                  width: '90px',
                  minWidth: '90px',
                  maxWidth: '90px',
                  boxSizing: 'border-box',
                  textAlign: 'left',
                  fontWeight: 700,
                  color: '#475569'
                }}>
                  Adm No
                </th>

                {/* Freeze Column 3: Student Name */}
                <th style={{
                  position: 'sticky',
                  left: '146px',
                  top: 0,
                  zIndex: 40,
                  background: '#f8fafc',
                  padding: '8px 12px',
                  borderBottom: '2px solid #cbd5e1',
                  borderRight: '2px solid #94a3b8', // visual scroll delimiter
                  width: '200px',
                  minWidth: '200px',
                  maxWidth: '200px',
                  boxSizing: 'border-box',
                  textAlign: 'left',
                  fontWeight: 700,
                  color: '#475569',
                  boxShadow: '4px 0 6px -2px rgba(0,0,0,0.05)'
                }}>
                  Student Name
                </th>

                {/* Subject Columns */}
                {displayedSubjects.map(sub => {
                  const config = subjectConfigs[sub] || { maxMark: 100 };
                  const maxMark = config.maxMark || 100;
                  const isSelectedSub = selectedSubjectStat === sub;

                  return (
                    <th key={sub} style={{
                      position: 'sticky',
                      top: 0,
                      zIndex: 30,
                      background: isSelectedSub ? '#eff6ff' : '#f8fafc',
                      padding: '6px 10px',
                      borderBottom: isSelectedSub ? '2px solid #2563eb' : '2px solid #cbd5e1',
                      borderRight: isSelectedSub ? '2px solid #2563eb' : '1px solid #e2e8f0',
                      borderLeft: isSelectedSub ? '2px solid #2563eb' : 'none',
                      textAlign: 'center',
                      fontWeight: 700,
                      width: '92px',
                      minWidth: '92px',
                      boxSizing: 'border-box',
                      color: isSelectedSub ? '#1d4ed8' : '#1e293b'
                    }}>
                      <div style={{ whiteSpace: 'nowrap' }}>{sub}</div>
                      <span style={{ fontSize: '0.68rem', fontWeight: 500, color: isSelectedSub ? '#2563eb' : '#64748b' }}>
                        /{maxMark}
                      </span>
                    </th>
                  );
                })}

                {/* Summary Columns */}
                <th style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 30,
                  background: '#f1f5f9',
                  padding: '8px 10px',
                  borderBottom: '2px solid #cbd5e1',
                  borderRight: '1px solid #cbd5e1',
                  textAlign: 'center',
                  fontWeight: 700,
                  color: '#1e293b',
                  minWidth: '65px'
                }}>
                  Total
                </th>

                <th style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 30,
                  background: '#f1f5f9',
                  padding: '8px 10px',
                  borderBottom: '2px solid #cbd5e1',
                  borderRight: '1px solid #cbd5e1',
                  textAlign: 'center',
                  fontWeight: 700,
                  color: '#1e293b',
                  minWidth: '65px'
                }}>
                  Avg %
                </th>

                <th style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 30,
                  background: '#f1f5f9',
                  padding: '8px 10px',
                  borderBottom: '2px solid #cbd5e1',
                  borderRight: '1px solid #cbd5e1',
                  textAlign: 'center',
                  fontWeight: 700,
                  color: '#1e293b',
                  minWidth: '60px'
                }}>
                  Grade
                </th>
              </tr>
            </thead>

            <tbody>
              {displayedStudents.length === 0 ? (
                <tr>
                  <td colSpan={subjects.length + 6} style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
                    No students match your filter criteria.
                  </td>
                </tr>
              ) : (
                displayedStudents.map((student, rowIdx) => {
                  const sMarks = marksState[student.id] || {};
                  const isRowActive = activeCell?.rowIdx === rowIdx;

                  return (
                    <tr
                      key={student.id}
                      style={{
                        background: isRowActive ? '#f0f9ff' : (rowIdx % 2 === 0 ? '#ffffff' : '#fcfcfc'),
                        transition: 'background-color 0.1s ease'
                      }}
                    >
                      {/* Sticky Rank */}
                      <td style={{
                        position: 'sticky',
                        left: 0,
                        zIndex: 20,
                        background: isRowActive ? '#f0f9ff' : (rowIdx % 2 === 0 ? '#ffffff' : '#fcfcfc'),
                        padding: '5px 6px',
                        borderBottom: '1px solid #e2e8f0',
                        borderRight: '1px solid #cbd5e1',
                        width: '56px',
                        minWidth: '56px',
                        maxWidth: '56px',
                        boxSizing: 'border-box',
                        textAlign: 'center',
                        fontWeight: 700,
                        color: student.rank <= 3 ? '#b45309' : '#64748b'
                      }}>
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: '24px',
                          height: '24px',
                          borderRadius: '50%',
                          background: student.rank <= 3 ? '#fef3c7' : '#f1f5f9',
                          fontSize: '0.78rem'
                        }}>
                          {student.rank}
                        </span>
                      </td>

                      {/* Sticky Adm No */}
                      <td style={{
                        position: 'sticky',
                        left: '56px',
                        zIndex: 20,
                        background: isRowActive ? '#f0f9ff' : (rowIdx % 2 === 0 ? '#ffffff' : '#fcfcfc'),
                        padding: '5px 10px',
                        borderBottom: '1px solid #e2e8f0',
                        borderRight: '1px solid #cbd5e1',
                        width: '90px',
                        minWidth: '90px',
                        maxWidth: '90px',
                        boxSizing: 'border-box',
                        fontWeight: 600,
                        color: '#475569',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}>
                        {student.admNo || student.adm_no}
                      </td>

                      {/* Sticky Student Name */}
                      <td style={{
                        position: 'sticky',
                        left: '146px',
                        zIndex: 20,
                        background: isRowActive ? '#f0f9ff' : (rowIdx % 2 === 0 ? '#ffffff' : '#fcfcfc'),
                        padding: '5px 12px',
                        borderBottom: '1px solid #e2e8f0',
                        borderRight: '2px solid #94a3b8',
                        width: '200px',
                        minWidth: '200px',
                        maxWidth: '200px',
                        boxSizing: 'border-box',
                        fontWeight: 600,
                        color: '#0f172a',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        boxShadow: '4px 0 6px -2px rgba(0,0,0,0.05)'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={student.name}>
                            {student.name}
                          </span>
                          {onManageSubjects && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onManageSubjects(student);
                              }}
                              className="btn-icon"
                              title={`Manage subjects for ${student.name}`}
                              style={{
                                padding: '2px 4px',
                                border: 'none',
                                background: 'transparent',
                                color: '#64748b',
                                cursor: 'pointer',
                                borderRadius: '4px',
                                display: 'inline-flex',
                                alignItems: 'center',
                                flexShrink: 0
                              }}
                            >
                              <SettingsIcon size={13} />
                            </button>
                          )}
                        </div>
                      </td>

                      {/* Subject Mark Inputs */}
                      {displayedSubjects.map((sub, colIdx) => {
                        const isEnrolled = !student.subjects || student.subjects.length === 0 || student.subjects.includes(sub);
                        const editable = isEnrolled && canEditCell(student, sub);
                        const isSelectedSub = selectedSubjectStat === sub;
                        const isCellActive = activeCell?.rowIdx === rowIdx && activeCell?.colIdx === colIdx;
                        const cellKey = `${student.id}_${sub}`;
                        const error = validationErrors[cellKey];

                        const rawVal = sMarks[sub];
                        const displayVal = !isEnrolled ? '—' : (rawVal !== undefined && rawVal !== null ? rawVal : '');
                        const isSpecial = typeof rawVal === 'string' && ['ABS', 'MISSING', 'EXEMPT'].includes(rawVal.toUpperCase());

                        return (
                          <td
                            key={sub}
                            style={{
                              padding: 0,
                              borderBottom: '1px solid #e2e8f0',
                              borderRight: isSelectedSub ? '2px solid #93c5fd' : '1px solid #e2e8f0',
                              borderLeft: isSelectedSub ? '2px solid #93c5fd' : 'none',
                              textAlign: 'center',
                              position: 'relative',
                              width: '92px',
                              minWidth: '92px',
                              boxSizing: 'border-box',
                              background: !isEnrolled
                                ? '#f8fafc'
                                : isCellActive
                                  ? '#eff6ff'
                                  : error
                                    ? '#fee2e2'
                                    : isSpecial
                                      ? '#fef3c7'
                                      : isSelectedSub
                                        ? '#f0f7ff'
                                        : !editable
                                          ? '#f8fafc'
                                          : 'transparent'
                            }}
                          >
                            <input
                              id={`grid-mark-r${rowIdx}-c${colIdx}`}
                              type="text"
                              disabled={!editable}
                              value={displayVal}
                              placeholder="—"
                              onFocus={() => isEnrolled && setActiveCell({ rowIdx, colIdx, studentId: student.id, subject: sub })}
                              onChange={e => isEnrolled && handleMarkChange(student.id, sub, e.target.value)}
                              onKeyDown={e => handleKeyDown(e, rowIdx, colIdx)}
                              onPaste={e => isEnrolled && handlePaste(e, rowIdx, colIdx)}
                              title={!isEnrolled ? `${student.name} is not taking ${sub} (click ⚙ to manage)` : (error || '')}
                              style={{
                                width: '100%',
                                height: '34px',
                                border: isCellActive
                                  ? '2px solid #2563eb'
                                  : error
                                    ? '2px solid #dc2626'
                                    : 'none',
                                outline: 'none',
                                textAlign: 'center',
                                background: 'transparent',
                                fontSize: '0.85rem',
                                fontWeight: !isEnrolled ? 400 : (isSpecial || isCellActive ? 700 : 500),
                                color: !isEnrolled
                                  ? '#94a3b8'
                                  : error
                                    ? '#dc2626'
                                    : isSpecial
                                      ? '#b45309'
                                      : !editable
                                        ? '#94a3b8'
                                        : '#0f172a',
                                cursor: editable ? 'text' : 'not-allowed'
                              }}
                            />
                            {error && (
                              <div style={{
                                position: 'absolute',
                                bottom: '100%',
                                left: '50%',
                                transform: 'translateX(-50%)',
                                background: '#b91c1c',
                                color: '#ffffff',
                                padding: '3px 8px',
                                borderRadius: '4px',
                                fontSize: '0.68rem',
                                whiteSpace: 'nowrap',
                                zIndex: 50,
                                pointerEvents: 'none',
                                boxShadow: '0 2px 4px rgba(0,0,0,0.15)'
                              }}>
                                {error}
                              </div>
                            )}
                          </td>
                        );
                      })}

                      {/* Read-Only Total */}
                      <td style={{
                        padding: '5px 8px',
                        borderBottom: '1px solid #e2e8f0',
                        borderRight: '1px solid #cbd5e1',
                        textAlign: 'center',
                        fontWeight: 700,
                        background: '#f8fafc',
                        color: '#1e293b'
                      }}>
                        {student.total}
                      </td>

                      {/* Read-Only Average */}
                      <td style={{
                        padding: '5px 8px',
                        borderBottom: '1px solid #e2e8f0',
                        borderRight: '1px solid #cbd5e1',
                        textAlign: 'center',
                        fontWeight: 700,
                        background: '#f8fafc',
                        color: '#1e293b'
                      }}>
                        {student.average}%
                      </td>

                      {/* Read-Only Grade */}
                      <td style={{
                        padding: '5px 8px',
                        borderBottom: '1px solid #e2e8f0',
                        borderRight: '1px solid #cbd5e1',
                        textAlign: 'center',
                        fontWeight: 800,
                        background: '#f8fafc',
                        color: student.gradeColor || '#1e293b'
                      }}>
                        {student.grade}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Bulk Paste Preview Modal */}
      <PastePreviewModal
        isOpen={!!pasteModalData}
        pasteData={pasteModalData}
        onConfirm={commitPaste}
        onCancel={() => setPasteModalData(null)}
      />
    </div>
  );
}
