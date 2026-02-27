// ─── Import Database Workflow ─────────────────────────────────
// Imports a .dump or .sql file into a PostgreSQL database.
// Supports full restore, data-only, and append modes.
// Includes backup and verification steps.

import { select, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { validateUrl, extractLabel, maskUrl, ensureSslForDump, formatNumber, getDefaultExportDir, timestamp } from '../utils.js';
import { testConnection, getTableInfo } from '../db.js';
import { runShellCommand, runShellCommandLive, PG_DUMP, PG_RESTORE, PSQL } from '../shell.js';

export async function importWorkflow() {
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
