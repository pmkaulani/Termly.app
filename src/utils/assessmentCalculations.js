/**
 * Centralized Assessment & Grading Calculations Engine for Termly
 * Single source of truth for:
 * - Special mark validation (0 vs ABS vs MISSING vs EXEMPT vs EMPTY)
 * - Configurable maximum marks & percentage conversion
 * - Standard competition ranking with ties (1, 2, 2, 4)
 * - Configurable grading scales (8-4-4, CBC, custom)
 * - Weighted assessment calculations
 * - Class and subject performance statistics
 */

import { getLevelForGrade } from '../data/seedData';

export const SPECIAL_CODES = {
  ABS: 'ABS',
  MISSING: 'MISSING',
  EXEMPT: 'EXEMPT',
  EMPTY: 'EMPTY'
};

export const DEFAULT_844_SCALE = [
  { min: 80, max: 100, grade: 'A',  points: 12, remarks: 'Excellent',     color: '#16a34a', textClass: 'text-green-600' },
  { min: 75, max: 79,  grade: 'A-', points: 11, remarks: 'Very Good',     color: '#059669', textClass: 'text-emerald-600' },
  { min: 70, max: 74,  grade: 'B+', points: 10, remarks: 'Good',          color: '#2563eb', textClass: 'text-blue-600' },
  { min: 65, max: 69,  grade: 'B',  points: 9,  remarks: 'Fairly Good',   color: '#0284c7', textClass: 'text-sky-600' },
  { min: 60, max: 64,  grade: 'B-', points: 8,  remarks: 'Above Average', color: '#0ea5e9', textClass: 'text-sky-500' },
  { min: 55, max: 59,  grade: 'C+', points: 7,  remarks: 'Average',       color: '#d97706', textClass: 'text-amber-600' },
  { min: 50, max: 54,  grade: 'C',  points: 6,  remarks: 'Fairly Average',color: '#eab308', textClass: 'text-yellow-600' },
  { min: 45, max: 49,  grade: 'C-', points: 5,  remarks: 'Fair',          color: '#ea580c', textClass: 'text-orange-600' },
  { min: 40, max: 44,  grade: 'D+', points: 4,  remarks: 'Below Average', color: '#c2410c', textClass: 'text-orange-700' },
  { min: 35, max: 39,  grade: 'D',  points: 3,  remarks: 'Poor',          color: '#e11d48', textClass: 'text-rose-600' },
  { min: 30, max: 34,  grade: 'D-', points: 2,  remarks: 'Very Poor',     color: '#dc2626', textClass: 'text-red-600' },
  { min: 0,  max: 29,  grade: 'E',  points: 1,  remarks: 'Fail',          color: '#b91c1c', textClass: 'text-red-700' }
];

export const DEFAULT_CBC_SCALE = [
  { min: 80, max: 100, grade: 'EE', points: 4, remarks: 'Exceeding Expectations', color: '#10b981', badgeBg: '#dcfce7', textHex: '#15803d' },
  { min: 60, max: 79,  grade: 'ME', points: 3, remarks: 'Meeting Expectations',   color: '#3b82f6', badgeBg: '#dbeafe', textHex: '#1e40af' },
  { min: 40, max: 59,  grade: 'AE', points: 2, remarks: 'Approaching Expectations', color: '#f59e0b', badgeBg: '#fef3c7', textHex: '#92400e' },
  { min: 0,  max: 39,  grade: 'BE', points: 1, remarks: 'Below Expectations',     color: '#ef4444', badgeBg: '#fee2e2', textHex: '#991b1b' }
];

/**
 * Parses and validates an input value for a mark cell.
 * Distinguishes numeric 0, ABS, MISSING, EXEMPT, and empty.
 *
 * @param {any} input Raw input from user/spreadsheet
 * @param {number} maxMark Maximum allowed mark (default 100)
 * @returns {{
 *   type: 'numeric' | 'abs' | 'missing' | 'exempt' | 'empty' | 'invalid',
 *   value: number | string | null,
 *   raw: string,
 *   percentage: number | null,
 *   error: string | null
 * }}
 */
export function parseMarkValue(input, maxMark = 100) {
  if (input === null || input === undefined) {
    return { type: 'empty', value: null, raw: '', percentage: null, error: null };
  }

  const raw = String(input).trim();
  if (raw === '') {
    return { type: 'empty', value: null, raw: '', percentage: null, error: null };
  }

  const upper = raw.toUpperCase();

  // Special codes
  if (upper === 'ABS' || upper === 'ABSENT') {
    return { type: 'abs', value: 'ABS', raw, percentage: null, error: null };
  }
  if (upper === 'MISSING' || upper === 'MISS' || upper === 'INC') {
    return { type: 'missing', value: 'MISSING', raw, percentage: null, error: null };
  }
  if (upper === 'EXEMPT' || upper === 'EX') {
    return { type: 'exempt', value: 'EXEMPT', raw, percentage: null, error: null };
  }

  // Numeric check
  const num = Number(raw);
  if (isNaN(num)) {
    return {
      type: 'invalid',
      value: null,
      raw,
      percentage: null,
      error: `Invalid mark "${raw}". Enter a number, ABS, MISSING, or EXEMPT.`
    };
  }

  if (num < 0) {
    return {
      type: 'invalid',
      value: num,
      raw,
      percentage: null,
      error: 'Negative marks are not allowed.'
    };
  }

  const effectiveMax = Number(maxMark) > 0 ? Number(maxMark) : 100;
  if (num > effectiveMax) {
    return {
      type: 'invalid',
      value: num,
      raw,
      percentage: null,
      error: `Mark (${num}) exceeds maximum allowed of ${effectiveMax}.`
    };
  }

  const percentage = Number(((num / effectiveMax) * 100).toFixed(2));
  return {
    type: 'numeric',
    value: num,
    raw,
    percentage,
    error: null
  };
}

/**
 * Gets grade, points, and remarks for a given percentage score.
 *
 * @param {number|null} score Percentage score (0-100)
 * @param {object} options
 * @param {string} options.className
 * @param {object} options.profile School profile with custom grading_systems
 * @param {boolean} options.isCbc Whether to force CBC scale
 * @param {string} options.subjectName Optional subject name for subject-specific scales
 * @returns {{ grade: string, points: number, remarks: string, color: string, badgeBg?: string, textClass?: string }}
 */
export function getGradeForScore(score, { className = '', profile = null, isCbc = false, subjectName = null } = {}) {
  if (score === null || score === undefined || score === '' || isNaN(Number(score))) {
    return { grade: '—', points: 0, remarks: 'Not Entered', color: '#94a3b8', textClass: 'text-gray-400' };
  }

  const num = Number(score);
  const level = className ? getLevelForGrade(className) : null;
  const isEarlyOrCbc = isCbc || (level && (level === 'Early Years' || level === 'Upper Primary' || level === 'Junior Secondary'));

  const systems = profile?.gradingSystems || profile?.grading_systems;
  let activeScale = null;

  // 1. Subject-specific scale
  if (subjectName && profile?.subjectConfigs?.[className]?.[subjectName]?.gradingScale) {
    activeScale = profile.subjectConfigs[className][subjectName].gradingScale;
  }

  // 2. Class or level scale
  if (!activeScale && systems) {
    activeScale = systems[className] || systems[level] || systems[level?.toLowerCase()] || systems.default;
    if (!activeScale) {
      if (className?.toLowerCase().includes('form')) activeScale = systems.secondary || systems['Senior Secondary'] || systems['Secondary (8-4-4)'];
      else if (className?.toLowerCase().includes('grade') || className?.toLowerCase().includes('class')) activeScale = systems.primary || systems['Upper Primary'] || systems['Junior Secondary'];
    }
  }

  if (!activeScale || !Array.isArray(activeScale) || activeScale.length === 0) {
    activeScale = isEarlyOrCbc ? DEFAULT_CBC_SCALE : DEFAULT_844_SCALE;
  }

  for (const g of activeScale) {
    const symbol = g.grade || g.symbol || g.name;
    if (num >= g.min && num <= g.max) {
      return {
        grade: symbol,
        points: g.points ?? 0,
        remarks: g.remarks || g.name || g.description || '',
        color: g.color || '#3b82f6',
        badgeBg: g.badgeBg,
        textClass: g.textClass || 'text-gray-700'
      };
    }
  }

  const fallback = activeScale[activeScale.length - 1] || DEFAULT_844_SCALE[DEFAULT_844_SCALE.length - 1];
  return {
    grade: fallback ? (fallback.grade || fallback.symbol || 'E') : 'E',
    points: fallback?.points ?? 0,
    remarks: fallback?.remarks || fallback?.name || '',
    color: fallback?.color || '#ef4444',
    badgeBg: fallback?.badgeBg,
    textClass: fallback?.textClass || 'text-red-600'
  };
}

/**
 * Standard Competition Ranking with proper tie handling (1, 2, 2, 4).
 * Mutates or returns items with an assigned `.rank` property.
 *
 * @param {Array<object>} items List of student results
 * @param {string} primaryKey Key for primary sort (e.g., 'total' or 'average')
 * @param {string} secondaryKey Optional tie-breaker key
 * @returns {Array<object>} Same items, sorted and ranked
 */
export function assignCompetitionRanks(items, primaryKey = 'total', secondaryKey = 'average') {
  if (!Array.isArray(items) || items.length === 0) return [];

  // Sort descending: primary first, then secondary
  const sorted = [...items].sort((a, b) => {
    const scoreA = Number(a[primaryKey]) || 0;
    const scoreB = Number(b[primaryKey]) || 0;
    if (scoreB !== scoreA) return scoreB - scoreA;

    const secA = Number(a[secondaryKey]) || 0;
    const secB = Number(b[secondaryKey]) || 0;
    return secB - secA;
  });

  for (let i = 0; i < sorted.length; i++) {
    if (i === 0) {
      sorted[i].rank = 1;
    } else {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const prevScore = Number(prev[primaryKey]) || 0;
      const currScore = Number(curr[primaryKey]) || 0;
      const prevSec = Number(prev[secondaryKey]) || 0;
      const currSec = Number(curr[secondaryKey]) || 0;

      if (prevScore === currScore && prevSec === currSec) {
        // Tied with previous student: keep same rank
        sorted[i].rank = prev.rank;
      } else {
        // Standard competition ranking: next rank is index + 1
        sorted[i].rank = i + 1;
      }
    }
  }

  return sorted;
}

/**
 * Calculates student total, average, grade, and subject counts.
 *
 * @param {object} student Student record
 * @param {object} marks Map of subject -> raw mark
 * @param {Array<string>} subjects List of relevant subject names
 * @param {object} subjectConfigs Map of subject -> { maxMark: 100, weight: 1.0 }
 * @param {object} profile School profile for grading
 * @returns {object} Calculated student result
 */
export function calculateStudentSummary(student, marks = {}, subjects = [], subjectConfigs = {}, profile = null, options = {}) {
  const cleanMarks = {};
  let totalRaw = 0;
  let totalPossibleMax = 0;
  let weightedSum = 0;
  let totalWeights = 0;
  let enteredWeights = 0;
  let countEntered = 0;
  let countAbsent = 0;
  let countMissing = 0;
  let countExempt = 0;

  const enrolledSubjects = (student.subjects && student.subjects.length > 0)
    ? student.subjects.filter(s => subjects.includes(s))
    : subjects;

  enrolledSubjects.forEach(sub => {
    const config = subjectConfigs[sub] || { maxMark: 100, weight: 1.0 };
    const maxMark = Number(config.maxMark) > 0 ? Number(config.maxMark) : 100;
    const weight = Number(config.weight) > 0 ? Number(config.weight) : 1.0;

    const parsed = parseMarkValue(marks[sub], maxMark);
    cleanMarks[sub] = parsed;

    if (parsed.type === 'exempt') {
      countExempt++;
      // Exempt is excluded from possible total and weights
      return;
    }

    // Every non-exempt enrolled subject forms part of the expected curriculum
    totalPossibleMax += maxMark;
    totalWeights += weight;

    if (parsed.type === 'numeric') {
      totalRaw += parsed.value;
      weightedSum += parsed.percentage * weight;
      enteredWeights += weight;
      countEntered++;
    } else if (parsed.type === 'abs') {
      countAbsent++;
    } else if (parsed.type === 'missing') {
      countMissing++;
    }
  });

  const hasAnyActivity = countEntered > 0 || countAbsent > 0 || countMissing > 0;

  // Blank marks stay blank and do NOT reduce an average as zero
  let averagePercentage = 0;
  const divisor = (options && options.unenteredAsZero && totalWeights > 0)
    ? totalWeights 
    : (enteredWeights > 0 ? enteredWeights : totalWeights);

  if (countEntered > 0 && divisor > 0) {
    averagePercentage = Number((weightedSum / divisor).toFixed(1));
  }

  const gradeInfo = countEntered > 0
    ? getGradeForScore(averagePercentage, { className: student.class, profile })
    : { grade: '—', points: 0, remarks: 'Not Entered', color: '#94a3b8' };

  return {
    ...student,
    marks: cleanMarks,
    rawMarks: marks,
    total: hasAnyActivity ? totalRaw : 0,
    totalPossibleMax,
    average: hasAnyActivity ? averagePercentage : 0,
    grade: gradeInfo.grade,
    points: gradeInfo.points,
    remarks: gradeInfo.remarks,
    gradeColor: gradeInfo.color,
    countEntered,
    countAbsent,
    countMissing,
    countExempt,
    enrolledSubjects,
    level: student.class ? getLevelForGrade(student.class) : 'Secondary (8-4-4)',
    isPass: hasAnyActivity ? averagePercentage >= 50 : false
  };
}

/**
 * Calculates class-wide and subject-level performance statistics.
 *
 * @param {Array<object>} studentResults List of student summaries
 * @param {Array<string>} subjects List of subjects
 * @param {object} subjectConfigs Map of subject -> config
 * @returns {{
 *   classStats: { average: number, highest: number, lowest: number, passRate: number, totalStudents: number },
 *   subjectStats: { [subject: string]: { average: number, highest: number, lowest: number, passRate: number, entered: number, missing: number, absent: number, maxMark: number } }
 * }}
 */
export function calculatePerformanceStatistics(studentResults = [], subjects = [], subjectConfigs = {}, context = {}) {
  if (studentResults.length === 0) {
    return {
      classStats: { average: 0, highest: 0, lowest: 0, passRate: 0, totalStudents: 0 },
      subjectStats: {}
    };
  }

  const validAverages = studentResults
    .map(s => Number(s.average))
    .filter(a => !isNaN(a) && a > 0);

  const classAvg = validAverages.length > 0
    ? Number((validAverages.reduce((sum, v) => sum + v, 0) / validAverages.length).toFixed(1))
    : 0;

  const classHighest = validAverages.length > 0 ? Math.max(...validAverages) : 0;
  const classLowest = validAverages.length > 0 ? Math.min(...validAverages) : 0;
  const passCount = validAverages.filter(a => a >= 50).length;
  const classPassRate = validAverages.length > 0
    ? Math.round((passCount / validAverages.length) * 100)
    : 0;

  const subjectStats = {};

  subjects.forEach(sub => {
    const config = subjectConfigs[sub] || { maxMark: 100 };
    const maxMark = Number(config.maxMark) > 0 ? Number(config.maxMark) : 100;

    let subTotal = 0;
    let subEntered = 0;
    let subMissing = 0;
    let subAbsent = 0;
    let subHighest = -1;
    let subLowest = 999999;
    let subPassed = 0;

    studentResults.forEach(s => {
      // Check if student is enrolled in this subject (if student has elective subject choices)
      const isEnrolled = !s.subjects || s.subjects.length === 0 || s.subjects.includes(sub);
      if (!isEnrolled) return;

      const parsed = s.marks?.[sub] || parseMarkValue(s.rawMarks?.[sub], maxMark);
      if (parsed.type === 'numeric') {
        const val = parsed.value;
        subTotal += val;
        subEntered++;
        if (val > subHighest) subHighest = val;
        if (val < subLowest) subLowest = val;
        if ((val / maxMark) * 100 >= 50) subPassed++;
      } else if (parsed.type === 'abs') {
        subAbsent++;
      } else if (parsed.type === 'missing') {
        subMissing++;
      }
    });

    const subAvg = subEntered > 0 ? Number((subTotal / subEntered).toFixed(1)) : 0;
    const passRate = subEntered > 0 ? Math.round((subPassed / subEntered) * 100) : 0;
    const gradeInfo = subEntered > 0 && (context?.className || context?.profile)
      ? getGradeForScore(subAvg, { className: context.className, profile: context.profile, subjectName: sub })
      : null;

    subjectStats[sub] = {
      average: subAvg,
      highest: subHighest >= 0 ? subHighest : 0,
      lowest: subLowest <= maxMark ? subLowest : 0,
      passRate,
      entered: subEntered,
      missing: subMissing,
      absent: subAbsent,
      maxMark,
      grade: gradeInfo?.grade || null,
      gradeColor: gradeInfo?.color || null
    };
  });

  return {
    classStats: {
      average: classAvg,
      highest: classHighest,
      lowest: classLowest,
      passRate: classPassRate,
      totalStudents: studentResults.length
    },
    subjectStats
  };
}

/**
 * Calculates trend between two numerical values.
 *
 * @param {number} current
 * @param {number} previous
 * @returns {{ direction: 'improved' | 'declined' | 'stable', diff: number, symbol: string }}
 */
export function calculatePerformanceTrend(current, previous) {
  if (previous === null || previous === undefined || isNaN(Number(previous))) {
    return { direction: 'stable', diff: 0, symbol: '—' };
  }
  const curr = Number(current) || 0;
  const prev = Number(previous) || 0;
  const diff = Number((curr - prev).toFixed(1));

  if (diff > 0.5) return { direction: 'improved', diff, symbol: '▲' };
  if (diff < -0.5) return { direction: 'declined', diff, symbol: '▼' };
  return { direction: 'stable', diff: 0, symbol: '—' };
}

/**
 * Validates weighting configuration (e.g. CAT 1 20%, CAT 2 20%, Exam 60%).
 *
 * @param {Array<{ name: string, weight: number }>} assessments
 * @returns {{ isValid: boolean, totalWeight: number, message: string }}
 */
export function validateAssessmentWeights(assessments = []) {
  const total = assessments.reduce((sum, a) => sum + (Number(a.weight) || 0), 0);
  const isValid = Math.abs(total - 100) < 0.01 || Math.abs(total - 1.0) < 0.001;
  return {
    isValid,
    totalWeight: total,
    message: isValid
      ? 'Weights are balanced.'
      : `Assessment weights total ${total}%, expected 100%.`
  };
}
