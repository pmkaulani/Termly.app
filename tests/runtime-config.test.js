import { describe, expect, it } from 'vitest';
import { isPrivateNetworkHost, validateTermlyRuntimeConfig } from '../src/lib/runtimeConfig';

describe('Termly runtime deployment configuration', () => {
  it('accepts a normal HTTPS cloud endpoint', () => {
    const result = validateTermlyRuntimeConfig({
      supabaseUrl: 'https://project.example.supabase.co',
      supabaseAnonKey: 'public-anon-key',
      deploymentMode: 'cloud',
      allowInsecureLan: false,
    }, 'production');
    expect(result.valid).toBe(true);
  });

  it('allows explicitly enabled HTTP only for a private school-hosted LAN endpoint', () => {
    const result = validateTermlyRuntimeConfig({
      supabaseUrl: 'http://192.168.1.20:8000',
      supabaseAnonKey: 'public-anon-key',
      deploymentMode: 'school-hosted',
      allowInsecureLan: true,
    }, 'production');
    expect(result.valid).toBe(true);
  });

  it('rejects HTTP to a public host even when the LAN override is enabled', () => {
    const result = validateTermlyRuntimeConfig({
      supabaseUrl: 'http://203.0.113.10:8000',
      supabaseAnonKey: 'public-anon-key',
      deploymentMode: 'school-hosted',
      allowInsecureLan: true,
    }, 'production');
    expect(result.valid).toBe(false);
  });

  it('rejects a Supabase secret or service-role key', () => {
    const result = validateTermlyRuntimeConfig({
      supabaseUrl: 'https://api.school.example',
      supabaseAnonKey: 'sb_secret_do_not_expose',
      deploymentMode: 'school-hosted',
    }, 'production');
    expect(result.valid).toBe(false);
  });

  it('recognises private IPv4 and local hostnames but not public IPv4', () => {
    expect(isPrivateNetworkHost('10.0.0.8')).toBe(true);
    expect(isPrivateNetworkHost('172.20.4.5')).toBe(true);
    expect(isPrivateNetworkHost('192.168.1.5')).toBe(true);
    expect(isPrivateNetworkHost('termly.school.local')).toBe(true);
    expect(isPrivateNetworkHost('8.8.8.8')).toBe(false);
  });
});
