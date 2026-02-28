// ─── Shell Commands & PostgreSQL Binary Resolution ──────────────
// Handles running external CLI tools (pg_dump, pg_restore, psql)
// and finding where they're installed on the system.

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';

// ─── Shell Command Runners ──────────────────────────────────

// Runs a shell command and captures its stdout/stderr.
// Returns the exit code and output — used for version checks and dump commands.
export function runShellCommand(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }));
  });
}

// Runs a shell command and streams its output to the console in real time.
// Used for pg_dump/pg_restore where the user wants to see progress.
export function runShellCommandLive(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => {
      const lines = d.toString().trim().split('\n');
      lines.forEach((l: string) => {
        if (l.trim()) console.log(chalk.gray(`  ${l.trim()}`));
      });
    });
    child.stderr.on('data', (d) => {
      const lines = d.toString().trim().split('\n');
      lines.forEach((l: string) => {
        if (l.trim()) console.log(chalk.gray(`  ${l.trim()}`));
      });
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

// ─── PostgreSQL Binary Resolution ────────────────────────────
// Try to find the newest pg tools (v17 > v16 > v15 > fallback to PATH).
// This handles the case where PostgreSQL is installed but not on PATH.

const isWindows = os.platform() === 'win32';

const PG_SEARCH_PATHS = isWindows ? [
  'C:\\Program Files\\PostgreSQL\\17\\bin',
  'C:\\Program Files\\PostgreSQL\\16\\bin',
  'C:\\Program Files\\PostgreSQL\\15\\bin',
  'C:\\Program Files (x86)\\PostgreSQL\\17\\bin',
  'C:\\Program Files (x86)\\PostgreSQL\\16\\bin',
  'C:\\Program Files (x86)\\PostgreSQL\\15\\bin',
] : [
  '/opt/homebrew/opt/postgresql@17/bin',
  '/opt/homebrew/opt/postgresql@16/bin',
  '/opt/homebrew/opt/postgresql@15/bin',
  '/usr/local/opt/postgresql@17/bin',
  '/usr/local/opt/postgresql@16/bin',
  '/usr/local/opt/postgresql@15/bin',
];

// Finds the full path to a PostgreSQL binary (pg_dump, pg_restore, psql).
// Searches known install locations first, then falls back to PATH.
function findPgBin(name: string): string {
  const binName = isWindows ? `${name}.exe` : name;
  for (const dir of PG_SEARCH_PATHS) {
    const fullPath = path.join(dir, binName);
    if (existsSync(fullPath)) return fullPath;
  }
  return binName; // fallback to PATH
}

// Resolved paths to PostgreSQL tools — computed once at startup
export const PG_DUMP = findPgBin('pg_dump');
export const PG_RESTORE = findPgBin('pg_restore');
export const PSQL = findPgBin('psql');

// ─── Prerequisites Check ─────────────────────────────────────

// Verifies that pg_dump, pg_restore, and psql are available.
// Prints version info for each tool found, and install instructions if missing.
export async function checkPrerequisites(): Promise<boolean> {
  const checks = [
    { cmd: PG_DUMP, args: ['--version'], name: 'pg_dump' },
    { cmd: PG_RESTORE, args: ['--version'], name: 'pg_restore' },
    { cmd: PSQL, args: ['--version'], name: 'psql' },
  ];

  let allOk = true;
  for (const check of checks) {
    const result = await runShellCommand(check.cmd, check.args);
    if (result.code !== 0) {
      console.log(chalk.red(`  ✗ ${check.name} not found`));
      allOk = false;
    } else {
      const ver = result.stdout.trim().match(/(\d+\.\d+)/)?.[1] ?? '';
      console.log(chalk.gray(`  ${check.name} v${ver} → ${check.cmd}`));
    }
  }

  if (!allOk) {
    if (isWindows) {
      console.log(chalk.yellow('\n  Install PostgreSQL tools: https://www.postgresql.org/download/windows/\n'));
    } else if (os.platform() === 'darwin') {
      console.log(chalk.yellow('\n  Install PostgreSQL tools: brew install postgresql@17\n'));
    } else {
      console.log(chalk.yellow('\n  Install PostgreSQL tools: sudo apt-get install postgresql-client-17\n'));
    }
  }
  return allOk;
}
