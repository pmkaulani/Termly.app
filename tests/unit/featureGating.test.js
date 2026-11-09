import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isFeatureEnabled, setCurrentSchool } from '../../src/data/coreStore';

describe('Feature Gating: isFeatureEnabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when no school context exists', async () => {
    setCurrentSchool(null);
    const enabled = await isFeatureEnabled('library');
    expect(enabled).toBe(false);
  });
});
