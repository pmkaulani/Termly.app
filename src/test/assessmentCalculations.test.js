import { describe, it, expect } from 'vitest';
import {
  parseMarkValue,
  assignCompetitionRanks,
  getGradeForScore,
  calculateStudentSummary,
  calculatePerformanceStatistics,
  validateAssessmentWeights,
  SPECIAL_CODES,
  DEFAULT_844_SCALE,
  DEFAULT_CBC_SCALE
} from '../utils/assessmentCalculations';

describe('Assessment Calculations Engine', () => {
  describe('parseMarkValue', () => {
    it('correctly handles actual zero score', () => {
      const res = parseMarkValue(0, 100);
      expect(res.type).toBe('numeric');
      expect(res.value).toBe(0);
      expect(res.percentage).toBe(0);
      expect(res.error).toBeNull();
    });

    it('correctly handles empty marks without converting to zero', () => {
      const emptyNull = parseMarkValue(null, 100);
      expect(emptyNull.type).toBe('empty');
      expect(emptyNull.value).toBeNull();
      expect(emptyNull.percentage).toBeNull();

      const emptyStr = parseMarkValue('', 100);
      expect(emptyStr.type).toBe('empty');
      expect(emptyStr.value).toBeNull();

      const emptySpaces = parseMarkValue('   ', 100);
      expect(emptySpaces.type).toBe('empty');
      expect(emptySpaces.value).toBeNull();
    });

    it('identifies special codes: ABS, MISSING, EXEMPT', () => {
      expect(parseMarkValue('ABS').type).toBe('abs');
      expect(parseMarkValue('absent').type).toBe('abs');
      expect(parseMarkValue('MISSING').type).toBe('missing');
      expect(parseMarkValue('miss').type).toBe('missing');
      expect(parseMarkValue('EXEMPT').type).toBe('exempt');
      expect(parseMarkValue('ex').type).toBe('exempt');
    });

    it('validates configurable maximum marks', () => {
      // 42 out of 50 -> 84%
      const res50 = parseMarkValue(42, 50);
      expect(res50.type).toBe('numeric');
      expect(res50.value).toBe(42);
      expect(res50.percentage).toBe(84);

      // 84 out of 100 -> 84%
      const res100 = parseMarkValue(84, 100);
      expect(res100.type).toBe('numeric');
      expect(res100.value).toBe(84);
      expect(res100.percentage).toBe(84);

      // Value exceeding max mark
      const invalidOver = parseMarkValue(55, 50);
      expect(invalidOver.type).toBe('invalid');
      expect(invalidOver.error).toContain('exceeds maximum');
    });

    it('rejects negative numbers and invalid text', () => {
      const negative = parseMarkValue(-5, 100);
      expect(negative.type).toBe('invalid');
      expect(negative.error).toContain('Negative marks');

      const text = parseMarkValue('hello', 100);
      expect(text.type).toBe('invalid');
      expect(text.error).toContain('Invalid mark');
    });
  });

  describe('assignCompetitionRanks (Ties)', () => {
    it('correctly handles ties with standard competition ranking (1, 2, 2, 4)', () => {
      const list = [
        { id: '1', name: 'Alice', total: 450, average: 90 },
        { id: '2', name: 'Bob', total: 400, average: 80 },
        { id: '3', name: 'Charlie', total: 400, average: 80 },
        { id: '4', name: 'David', total: 350, average: 70 },
        { id: '5', name: 'Eve', total: 350, average: 70 },
        { id: '6', name: 'Frank', total: 350, average: 70 },
        { id: '7', name: 'Grace', total: 200, average: 40 }
      ];

      const ranked = assignCompetitionRanks(list, 'total', 'average');
      expect(ranked[0].name).toBe('Alice');
      expect(ranked[0].rank).toBe(1);

      expect(ranked[1].rank).toBe(2);
      expect(ranked[2].rank).toBe(2);

      // After two tied for rank 2, next rank MUST be 4
      expect(ranked[3].rank).toBe(4);
      expect(ranked[4].rank).toBe(4);
      expect(ranked[5].rank).toBe(4);

      // After three tied for rank 4, next rank MUST be 7
      expect(ranked[6].rank).toBe(7);
    });
  });

  describe('getGradeForScore', () => {
    it('correctly maps 8-4-4 default boundaries', () => {
      expect(getGradeForScore(85).grade).toBe('A');
      expect(getGradeForScore(80).grade).toBe('A');
      expect(getGradeForScore(79).grade).toBe('A-');
      expect(getGradeForScore(70).grade).toBe('B+');
      expect(getGradeForScore(65).grade).toBe('B');
      expect(getGradeForScore(50).grade).toBe('C');
      expect(getGradeForScore(30).grade).toBe('D-');
      expect(getGradeForScore(25).grade).toBe('E');
      expect(getGradeForScore(0).grade).toBe('E');
      expect(getGradeForScore(null).grade).toBe('—');
    });

    it('correctly maps CBC default competencies', () => {
      expect(getGradeForScore(85, { isCbc: true }).grade).toBe('EE');
      expect(getGradeForScore(70, { isCbc: true }).grade).toBe('ME');
      expect(getGradeForScore(50, { isCbc: true }).grade).toBe('AE');
      expect(getGradeForScore(30, { isCbc: true }).grade).toBe('BE');
    });
  });

  describe('calculateStudentSummary', () => {
    it('correctly summarizes raw marks, percentages, and special codes', () => {
      const student = { id: 's1', name: 'Bruce Wayne', class: 'Grade 8' };
      const marks = {
        'Mathematics': 42, // out of 50 -> 84%
        'English': 80,     // out of 100 -> 80%
        'Kiswahili': 'ABS', // absent
        'Science': 'EXEMPT' // exempt
      };
      const subjects = ['Mathematics', 'English', 'Kiswahili', 'Science'];
      const configs = {
        'Mathematics': { maxMark: 50, weight: 1.0 },
        'English': { maxMark: 100, weight: 1.0 },
        'Kiswahili': { maxMark: 100, weight: 1.0 },
        'Science': { maxMark: 100, weight: 1.0 }
      };

      const summary = calculateStudentSummary(student, marks, subjects, configs);

      expect(summary.total).toBe(122); // 42 + 80
      expect(summary.countEntered).toBe(2);
      expect(summary.countAbsent).toBe(1);
      expect(summary.countExempt).toBe(1);
      expect(summary.marks.Mathematics.percentage).toBe(84);
      expect(summary.marks.English.percentage).toBe(80);
      expect(summary.marks.Kiswahili.type).toBe('abs');
      expect(summary.marks.Science.type).toBe('exempt');
    });

    it('calculates curriculum average across all enrolled subjects when only some marks are entered', () => {
      const student = { id: 's2', name: 'James Kino', class: 'Form 1' };
      const marks = { 'Kiswahili': 89 };
      const subjects = ['English', 'Kiswahili', 'Mathematics', 'Biology', 'Physics', 'Chemistry', 'History', 'Geography', 'CRE', 'Business'];
      const summary = calculateStudentSummary(student, marks, subjects, {});

      expect(summary.total).toBe(89);
      expect(summary.countEntered).toBe(1);
      // 89 total marks across 10 enrolled subjects -> average 8.9%
      expect(summary.average).toBe(8.9);
      expect(summary.grade).toBe('E');
    });

    it('returns grade — when student has no marks entered at all', () => {
      const student = { id: 's3', name: 'New Student', class: 'Form 1' };
      const summary = calculateStudentSummary(student, {}, ['English', 'Kiswahili'], {});
      expect(summary.total).toBe(0);
      expect(summary.average).toBe(0);
      expect(summary.grade).toBe('—');
    });
  });

  describe('validateAssessmentWeights', () => {
    it('validates 100% total weight', () => {
      const valid = [
        { name: 'CAT 1', weight: 20 },
        { name: 'CAT 2', weight: 20 },
        { name: 'Exam', weight: 60 }
      ];
      expect(validateAssessmentWeights(valid).isValid).toBe(true);

      const invalid = [
        { name: 'CAT 1', weight: 20 },
        { name: 'CAT 2', weight: 20 },
        { name: 'Exam', weight: 50 }
      ];
      expect(validateAssessmentWeights(invalid).isValid).toBe(false);
      expect(validateAssessmentWeights(invalid).totalWeight).toBe(90);
    });
  });
});
