// ─── Inspect Dump File Workflow ───────────────────────────────
// Reads a .dump file using pg_restore --list and shows its contents:
// how many schema objects, data sections, and which tables have data.

import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { runShellCommand, PG_RESTORE } from '../shell.js';

export async function inspectWorkflow() {
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
