#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status === 0) return;
  throw new Error(`[release-preflight] failed: ${[command, ...args].join(' ')}`);
}

function main(argv = process.argv.slice(2), { runCommand = run, logger = console } = {}) {
  const tag = argv[0];
  if (!tag) throw new Error('[release-preflight] expected a release tag, for example v1.4.1.');
  runCommand(process.execPath, ['scripts/check-runtime.js', '--strict']);
  runCommand(process.execPath, ['scripts/verify-release.js', tag]);
  runCommand('npm', ['run', 'check']);
  logger.log(`Release preflight passed for ${tag}.`);
}

if (require.main === module) main();

module.exports = { ROOT, run, main };
