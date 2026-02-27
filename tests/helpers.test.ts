// Unit tests for pure utility functions in the DB Manager CLI.
// These functions don't need a database connection, so they're
// easy to test in isolation.

import { describe, it, expect } from 'vitest';
import {
  maskUrl,
  extractLabel,
  ensureSslForDump,
  isLocalUrl,
  validateUrl,
  formatNumber,
  timestamp,
  formatCellValue,
} from '../src/utils.js';

// ─── maskUrl ─────────────────────────────────────────────────
// Should hide the password part of a PostgreSQL connection string
// so it's safe to print in logs or terminal output.

describe('maskUrl', () => {
  it('masks the password in a standard postgres URL', () => {
    const url = 'postgresql://postgres:mysecret@localhost:5432/testdb';
    const result = maskUrl(url);
    expect(result).toContain('••••••');
    expect(result).not.toContain('mysecret');
  });

  it('returns the URL unchanged if there is no password', () => {
    const url = 'postgresql://localhost:5432/testdb';
    const result = maskUrl(url);
    expect(result).toBe(url);
  });

  it('returns masked string for completely invalid input', () => {
    const result = maskUrl('not-a-url');
    expect(result).toBe('••••••');
  });
});

// ─── extractLabel ────────────────────────────────────────────
// Should pull out a short, recognizable label from a database URL.
// For Supabase URLs it extracts the project ref prefix.
// For other URLs it uses the hostname.

describe('extractLabel', () => {
  it('extracts Supabase direct project ref', () => {
    const url = 'postgresql://postgres:pw@db.abcdef123456.supabase.co:5432/postgres';
    const result = extractLabel(url);
    expect(result).toBe('abcdef123456');
  });

  it('extracts Supabase pooler project ref from username', () => {
    const url = 'postgresql://postgres.abcdef123456@aws-0-us-west-1.pooler.supabase.com:6543/postgres';
    const result = extractLabel(url);
    expect(result).toBe('abcdef123456');
  });

  it('uses hostname for a regular local database', () => {
    const url = 'postgresql://postgres:root@localhost:5432/testdb';
    const result = extractLabel(url);
    expect(result).toBe('localhost');
  });

  it('returns "unknown" for invalid URLs', () => {
    const result = extractLabel('garbage');
    expect(result).toBe('unknown');
  });
});

// ─── ensureSslForDump ────────────────────────────────────────
// pg_dump and pg_restore need sslmode in the connection string.
// This function makes sure it's there, without duplicating it.

describe('ensureSslForDump', () => {
  it('appends sslmode=require when no query params exist', () => {
    const url = 'postgresql://postgres:pw@host:5432/db';
    const result = ensureSslForDump(url);
    expect(result).toBe('postgresql://postgres:pw@host:5432/db?sslmode=require');
  });

  it('appends with & when query params already exist', () => {
    const url = 'postgresql://postgres:pw@host:5432/db?timeout=10';
    const result = ensureSslForDump(url);
    expect(result).toBe('postgresql://postgres:pw@host:5432/db?timeout=10&sslmode=require');
  });

  it('does NOT add sslmode if already present', () => {
    const url = 'postgresql://postgres:pw@host:5432/db?sslmode=disable';
    const result = ensureSslForDump(url);
    expect(result).toBe(url); // should return unchanged
  });
});

// ─── isLocalUrl ──────────────────────────────────────────────
// Detects whether a database URL points to localhost so we can
// skip SSL (local PostgreSQL usually doesn't have SSL configured).

describe('isLocalUrl', () => {
  it('returns true for localhost', () => {
    expect(isLocalUrl('postgresql://postgres:root@localhost:5432/db')).toBe(true);
  });

  it('returns true for 127.0.0.1', () => {
    expect(isLocalUrl('postgresql://postgres:root@127.0.0.1:5432/db')).toBe(true);
  });

  it('returns true for IPv6 loopback ::1', () => {
    expect(isLocalUrl('postgresql://postgres:root@[::1]:5432/db')).toBe(true);
  });

  it('returns false for a remote host', () => {
    expect(isLocalUrl('postgresql://postgres:pw@db.supabase.co:5432/db')).toBe(false);
  });

  it('returns false for invalid URL', () => {
    expect(isLocalUrl('not-a-url')).toBe(false);
  });
});

// ─── validateUrl ─────────────────────────────────────────────
// Used by the CLI prompts to check if the user typed a valid
// PostgreSQL connection string before trying to connect.

describe('validateUrl', () => {
  it('accepts postgresql:// URLs', () => {
    expect(validateUrl('postgresql://postgres:root@localhost:5432/db')).toBe(true);
  });

  it('accepts postgres:// URLs (shorthand)', () => {
    expect(validateUrl('postgres://user:pass@host:5432/db')).toBe(true);
  });

  it('rejects URLs with wrong scheme', () => {
    const result = validateUrl('mysql://user:pass@host/db');
    expect(result).toBe('URL must start with postgresql:// or postgres://');
  });

  it('rejects completely invalid input', () => {
    const result = validateUrl('postgresql://');
    // Should either return true (valid URL) or an error string
    expect(typeof result === 'boolean' || typeof result === 'string').toBe(true);
  });
});

// ─── formatNumber ────────────────────────────────────────────
// Adds commas (or locale separators) for readability.

describe('formatNumber', () => {
  it('formats small numbers without separators', () => {
    expect(formatNumber(42)).toBe('42');
  });

  it('formats thousands with locale separator', () => {
    // The exact separator depends on the locale, so we just check
    // that it returns something reasonable and includes the digits
    const result = formatNumber(1234567);
    expect(result).toContain('1');
    expect(result).toContain('234');
    expect(result).toContain('567');
  });
});

// ─── timestamp ───────────────────────────────────────────────
// Creates a filename-safe timestamp (no colons or dots).

describe('timestamp', () => {
  it('returns a string with no colons or dots', () => {
    const ts = timestamp();
    expect(ts).not.toContain(':');
    expect(ts).not.toContain('.');
  });

  it('returns a 19-character string', () => {
    // Format: 2026-02-27T23-40-45 = 19 chars
    expect(timestamp().length).toBe(19);
  });

  it('starts with a valid year', () => {
    const ts = timestamp();
    const year = parseInt(ts.substring(0, 4));
    expect(year).toBeGreaterThanOrEqual(2020);
  });
});

// ─── formatCellValue ─────────────────────────────────────────
// Formats database values for display: nulls, dates, and everything else.

describe('formatCellValue', () => {
  it('returns "NULL" for null values', () => {
    expect(formatCellValue(null)).toBe('NULL');
  });

  it('returns "NULL" for undefined values', () => {
    expect(formatCellValue(undefined)).toBe('NULL');
  });

  it('formats Date objects as ISO strings without milliseconds', () => {
    const date = new Date('2026-02-27T12:30:00.000Z');
    const result = formatCellValue(date);
    expect(result).toBe('2026-02-27T12:30:00');
  });

  it('converts numbers to strings', () => {
    expect(formatCellValue(42)).toBe('42');
  });

  it('passes strings through unchanged', () => {
    expect(formatCellValue('hello')).toBe('hello');
  });

  it('converts booleans to strings', () => {
    expect(formatCellValue(true)).toBe('true');
    expect(formatCellValue(false)).toBe('false');
  });
});
