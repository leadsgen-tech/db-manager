// ─── Compare Databases Workflow ──────────────────────────────
// Compares row counts across 2-3 databases to find tables
// that have drifted. Shows a side-by-side table with deltas.

import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { validateUrl, extractLabel, formatNumber } from '../utils.js';
import { testConnection, getTableInfo, getDbSize } from '../db.js';
import type { TableInfo } from '../types.js';

export async function compareWorkflow() {
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
