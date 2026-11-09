import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bulkImportStudents } from '../../src/data/studentStore';

// Mock dependencies
vi.mock('../../src/data/coreStore', () => ({
  _currentSchoolId: 'test-school-123',
  _currentPeriodId: 'test-period-123',
  mutationGuard: vi.fn(),
  getSchoolProfile: vi.fn().mockResolvedValue({ id: 'test-school-123', name: 'Test School', studentLimit: 500 }),
  logPlatformActivity: vi.fn(),
  logAuditEvent: vi.fn(),
  getCurrentSchoolId: () => 'test-school-123',
  shouldFetchCloud: () => false
}));

vi.mock('../../src/data/offlineStore', () => ({
  db: {
    students: {
      bulkPut: vi.fn().mockResolvedValue(true),
      put: vi.fn().mockResolvedValue(true),
      update: vi.fn().mockResolvedValue(true),
      where: () => ({ equals: () => ({ toArray: () => Promise.resolve([]) }) })
    }
  },
  queueChange: vi.fn()
}));

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn()
  }
}));

import { supabase } from '../../src/lib/supabase';

describe('Data Ingestion: bulkImportStudents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should deduplicate incoming rows by admission number', async () => {
    supabase.from.mockImplementation((table) => {
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnValue({ select: () => Promise.resolve({ data: [{ id: 's-1', name: 'John Doe' }, { id: 's-2', name: 'Jane Doe' }], error: null }) }),
        update: vi.fn().mockResolvedValue({ error: null })
      };
      
      if (table === 'students') {
        const studentQuery = {
          eq: vi.fn().mockImplementation((col, val) => {
            if (col === 'school_id') {
              return {
                order: () => Promise.resolve({ data: [], error: null }),
                eq: () => Promise.resolve({ count: 10, error: null })
              };
            }
            return studentQuery;
          }),
          order: () => Promise.resolve({ data: [], error: null })
        };
        chain.select = vi.fn().mockReturnValue(studentQuery);
      } else if (table === 'fees') {
        chain.insert = vi.fn().mockResolvedValue({ error: null });
      }
      return chain;
    });

    // Provide rows with duplicate adm_no
    const incomingRows = [
      { name: 'John Doe', adm_no: 'ADM001', gender: 'Male', class: 'Grade 1', stream: 'Grade 1 North' },
      { name: 'John Duplicate', adm_no: 'ADM001', gender: 'Male', class: 'Grade 1', stream: 'Grade 1 North' }, // Should be skipped
      { name: 'Jane Doe', adm_no: 'ADM002', gender: 'Female', class: 'Grade 1', stream: 'Grade 1 North' },
    ];

    const progressCallback = vi.fn();
    const result = await bulkImportStudents(incomingRows, progressCallback);

    // Should only insert 2 records
    expect(result.inserted).toBe(2);
    expect(result.errors.length).toBe(1); // One duplicate error
    expect(result.errors[0].reason).toContain('Duplicate admission number');
  });
});
