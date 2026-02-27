#!/usr/bin/env npx tsx

// ─── DB Manager — Entry Point ────────────────────────────────
// This is the main entry point for the CLI. It only handles:
// 1. Showing the banner
// 2. Checking prerequisites
// 3. The main menu loop
//
// All actual logic lives in the src/ modules:
//   src/utils.ts          — Pure utility functions
//   src/db.ts             — Database connection helpers
//   src/shell.ts          — Shell commands & PG binary resolution
//   src/workflows/*.ts    — Individual workflow implementations

import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { showBanner } from './src/utils.js';
import { checkPrerequisites } from './src/shell.js';
import { compareWorkflow } from './src/workflows/compare.js';
import { compareTableDataWorkflow } from './src/workflows/compareData.js';
import { exportWorkflow } from './src/workflows/export.js';
import { importWorkflow } from './src/workflows/import.js';
import { inspectWorkflow } from './src/workflows/inspect.js';

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
          { name: '🔎  Compare Table Data', value: 'compareData' },
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
        case 'compareData':
          await compareTableDataWorkflow();
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

// Only run main() when this file is executed directly (not imported by tests)
const isDirectRun = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('dbm.mjs');
if (isDirectRun) {
  main();
}
