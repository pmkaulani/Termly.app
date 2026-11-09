import { describe, it, expect, vi, beforeEach } from 'vitest';
import { previewClassPromotion, promoteClasses } from '../../src/data/academicsStore';

// Mock dependencies
vi.mock('../../src/data/coreStore', () => ({
  _currentSchoolId: 'test-school-123',
  getSchoolProfile: vi.fn(),
  mutationGuard: vi.fn(),
}));

describe('Academics Engine: Class Promotion Guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails safely with an explicit error instead of returning unverified results', async () => {
    await expect(previewClassPromotion('2025', '2026')).rejects.toThrow(
      /Class promotion is temporarily disabled/
    );
    await expect(promoteClasses()).rejects.toThrow(
      /Class promotion is temporarily disabled/
    );
  });
});
