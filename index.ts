#!/usr/bin/env npx tsx

import { select, input, checkbox, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import postgres from 'postgres';
import Table from 'cli-table3';
import ora from 'ora';
import { spawn } from 'child_process';
import { existsSync, statSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';

// ─── Banner ──────────────────────────────────────────────────

function showBanner() {
  console.log(chalk.cyan(`
  ┌─────────────────────────────────────┐
  │         DB Manager v1.0.0           │
  │   PostgreSQL / Supabase Tool        │
  └─────────────────────────────────────┘
  `));
}

// ─── Utilities ───────────────────────────────────────────────

function maskUrl(url: string): string {
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

function extractLabel(url: string): string {
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

function isPoolerUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes('pooler.supabase.com');
  } catch {
    return false;
  }
}

function ensureSslForDump(url: string): string {
  // Only used for pg_dump/pg_restore CLI commands
  if (url.includes('sslmode=')) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}sslmode=require`;
}

function createSql(url: string) {
  return postgres(url, {
    ssl: { rejectUnauthorized: false },
    max: 1,
    connect_timeout: 10,
  });
}

function validateUrl(val: string): string | boolean {
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

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function getDefaultExportDir(): string {
  const dir = path.join(os.homedir(), 'db-exports');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
}

// ─── Database Helpers ────────────────────────────────────────

interface TableInfo {
  name: string;
  rows: number;
  columns: number;
  size: string;
}

async function testConnection(url: string): Promise<{ ok: boolean; version?: string; error?: string }> {
  const sql = createSql(url);
  try {
    const res = await sql`SELECT version()`;
    const version = res[0].version.split(',')[0];
    await sql.end();
    return { ok: true, version };
  } catch (err: any) {
    try { await sql.end(); } catch {}
    return { ok: false, error: err.message };
  }
}

async function getTableInfo(url: string): Promise<TableInfo[]> {
  const sql = createSql(url);

  const tables = await sql`
    SELECT t.tablename,
           (SELECT COUNT(*) FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.table_name = t.tablename)::int as col_count,
           pg_size_pretty(pg_total_relation_size(quote_ident(t.tablename))) as size
    FROM pg_tables t
    WHERE t.schemaname = 'public'
    ORDER BY t.tablename
  `;

  const info: TableInfo[] = [];
  for (const row of tables) {
    const countRes = await sql.unsafe(`SELECT COUNT(*)::int as count FROM "${row.tablename}"`);
    info.push({
      name: row.tablename,
      rows: countRes[0].count,
      columns: row.col_count,
      size: row.size,
    });
  }

  await sql.end();
  return info;
}

async function getDbSize(url: string): Promise<string> {
  const sql = createSql(url);
  const res = await sql`SELECT pg_size_pretty(pg_database_size(current_database())) as size`;
  await sql.end();
  return res[0].size;
}

function runShellCommand(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

function runShellCommandLive(cmd: string, args: string[]): Promise<number> {
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

// Try to find the newest pg tools (v17 > v16 > v15 > fallback to PATH)
const PG_SEARCH_PATHS = [
  '/opt/homebrew/opt/postgresql@17/bin',
  '/opt/homebrew/opt/postgresql@16/bin',
  '/opt/homebrew/opt/postgresql@15/bin',
  '/usr/local/opt/postgresql@17/bin',
  '/usr/local/opt/postgresql@16/bin',
  '/usr/local/opt/postgresql@15/bin',
];

function findPgBin(name: string): string {
  for (const dir of PG_SEARCH_PATHS) {
    const fullPath = path.join(dir, name);
    if (existsSync(fullPath)) return fullPath;
  }
  return name; // fallback to PATH
}

const PG_DUMP = findPgBin('pg_dump');
const PG_RESTORE = findPgBin('pg_restore');
const PSQL = findPgBin('psql');

// ─── Check Prerequisites ────────────────────────────────────

async function checkPrerequisites(): Promise<boolean> {
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
    console.log(chalk.yellow('\n  Install PostgreSQL tools: brew install postgresql@17\n'));
  }
  return allOk;
}

// ─── Compare Workflow ────────────────────────────────────────

async function compareWorkflow() {
  console.log(chalk.cyan('\n  📊 Compare Databases\n'));

  const count = await select({
    message: 'How many databases to compare?',
    choices: [
      { name: '2 databases', value: 2 },
      { name: '3 databases', value: 3 },
    ],
  });

  const urls: string[] = [];
  const labels: string[] = [];

  for (let i = 0; i < count; i++) {
    const url = await input({
      message: `Paste database URL #${i + 1}:`,
      validate: validateUrl,
    });

    const label = await input({
      message: `Label for this DB (optional):`,
      default: extractLabel(url),
    });

    urls.push(url);
    labels.push(label);
  }

  // Test connections first
  const spinner = ora('Testing connections...').start();
  for (let i = 0; i < urls.length; i++) {
    spinner.text = `Testing connection to ${labels[i]}...`;
    const test = await testConnection(urls[i]);
    if (!test.ok) {
      spinner.fail(`Failed to connect to ${labels[i]}: ${test.error}`);
      return;
    }
  }
  spinner.text = 'Fetching table info (exact row counts)...';

  try {
    const allInfo = await Promise.all(urls.map((url) => getTableInfo(url)));
    const allSizes = await Promise.all(urls.map((url) => getDbSize(url)));
    spinner.succeed('All databases connected');

    // Collect all table names
    const allTableNames = new Set<string>();
    allInfo.forEach((info) => info.forEach((t) => allTableNames.add(t.name)));
    const sortedTables = [...allTableNames].sort();

    // Build header
    const headRow = ['Table'];
    labels.forEach((l) => headRow.push(`${l}`));
    if (count === 2) headRow.push('Delta');

    const table = new Table({
      head: headRow.map((h) => chalk.white.bold(h)),
      style: { head: [], border: ['gray'] },
      colAligns: ['left', ...labels.map(() => 'right' as const), ...(count === 2 ? ['right' as const] : [])],
    });

    let totalDelta = 0;
    let tablesWithDiffs = 0;

    for (const tName of sortedTables) {
      const row: string[] = [tName];
      const counts: number[] = [];

      for (const info of allInfo) {
        const found = info.find((t) => t.name === tName);
        const c = found ? found.rows : 0;
        counts.push(c);
        row.push(formatNumber(c));
      }

      if (count === 2) {
        const delta = counts[1] - counts[0];
        if (delta > 0) {
          row.push(chalk.green(`+${formatNumber(delta)}`));
          totalDelta += delta;
          tablesWithDiffs++;
        } else if (delta < 0) {
          row.push(chalk.red(formatNumber(delta)));
          totalDelta += Math.abs(delta);
          tablesWithDiffs++;
        } else {
          row.push(chalk.gray('—'));
        }
      }

      table.push(row);
    }

    // Totals row
    const totalsRow: string[] = [chalk.bold('TOTAL')];
    allInfo.forEach((info) => {
      totalsRow.push(chalk.bold(formatNumber(info.reduce((s, t) => s + t.rows, 0))));
    });
    if (count === 2) {
      const t1 = allInfo[0].reduce((s, t) => s + t.rows, 0);
      const t2 = allInfo[1].reduce((s, t) => s + t.rows, 0);
      const diff = t2 - t1;
      totalsRow.push(diff >= 0 ? chalk.green.bold(`+${formatNumber(diff)}`) : chalk.red.bold(formatNumber(diff)));
    }
    table.push(totalsRow);

    console.log('\n' + table.toString());

    // Summary
    console.log(chalk.cyan('\n  Summary:'));
    labels.forEach((l, i) => {
      console.log(`  ${l}: ${formatNumber(allInfo[i].reduce((s, t) => s + t.rows, 0))} rows, ${allInfo[i].length} tables, ${allSizes[i]} total size`);
    });
    if (count === 2) {
      console.log(chalk.yellow(`\n  ${tablesWithDiffs} tables with differences, ${formatNumber(totalDelta)} total row delta`));

      if (tablesWithDiffs === 0) {
        console.log(chalk.green('  ✓ Databases are in sync!\n'));
      } else {
        // Show only tables with differences
        console.log(chalk.yellow('\n  Tables with differences:'));
        for (const tName of sortedTables) {
          const c0 = allInfo[0].find((t) => t.name === tName)?.rows ?? 0;
          const c1 = allInfo[1].find((t) => t.name === tName)?.rows ?? 0;
          if (c0 !== c1) {
            const delta = c1 - c0;
            const arrow = delta > 0 ? chalk.green(`+${formatNumber(delta)}`) : chalk.red(formatNumber(delta));
            console.log(`    ${tName}: ${formatNumber(c0)} → ${formatNumber(c1)} (${arrow})`);
          }
        }
        console.log('');
      }
    }
  } catch (err: any) {
    spinner.fail('Error fetching table info');
    console.log(chalk.red(`  ${err.message}\n`));
  }
}

// ─── Export Workflow ──────────────────────────────────────────

async function exportWorkflow() {
  console.log(chalk.cyan('\n  📦 Export Database\n'));

  // Check pg_dump is available
  const pgCheck = await runShellCommand(PG_DUMP, ['--version']);
  if (pgCheck.code !== 0) {
    console.log(chalk.red('  pg_dump not found. Install: brew install libpq && brew link --force libpq\n'));
    return;
  }

  const url = await input({
    message: 'Paste the database URL to export:',
    validate: validateUrl,
  });

  // Test connection and show tables
  const spinner = ora('Connecting...').start();
  const test = await testConnection(url);
  if (!test.ok) {
    spinner.fail(`Connection failed: ${test.error}`);
    return;
  }
  spinner.text = 'Fetching tables...';

  let tableInfo: TableInfo[];
  let dbSize: string;
  try {
    tableInfo = await getTableInfo(url);
    dbSize = await getDbSize(url);
    spinner.succeed(`Connected — ${tableInfo.length} tables, ${dbSize} total`);
  } catch (err: any) {
    spinner.fail(`Error: ${err.message}`);
    return;
  }

  // Show tables
  const infoTable = new Table({
    head: ['Table', 'Rows', 'Columns', 'Size'].map((h) => chalk.white.bold(h)),
    style: { head: [], border: ['gray'] },
    colAligns: ['left', 'right', 'right', 'right'],
  });
  tableInfo.forEach((t) => infoTable.push([t.name, formatNumber(t.rows), t.columns.toString(), t.size]));
  console.log('\n' + infoTable.toString());
  console.log(chalk.gray(`  Total: ${formatNumber(tableInfo.reduce((s, t) => s + t.rows, 0))} rows\n`));

  // Export type
  const exportType = await select({
    message: 'Export type:',
    choices: [
      { name: 'Full (schema + data)', value: 'full' },
      { name: 'Data only', value: 'data' },
      { name: 'Schema only', value: 'schema' },
      { name: 'Specific tables', value: 'tables' },
    ],
  });

  let selectedTables: string[] = [];
  if (exportType === 'tables') {
    selectedTables = await checkbox({
      message: 'Select tables to export:',
      choices: tableInfo.map((t) => ({
        name: `${t.name} (${formatNumber(t.rows)} rows)`,
        value: t.name,
      })),
    });
    if (selectedTables.length === 0) {
      console.log(chalk.yellow('  No tables selected.\n'));
      return;
    }
  }

  // Output format
  const format = await select({
    message: 'Output format:',
    choices: [
      { name: '.dump (custom) — best for pg_restore', value: 'custom' },
      { name: '.sql (plain text) — human readable', value: 'plain' },
    ],
  });

  const ext = format === 'custom' ? '.dump' : '.sql';
  const defaultDir = getDefaultExportDir();
  const defaultFile = `${extractLabel(url)}_${exportType}_${timestamp()}${ext}`;

  const outputPath = await input({
    message: 'Output file path:',
    default: path.join(defaultDir, defaultFile),
  });

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Build pg_dump args
  const args: string[] = [
    `--dbname=${ensureSslForDump(url)}`,
    `--format=${format === 'custom' ? 'custom' : 'plain'}`,
    `--file=${outputPath}`,
    '--no-owner',
    '--no-privileges',
    '--verbose',
  ];

  if (exportType === 'data') {
    args.push('--data-only');
    args.push('--disable-triggers');
  } else if (exportType === 'schema') {
    args.push('--schema-only');
  }

  if (selectedTables.length > 0) {
    selectedTables.forEach((t) => args.push(`--table=${t}`));
  }

  // Confirm
  console.log(chalk.cyan('\n  Export summary:'));
  console.log(`  Source:  ${maskUrl(url)}`);
  console.log(`  Type:    ${exportType}`);
  console.log(`  Format:  ${format}${ext}`);
  if (selectedTables.length > 0) {
    console.log(`  Tables:  ${selectedTables.join(', ')}`);
  }
  console.log(`  Output:  ${outputPath}`);
  console.log('');

  const proceed = await confirm({ message: 'Start export?', default: true });
  if (!proceed) return;

  // Run pg_dump
  console.log(chalk.cyan('\n  Running pg_dump...\n'));
  const code = await runShellCommandLive(PG_DUMP, args);

  if (code === 0) {
    const fileSize = statSync(outputPath).size;
    const sizeStr = fileSize > 1048576
      ? `${(fileSize / 1048576).toFixed(1)} MB`
      : `${(fileSize / 1024).toFixed(1)} KB`;
    console.log(chalk.green(`\n  ✓ Export complete: ${outputPath} (${sizeStr})\n`));
  } else {
    console.log(chalk.red(`\n  ✗ Export failed (exit code ${code})\n`));
  }
}

// ─── Import Workflow ─────────────────────────────────────────

async function importWorkflow() {
  console.log(chalk.cyan('\n  📥 Import Database\n'));

  // Check tools are available
  const pgRestoreCheck = await runShellCommand(PG_RESTORE, ['--version']);
  const psqlCheck = await runShellCommand(PSQL, ['--version']);
  if (pgRestoreCheck.code !== 0 && psqlCheck.code !== 0) {
    console.log(chalk.red('  pg_restore/psql not found. Install: brew install libpq && brew link --force libpq\n'));
    return;
  }

  const url = await input({
    message: 'Paste the TARGET database URL (data goes HERE):',
    validate: validateUrl,
  });

  // Test connection
  const spinner = ora('Testing connection...').start();
  const test = await testConnection(url);
  if (!test.ok) {
    spinner.fail(`Connection failed: ${test.error}`);
    return;
  }
  spinner.succeed(`Connected — ${test.version}`);

  // Get dump file
  const dumpPath = await input({
    message: 'Paste the dump file path:',
    validate: (val: string) => {
      const p = val.trim().replace(/^['"]|['"]$/g, ''); // strip quotes
      if (!existsSync(p)) return `File not found: ${p}`;
      return true;
    },
    transformer: (val: string) => val.trim().replace(/^['"]|['"]$/g, ''),
  });

  const cleanPath = dumpPath.trim().replace(/^['"]|['"]$/g, '');
  const fileSize = statSync(cleanPath).size;
  const sizeStr = fileSize > 1048576
    ? `${(fileSize / 1048576).toFixed(1)} MB`
    : `${(fileSize / 1024).toFixed(1)} KB`;
  const isDump = cleanPath.endsWith('.dump');
  const isSql = cleanPath.endsWith('.sql');

  console.log(chalk.gray(`  File: ${path.basename(cleanPath)} (${sizeStr})`));

  if (!isDump && !isSql) {
    console.log(chalk.yellow('  ⚠ Unrecognized file extension. Expected .dump or .sql'));
    const proceed = await confirm({ message: 'Continue anyway?', default: false });
    if (!proceed) return;
  }

  // Import options
  const importType = await select({
    message: 'Import mode:',
    choices: [
      { name: 'Full restore (clean + restore — replaces existing data)', value: 'full' },
      { name: 'Data only (keeps schema, replaces data)', value: 'data' },
      { name: 'Append (add data without deleting existing)', value: 'append' },
    ],
  });

  // Show what's currently in the target
  const showTarget = await confirm({ message: 'Show current target DB tables before importing?', default: true });
  if (showTarget) {
    const infoSpinner = ora('Fetching target DB info...').start();
    try {
      const info = await getTableInfo(url);
      infoSpinner.succeed(`Target has ${info.length} tables`);
      const infoTable = new Table({
        head: ['Table', 'Rows'].map((h) => chalk.white.bold(h)),
        style: { head: [], border: ['gray'] },
        colAligns: ['left', 'right'],
      });
      info.forEach((t) => infoTable.push([t.name, formatNumber(t.rows)]));
      console.log('\n' + infoTable.toString());
      console.log(chalk.gray(`  Total: ${formatNumber(info.reduce((s, t) => s + t.rows, 0))} rows\n`));
    } catch (err: any) {
      infoSpinner.fail(`Error: ${err.message}`);
    }
  }

  // Backup before import?
  const backup = await confirm({ message: 'Create a backup of the target DB before importing?', default: true });

  if (backup) {
    const backupDir = getDefaultExportDir();
    const backupFile = path.join(backupDir, `backup_before_import_${extractLabel(url)}_${timestamp()}.dump`);
    console.log(chalk.cyan(`\n  Creating backup: ${backupFile}`));
    const backupSpinner = ora('Backing up target DB...').start();

    const backupArgs = [
      `--dbname=${ensureSslForDump(url)}`,
      '--format=custom',
      `--file=${backupFile}`,
      '--no-owner',
      '--no-privileges',
    ];

    const backupCode = await runShellCommandLive(PG_DUMP, backupArgs);
    if (backupCode === 0) {
      const bSize = statSync(backupFile).size;
      const bSizeStr = bSize > 1048576 ? `${(bSize / 1048576).toFixed(1)} MB` : `${(bSize / 1024).toFixed(1)} KB`;
      backupSpinner.succeed(`Backup saved: ${backupFile} (${bSizeStr})`);
    } else {
      backupSpinner.fail('Backup failed');
      const proceed = await confirm({ message: 'Continue without backup?', default: false });
      if (!proceed) return;
    }
  }

  // Final confirmation
  console.log(chalk.red.bold('\n  ⚠ FINAL CONFIRMATION'));
  console.log(chalk.red(`  Target:  ${maskUrl(url)}`));
  console.log(chalk.red(`  File:    ${path.basename(cleanPath)} (${sizeStr})`));
  console.log(chalk.red(`  Mode:    ${importType}`));
  if (importType === 'full') {
    console.log(chalk.red.bold('  This will REPLACE all existing data in the target database!'));
  }
  console.log('');

  const finalConfirm = await confirm({ message: 'Proceed with import?', default: false });
  if (!finalConfirm) {
    console.log(chalk.yellow('  Import cancelled.\n'));
    return;
  }

  // Build restore command
  console.log(chalk.cyan('\n  Running import...\n'));

  let code: number;

  if (isDump) {
    // Use pg_restore for .dump files
    const args: string[] = [
      `--dbname=${ensureSslForDump(url)}`,
      '--no-owner',
      '--no-privileges',
      '--verbose',
    ];

    if (importType === 'full') {
      args.push('--clean', '--if-exists');
    } else if (importType === 'data') {
      args.push('--data-only', '--disable-triggers', '--clean');
    } else if (importType === 'append') {
      args.push('--data-only', '--disable-triggers');
    }

    args.push(cleanPath);
    code = await runShellCommandLive(PG_RESTORE, args);

    // pg_restore returns non-zero for warnings too, check if it actually worked
    if (code !== 0) {
      console.log(chalk.yellow('\n  pg_restore exited with warnings (this is often normal for clean restores)'));
    }
  } else {
    // Use psql for .sql files
    const args: string[] = [
      `--dbname=${ensureSslForDump(url)}`,
      '--file', cleanPath,
      '--set', 'ON_ERROR_STOP=on',
    ];
    code = await runShellCommandLive(PSQL, args);
  }

  // Verify import
  const verify = await confirm({ message: 'Verify import by checking row counts?', default: true });
  if (verify) {
    const verifySpinner = ora('Verifying...').start();
    try {
      const info = await getTableInfo(url);
      verifySpinner.succeed('Verification complete');
      const verifyTable = new Table({
        head: ['Table', 'Rows'].map((h) => chalk.white.bold(h)),
        style: { head: [], border: ['gray'] },
        colAligns: ['left', 'right'],
      });
      info.forEach((t) => verifyTable.push([t.name, formatNumber(t.rows)]));
      console.log('\n' + verifyTable.toString());
      console.log(chalk.green(`\n  ✓ Import complete — ${formatNumber(info.reduce((s, t) => s + t.rows, 0))} total rows\n`));
    } catch (err: any) {
      verifySpinner.fail(`Verification error: ${err.message}`);
    }
  } else {
    console.log(chalk.green('\n  ✓ Import complete\n'));
  }
}

// ─── Inspect Dump File ───────────────────────────────────────

async function inspectWorkflow() {
  console.log(chalk.cyan('\n  🔍 Inspect Dump File\n'));

  const pgRestoreCheck = await runShellCommand(PG_RESTORE, ['--version']);
  if (pgRestoreCheck.code !== 0) {
    console.log(chalk.red('  pg_restore not found.\n'));
    return;
  }

  const dumpPath = await input({
    message: 'Paste the dump file path:',
    validate: (val: string) => {
      const p = val.trim().replace(/^['"]|['"]$/g, '');
      if (!existsSync(p)) return `File not found: ${p}`;
      return true;
    },
  });

  const cleanPath = dumpPath.trim().replace(/^['"]|['"]$/g, '');
  const fileSize = statSync(cleanPath).size;
  const sizeStr = fileSize > 1048576
    ? `${(fileSize / 1048576).toFixed(1)} MB`
    : `${(fileSize / 1024).toFixed(1)} KB`;

  console.log(chalk.gray(`  File: ${path.basename(cleanPath)} (${sizeStr})\n`));

  const spinner = ora('Reading dump contents...').start();
  const result = await runShellCommand(PG_RESTORE, ['--list', cleanPath]);

  if (result.code !== 0) {
    spinner.fail('Failed to read dump file');
    console.log(chalk.red(`  ${result.stderr}\n`));
    return;
  }

  spinner.succeed('Dump contents:');

  // Parse pg_restore --list output
  const lines = result.stdout.split('\n').filter((l) => l.trim() && !l.startsWith(';'));
  const tables = new Set<string>();
  let schemaItems = 0;
  let dataItems = 0;

  for (const line of lines) {
    if (line.includes(' TABLE DATA ')) {
      const match = line.match(/TABLE DATA public (\S+)/);
      if (match) tables.add(match[1]);
      dataItems++;
    } else if (line.includes(' TABLE ') || line.includes(' SEQUENCE ') || line.includes(' INDEX ') || line.includes(' CONSTRAINT ')) {
      schemaItems++;
    }
  }

  console.log(chalk.gray(`  ${schemaItems} schema objects, ${dataItems} data sections`));
  if (tables.size > 0) {
    console.log(chalk.gray(`  Tables with data: ${[...tables].sort().join(', ')}`));
  }
  console.log('');
}

// ─── Main Menu ───────────────────────────────────────────────

async function main() {
  showBanner();

  // Quick prereq check
  const spinner = ora('Checking prerequisites...').start();
  const ok = await checkPrerequisites();
  if (ok) {
    spinner.succeed('PostgreSQL tools available');
  } else {
    spinner.warn('Some tools missing — compare will work, export/import may not');
  }
  console.log('');

  while (true) {
    try {
      const action = await select({
        message: 'What would you like to do?',
        choices: [
          { name: '📊  Compare Databases', value: 'compare' },
          { name: '📦  Export Database', value: 'export' },
          { name: '📥  Import Database', value: 'import' },
          { name: '🔍  Inspect Dump File', value: 'inspect' },
          { name: '───────────────────', value: 'sep', disabled: true },
          { name: '👋  Exit', value: 'exit' },
        ],
      });

      switch (action) {
        case 'compare':
          await compareWorkflow();
          break;
        case 'export':
          await exportWorkflow();
          break;
        case 'import':
          await importWorkflow();
          break;
        case 'inspect':
          await inspectWorkflow();
          break;
        case 'exit':
          console.log(chalk.gray('\n  Bye!\n'));
          process.exit(0);
      }
    } catch (err: any) {
      // Handle Ctrl+C gracefully
      if (err.name === 'ExitPromptError' || err.message?.includes('User force closed')) {
        console.log(chalk.gray('\n  Bye!\n'));
        process.exit(0);
      }
      console.log(chalk.red(`\n  Error: ${err.message}\n`));
    }
  }
}

main();
