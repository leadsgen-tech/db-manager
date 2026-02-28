// ─── Export Database Workflow ──────────────────────────────────
// Exports a PostgreSQL database to a .dump or .sql file using pg_dump.
// Supports full, data-only, schema-only, and specific-table exports.

import { select, input, checkbox, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { existsSync, statSync, mkdirSync } from 'fs';
import path from 'path';
import { validateUrl, extractLabel, maskUrl, ensureSslForDump, formatNumber, getDefaultExportDir, timestamp } from '../utils.js';
import { testConnection, getTableInfo, getDbSize } from '../db.js';
import { runShellCommand, runShellCommandLive, PG_DUMP } from '../shell.js';

export async function exportWorkflow() {
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

  let tableInfo: any[];
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
  console.log(chalk.gray(`  Total: ${formatNumber(tableInfo.reduce((s: number, t: any) => s + t.rows, 0))} rows\n`));

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
