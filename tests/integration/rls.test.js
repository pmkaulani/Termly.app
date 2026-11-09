import { beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const url = process.env.TEST_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const anonKey = process.env.TEST_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const email = process.env.TEST_RLS_SCHOOL_A_EMAIL;
const password = process.env.TEST_RLS_SCHOOL_A_PASSWORD;
const schoolA = process.env.TEST_RLS_SCHOOL_A_ID;
const schoolB = process.env.TEST_RLS_SCHOOL_B_ID;
const configured = Boolean(url && anonKey && email && password && schoolA && schoolB);
const suite = configured ? describe : describe.skip;

suite('Supabase Row Level Security: school isolation', () => {
  let client;

  beforeAll(async () => {
    client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error('Could not sign in the School A RLS test user: ' + error.message);
  });

  it('allows School A to query its own tenant scope', async () => {
    const { data, error } = await client.from('students').select('id').eq('school_id', schoolA).limit(5);
    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  it('does not return School B student records to School A', async () => {
    const { data, error } = await client.from('students').select('id').eq('school_id', schoolB).limit(5);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});

if (!configured) {
  describe('Supabase Row Level Security: school isolation (configuration)', () => {
    it.skip('requires TEST_RLS_SCHOOL_A_EMAIL/PASSWORD/ID and TEST_RLS_SCHOOL_B_ID', () => {});
  });
}
