// ─── Compare Table Data Workflow ──────────────────────────────
// This is the deep-comparison feature. Unlike compareWorkflow() which just
// counts rows, this digs into a specific table and shows you WHICH rows
// are different. Includes column-level diffs, batched PK fetching,
// and CSV/JSON export.

import { select, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { statSync, writeFileSync } from 'fs';
import path from 'path';
import { validateUrl, extractLabel, formatNumber, formatCellValue, getDefaultExportDir, timestamp } from '../utils.js';
import { createSql, testConnection, getTableInfo, getPrimaryKeyColumn, getTableColumns, tableExistsInDb } from '../db.js';
import type { TableInfo, DiffResult } from '../types.js';

// ─── Constants ───────────────────────────────────────────────

// How many PKs to fetch at a time from each database.
// This prevents loading millions of PKs into memory at once.
const PK_BATCH_SIZE = 5000;

// Max rows to show in the terminal before asking "show all?"
const DISPLAY_LIMIT = 10;

// Threshold for showing a "large table" warning to the user
const LARGE_TABLE_THRESHOLD = 100000;

// Batch size for column-level comparison of shared rows
const COMPARE_BATCH = 500;

// ─── Helper Functions ────────────────────────────────────────

// Displays a table of rows in the terminal with overflow handling.
// Extracted to avoid repeating the same display logic for DB1 and DB2.
async function displayRowsTable(
  sql: any,
  pks: string[],
  pkColumn: string,
  tableName: string,
  selectColsSql: string,
  displayCols: string[],
  label: string,
  sectionTitle: string,
) {
  console.log(chalk.cyan(`\n  ${sectionTitle} (${formatNumber(pks.length)})`));
  if (pks.length === 0) {
    console.log(chalk.gray('  (none)\n'));
    return [];
  }

  // Only fetch full row data for the first batch we want to display
  const showCount = Math.min(pks.length, DISPLAY_LIMIT);
  const pksToShow = pks.slice(0, showCount);
  const placeholders = pksToShow.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await sql.unsafe(
    `SELECT ${selectColsSql} FROM "${tableName}" WHERE "${pkColumn}"::text IN (${placeholders}) ORDER BY "${pkColumn}"`,
    pksToShow,
  );

  const table = new Table({
    head: displayCols.map((h) => chalk.white.bold(h)),
    style: { head: [], border: ['gray'] },
  });
  for (const row of rows) {
    table.push(displayCols.map((c) => {
      const val = row[c];
      if (val === null) return chalk.gray('NULL');
      if (val instanceof Date) return val.toISOString().substring(0, 19);
      return String(val);
    }));
  }
  console.log(table.toString());

  // If there are more than DISPLAY_LIMIT differences, offer to show the rest
  if (pks.length > DISPLAY_LIMIT) {
    console.log(chalk.gray(`  ... showing ${showCount} of ${formatNumber(pks.length)} rows`));
    const showAll = await confirm({ message: `Show all ${formatNumber(pks.length)} rows?`, default: false });
    if (showAll) {
      const remainingPks = pks.slice(DISPLAY_LIMIT);
      const rPlaceholders = remainingPks.map((_, i) => `$${i + 1}`).join(', ');
      const remainingRows = await sql.unsafe(
        `SELECT ${selectColsSql} FROM "${tableName}" WHERE "${pkColumn}"::text IN (${rPlaceholders}) ORDER BY "${pkColumn}"`,
        remainingPks,
      );
      const rTable = new Table({
        head: displayCols.map((h) => chalk.white.bold(h)),
        style: { head: [], border: ['gray'] },
      });
      for (const row of remainingRows) {
        rTable.push(displayCols.map((c) => {
          const val = row[c];
          if (val === null) return chalk.gray('NULL');
          if (val instanceof Date) return val.toISOString().substring(0, 19);
          return String(val);
        }));
      }
      console.log(rTable.toString());
    }
  }

  return rows;
}

// Fetches all primary key values from a table in batches to avoid loading
// millions of values at once. Returns a Set of stringified PKs.
async function fetchPksBatched(
  sql: any,
  pkColumn: string,
  tableName: string,
  totalRows: number,
  spinner: any,
  label: string,
): Promise<Set<string>> {
  const allPks = new Set<string>();
  let offset = 0;

  while (offset < totalRows) {
    // Show progress for large tables so the user knows we're working
    if (totalRows > PK_BATCH_SIZE) {
      const pct = Math.min(100, Math.round((offset / totalRows) * 100));
      spinner.text = `Fetching PKs from ${label}... ${pct}%`;
    }
    const batch = await sql.unsafe(
      `SELECT "${pkColumn}" FROM "${tableName}" ORDER BY "${pkColumn}" LIMIT ${PK_BATCH_SIZE} OFFSET ${offset}`,
    );
    for (const row of batch) {
      allPks.add(String(row[pkColumn]));
    }
    // If we got fewer rows than the batch size, we've reached the end
    if (batch.length < PK_BATCH_SIZE) break;
    offset += PK_BATCH_SIZE;
  }

  return allPks;
}

// Exports the diff results to a CSV or JSON file for sharing with your team
function exportDiffToFile(diff: DiffResult, format: 'csv' | 'json', outputPath: string) {
  if (format === 'json') {
    // Structured JSON that's easy to parse programmatically
    const jsonData = {
      table: diff.table,
      primaryKey: diff.pkColumn,
      databases: { db1: diff.label1, db2: diff.label2 },
      summary: {
        onlyInDb1: diff.onlyInDb1.length,
        onlyInDb2: diff.onlyInDb2.length,
        modified: diff.modified.length,
        totalDifferences: diff.onlyInDb1.length + diff.onlyInDb2.length + diff.modified.length,
      },
      onlyInDb1: diff.onlyInDb1,
      onlyInDb2: diff.onlyInDb2,
      modified: diff.modified,
    };
    writeFileSync(outputPath, JSON.stringify(jsonData, null, 2));
  } else {
    // CSV format — one section per diff type, easy to open in Excel
    const lines: string[] = [];
    lines.push(`# Diff Report: ${diff.table}`);
    lines.push(`# DB1: ${diff.label1}, DB2: ${diff.label2}`);
    lines.push('');

    // Rows only in DB1
    lines.push(`# Rows only in ${diff.label1} (${diff.onlyInDb1.length})`);
    if (diff.onlyInDb1.length > 0) {
      lines.push(diff.columns.join(','));
      for (const row of diff.onlyInDb1) {
        lines.push(diff.columns.map((c) => {
          const val = formatCellValue(row[c]);
          return val.includes(',') || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
        }).join(','));
      }
    }
    lines.push('');

    // Rows only in DB2
    lines.push(`# Rows only in ${diff.label2} (${diff.onlyInDb2.length})`);
    if (diff.onlyInDb2.length > 0) {
      lines.push(diff.columns.join(','));
      for (const row of diff.onlyInDb2) {
        lines.push(diff.columns.map((c) => {
          const val = formatCellValue(row[c]);
          return val.includes(',') || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
        }).join(','));
      }
    }
    lines.push('');

    // Modified rows
    lines.push(`# Modified rows (${diff.modified.length})`);
    if (diff.modified.length > 0) {
      lines.push('pk,column,db1_value,db2_value');
      for (const mod of diff.modified) {
        const esc = (v: string) => v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
        lines.push([mod.pk, mod.column, esc(mod.db1Value), esc(mod.db2Value)].join(','));
      }
    }

    writeFileSync(outputPath, lines.join('\n'));
  }
}

// ─── Main Workflow ───────────────────────────────────────────

export async function compareTableDataWorkflow() {
  console.log(chalk.cyan('\n  🔎 Compare Table Data\n'));

  // Step 1: Ask the user for two database URLs to compare.
  const url1 = await input({
    message: 'Paste database URL #1:',
    validate: validateUrl,
  });
  const label1 = await input({
    message: 'Label for this DB:',
    default: extractLabel(url1),
  });

  const url2 = await input({
    message: 'Paste database URL #2:',
    validate: validateUrl,
  });
  const label2 = await input({
    message: 'Label for this DB:',
    default: extractLabel(url2),
  });

  // Step 2: Test both connections before doing anything heavy.
  const spinner = ora('Testing connections...').start();
  const test1 = await testConnection(url1);
  if (!test1.ok) {
    spinner.fail(`Failed to connect to ${label1}: ${test1.error}`);
    return;
  }
  const test2 = await testConnection(url2);
  if (!test2.ok) {
    spinner.fail(`Failed to connect to ${label2}: ${test2.error}`);
    return;
  }
  spinner.succeed('Both databases connected');

  // Step 3: Get the list of tables from DB1 so the user can pick one.
  const infoSpinner = ora('Fetching tables...').start();
  let tableInfo: TableInfo[];
  try {
    tableInfo = await getTableInfo(url1);
    infoSpinner.succeed(`Found ${tableInfo.length} tables in ${label1}`);
  } catch (err: any) {
    infoSpinner.fail(`Error fetching tables: ${err.message}`);
    return;
  }

  if (tableInfo.length === 0) {
    console.log(chalk.yellow('  No tables found in the database.\n'));
    return;
  }

  // Step 4: Let the user pick which table to compare.
  const selectedTable = await select({
    message: 'Select a table to compare:',
    choices: tableInfo.map((t) => ({
      name: `${t.name}  (${formatNumber(t.rows)} rows in ${label1})`,
      value: t.name,
    })),
  });

  // Step 5: Make sure the selected table actually exists in DB2.
  const existsSpinner = ora(`Checking table in ${label2}...`).start();
  const existsInDb2 = await tableExistsInDb(url2, selectedTable);
  if (!existsInDb2) {
    existsSpinner.fail(`Table "${selectedTable}" exists in ${label1} but not in ${label2}. Cannot compare.`);
    return;
  }
  existsSpinner.succeed(`Table "${selectedTable}" found in both databases`);

  // Step 6: Find the primary key column for this table.
  const pkSpinner = ora('Detecting primary key...').start();
  const pkColumn = await getPrimaryKeyColumn(url1, selectedTable);
  if (!pkColumn) {
    pkSpinner.fail(`Table "${selectedTable}" has no primary key or unique column`);
    console.log(chalk.yellow('  Row-level comparison requires a primary key to match rows between databases.'));
    console.log(chalk.gray(`  Tip: Add a primary key with: ALTER TABLE ${selectedTable} ADD COLUMN id SERIAL PRIMARY KEY;\n`));
    return;
  }
  pkSpinner.succeed(`Primary key: ${pkColumn}`);

  // Step 7: Get column names for display.
  const columns = await getTableColumns(url1, selectedTable);
  const displayCols = columns.length > 6 ? columns.slice(0, 6) : columns;
  const selectColsSql = displayCols.map((c) => `"${c}"`).join(', ');
  const allColsSql = columns.map((c) => `"${c}"`).join(', ');

  // Step 7.5: Large table warning
  const db1Rows = tableInfo.find((t) => t.name === selectedTable)?.rows ?? 0;
  if (db1Rows > LARGE_TABLE_THRESHOLD) {
    console.log(chalk.yellow(`\n  ⚠ This table has ${formatNumber(db1Rows)} rows. Comparison may take a while.`));
    const proceed = await confirm({ message: 'Continue?', default: true });
    if (!proceed) return;
  }

  // Step 8: The actual diff
  const diffSpinner = ora('Comparing row data...').start();
  try {
    const sql1 = createSql(url1);
    const sql2 = createSql(url2);

    // Fetch PKs in batches for performance
    const pkSet1 = await fetchPksBatched(sql1, pkColumn, selectedTable, db1Rows, diffSpinner, label1);
    const db2CountRes = await sql2.unsafe(`SELECT COUNT(*)::int as count FROM "${selectedTable}"`);
    const db2Rows = db2CountRes[0].count;
    const pkSet2 = await fetchPksBatched(sql2, pkColumn, selectedTable, db2Rows, diffSpinner, label2);

    diffSpinner.text = 'Computing differences...';

    // Find PKs that exist in DB1 but NOT in DB2
    const onlyIn1: string[] = [];
    for (const pk of pkSet1) {
      if (!pkSet2.has(pk)) onlyIn1.push(pk);
    }

    // Find PKs that exist in DB2 but NOT in DB1
    const onlyIn2: string[] = [];
    for (const pk of pkSet2) {
      if (!pkSet1.has(pk)) onlyIn2.push(pk);
    }

    // Step 8.5: Column-level diff
    diffSpinner.text = 'Checking for column-level differences...';
    const sharedPks: string[] = [];
    for (const pk of pkSet1) {
      if (pkSet2.has(pk)) sharedPks.push(pk);
    }

    const modified: { pk: string; column: string; db1Value: string; db2Value: string }[] = [];

    for (let i = 0; i < sharedPks.length; i += COMPARE_BATCH) {
      if (sharedPks.length > COMPARE_BATCH) {
        const pct = Math.min(100, Math.round((i / sharedPks.length) * 100));
        diffSpinner.text = `Comparing column values... ${pct}%`;
      }

      const batchPks = sharedPks.slice(i, i + COMPARE_BATCH);
      const placeholders = batchPks.map((_, idx) => `$${idx + 1}`).join(', ');

      const rows1 = await sql1.unsafe(
        `SELECT ${allColsSql} FROM "${selectedTable}" WHERE "${pkColumn}"::text IN (${placeholders}) ORDER BY "${pkColumn}"`,
        batchPks,
      );
      const rows2 = await sql2.unsafe(
        `SELECT ${allColsSql} FROM "${selectedTable}" WHERE "${pkColumn}"::text IN (${placeholders}) ORDER BY "${pkColumn}"`,
        batchPks,
      );

      const map2 = new Map<string, any>();
      for (const row of rows2) {
        map2.set(String(row[pkColumn]), row);
      }

      for (const row1 of rows1) {
        const pkVal = String(row1[pkColumn]);
        const row2 = map2.get(pkVal);
        if (!row2) continue;

        for (const col of columns) {
          const val1 = formatCellValue(row1[col]);
          const val2 = formatCellValue(row2[col]);
          if (val1 !== val2) {
            modified.push({ pk: pkVal, column: col, db1Value: val1, db2Value: val2 });
          }
        }
      }
    }

    const totalDiffs = onlyIn1.length + onlyIn2.length + modified.length;
    diffSpinner.succeed(`Comparison complete — ${formatNumber(totalDiffs)} differences found`);

    // Step 9: Display the results
    await displayRowsTable(sql1, onlyIn1, pkColumn, selectedTable, selectColsSql, displayCols, label1, `Rows only in ${label1}`);
    await displayRowsTable(sql2, onlyIn2, pkColumn, selectedTable, selectColsSql, displayCols, label2, `Rows only in ${label2}`);

    // --- Modified rows ---
    console.log(chalk.cyan(`\n  Modified rows — same PK, different values (${formatNumber(modified.length)})`));
    if (modified.length === 0) {
      console.log(chalk.gray('  (none)\n'));
    } else {
      const showModCount = Math.min(modified.length, DISPLAY_LIMIT);
      const modTable = new Table({
        head: [pkColumn, 'Column', `${label1} value`, `${label2} value`].map((h) => chalk.white.bold(h)),
        style: { head: [], border: ['gray'] },
      });
      for (let i = 0; i < showModCount; i++) {
        const m = modified[i];
        modTable.push([m.pk, m.column, chalk.red(m.db1Value), chalk.green(m.db2Value)]);
      }
      console.log(modTable.toString());

      if (modified.length > DISPLAY_LIMIT) {
        console.log(chalk.gray(`  ... showing ${showModCount} of ${formatNumber(modified.length)} modifications`));
        const showAllMod = await confirm({ message: `Show all ${formatNumber(modified.length)} modifications?`, default: false });
        if (showAllMod) {
          const rModTable = new Table({
            head: [pkColumn, 'Column', `${label1} value`, `${label2} value`].map((h) => chalk.white.bold(h)),
            style: { head: [], border: ['gray'] },
          });
          for (let i = DISPLAY_LIMIT; i < modified.length; i++) {
            const m = modified[i];
            rModTable.push([m.pk, m.column, chalk.red(m.db1Value), chalk.green(m.db2Value)]);
          }
          console.log(rModTable.toString());
        }
      }
    }

    // Step 10: Summary
    console.log(chalk.cyan('\n  Summary:'));
    console.log(`  ● ${formatNumber(onlyIn1.length)} rows only in ${label1}`);
    console.log(`  ● ${formatNumber(onlyIn2.length)} rows only in ${label2}`);
    console.log(`  ● ${formatNumber(modified.length)} rows with column differences`);
    if (totalDiffs === 0) {
      console.log(chalk.green(`  ✓ Table "${selectedTable}" is in sync!\n`));
    } else {
      console.log(chalk.yellow(`  ● ${selectedTable} table has ${formatNumber(totalDiffs)} total differences\n`));
    }

    if (columns.length > 6) {
      console.log(chalk.gray(`  Note: Showing ${displayCols.length} of ${columns.length} columns in missing-row tables. All columns were checked for modifications.\n`));
    }

    // Step 11: Export option
    if (totalDiffs > 0) {
      const exportChoice = await select({
        message: 'Export diff results?',
        choices: [
          { name: 'No', value: 'none' },
          { name: 'Export as JSON', value: 'json' },
          { name: 'Export as CSV', value: 'csv' },
        ],
      });

      if (exportChoice !== 'none') {
        const exportSpinner = ora('Preparing export data...').start();

        let allRowsDb1: Record<string, any>[] = [];
        let allRowsDb2: Record<string, any>[] = [];

        if (onlyIn1.length > 0) {
          for (let i = 0; i < onlyIn1.length; i += COMPARE_BATCH) {
            const batch = onlyIn1.slice(i, i + COMPARE_BATCH);
            const ph = batch.map((_, idx) => `$${idx + 1}`).join(', ');
            const rows = await sql1.unsafe(
              `SELECT ${allColsSql} FROM "${selectedTable}" WHERE "${pkColumn}"::text IN (${ph}) ORDER BY "${pkColumn}"`,
              batch,
            );
            allRowsDb1.push(...rows);
          }
        }

        if (onlyIn2.length > 0) {
          for (let i = 0; i < onlyIn2.length; i += COMPARE_BATCH) {
            const batch = onlyIn2.slice(i, i + COMPARE_BATCH);
            const ph = batch.map((_, idx) => `$${idx + 1}`).join(', ');
            const rows = await sql2.unsafe(
              `SELECT ${allColsSql} FROM "${selectedTable}" WHERE "${pkColumn}"::text IN (${ph}) ORDER BY "${pkColumn}"`,
              batch,
            );
            allRowsDb2.push(...rows);
          }
        }

        const diffResult: DiffResult = {
          table: selectedTable, pkColumn, label1, label2,
          onlyInDb1: allRowsDb1, onlyInDb2: allRowsDb2, modified, columns,
        };

        const ext = exportChoice === 'json' ? '.json' : '.csv';
        const exportDir = getDefaultExportDir();
        const exportFile = path.join(exportDir, `diff_${selectedTable}_${timestamp()}${ext}`);

        exportDiffToFile(diffResult, exportChoice as 'csv' | 'json', exportFile);

        const fileSize = statSync(exportFile).size;
        const sizeStr = fileSize > 1048576
          ? `${(fileSize / 1048576).toFixed(1)} MB`
          : `${(fileSize / 1024).toFixed(1)} KB`;
        exportSpinner.succeed(`Exported to: ${exportFile} (${sizeStr})`);
      }
    }

    // Clean up database connections
    await sql1.end();
    await sql2.end();
  } catch (err: any) {
    diffSpinner.fail('Error comparing table data');
    console.log(chalk.red(`  ${err.message}\n`));
  }
}
