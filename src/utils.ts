// ─── Pure Utility Functions ──────────────────────────────────────
// These are all pure functions with NO side effects and NO database
// dependencies. They're easy to test, easy to reason about, and
// used across multiple workflows.

import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';

// ─── Banner ──────────────────────────────────────────────────
// Shows the CLI header when the app starts.
export function showBanner() {
  console.log(chalk.cyan(`
  ┌─────────────────────────────────────┐
  │         DB Manager v1.0.0           │
  │   PostgreSQL / Supabase Tool        │
  └─────────────────────────────────────┘
  `));
}

// ─── URL Utilities ───────────────────────────────────────────

// Hides the password in a database URL so it's safe to print
// in terminal output or log files. e.g., "postgres:mysecret@host"
// becomes "postgres:••••••@host"
export function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      return url.replace(parsed.password, '••••••');
    }
    return url;
  } catch {
    return '••••••';
  }
}

// Extracts a short, human-readable label from a database URL.
// For Supabase: pulls the project ref prefix.
// For localhost: just returns "localhost".
// This is used as the default label when comparing databases.
export function extractLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    // Supabase direct: db.PROJECT_REF.supabase.co
    const directMatch = host.match(/db\.(.+?)\.supabase\.co/);
    if (directMatch) return directMatch[1].substring(0, 12);
    // Supabase pooler: aws-0-region.pooler.supabase.com
    const poolerMatch = parsed.username.match(/postgres\.(.+)/);
    if (poolerMatch) return poolerMatch[1].substring(0, 12);
    return host.substring(0, 20);
  } catch {
    return 'unknown';
  }
}

// Checks if a URL uses the Supabase connection pooler (pgBouncer).
// Pooler URLs need special handling for some pg_dump operations.
export function isPoolerUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes('pooler.supabase.com');
  } catch {
    return false;
  }
}

// Appends sslmode=require to a URL if it doesn't already have one.
// pg_dump and pg_restore CLI commands need this for remote databases.
export function ensureSslForDump(url: string): string {
  if (url.includes('sslmode=')) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}sslmode=require`;
}

// Detects whether a database URL points to a local machine.
// Local PostgreSQL usually doesn't have SSL configured, so we
// skip SSL for these connections to avoid ECONNRESET errors.
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

// Validates that a user-entered string is a valid PostgreSQL URL.
// Returns true if valid, or an error message string if not.
// Used by inquirer prompts as a validation function.
export function validateUrl(val: string): string | boolean {
  if (!val.startsWith('postgresql://') && !val.startsWith('postgres://')) {
    return 'URL must start with postgresql:// or postgres://';
  }
  try {
    new URL(val);
    return true;
  } catch {
    return 'Invalid URL format';
  }
}

// ─── Formatting Utilities ────────────────────────────────────

// Formats a number with locale-appropriate thousands separators.
// e.g., 1234567 → "1,234,567" in en-US
export function formatNumber(n: number): string {
  return n.toLocaleString();
}

// Creates a filename-safe timestamp string.
// e.g., "2026-02-28T01-14-11" (no colons or dots)
export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
}

// Formats a database cell value for display in a terminal table.
// Handles nulls, dates, and converts everything else to string.
export function formatCellValue(val: any): string {
  if (val === null || val === undefined) return 'NULL';
  if (val instanceof Date) return val.toISOString().substring(0, 19);
  return String(val);
}

// Returns the default directory for database exports (~/ db-exports/).
// Creates the directory if it doesn't exist.
export function getDefaultExportDir(): string {
  const dir = path.join(os.homedir(), 'db-exports');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
