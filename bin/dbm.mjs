#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'index.ts');

execFileSync(path.join(root, 'node_modules', '.bin', 'tsx'), [entry], {
  stdio: 'inherit',
  cwd: root,
});
