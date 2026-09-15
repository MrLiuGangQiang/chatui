#!/usr/bin/env node
'use strict';

// Single-process orchestrator for the full gate. Runs project, architecture, and
// syntax checks in this process, then spawns the test runner directly with node
// (never through npm) to avoid Windows npm startup overhead between every step.
// The runner shards the full suite across parallel child processes, so the whole
// gate is a commit/release-time action, not a per-edit one.
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { checkProject } = require('./check-project');
const { checkArchitecture } = require('./check-architecture');
const { checkSyntax } = require('./check-syntax');

const STREAMING_SUITES = [
  'chat-job-event-stream',
  'chat-stream-integrity',
  'chat-stream-parser',
  'responses-web-search-stream',
  'server-job-event-stream',
  'server-job-event-backpressure',
  'session-image-batch-cleanup',
  'chat-job-sse-capacity',
];

function runNode(args, label) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`[check-all] ${label} failed with exit code ${result.status}.`);
    process.exit(result.status);
  }
}

function main() {
  const project = checkProject();
  console.log(`Project checks passed for v${project.version} (${project.staticFiles} static files, ${project.runtimeFiles} runtime files, ${project.documentationFiles} documentation files).`);
  const architecture = checkArchitecture();
  console.log(`Architecture checks passed: app.js ${architecture.appJsBytes}/${architecture.appJsMaxBytes} bytes, ${architecture.withScopes} legacy with-scopes, ${architecture.globalNamespaceExports} browser global exports.`);
  const syntax = checkSyntax();
  console.log(`JavaScript syntax checks passed for ${syntax.fileCount} controlled files.`);
  runNode([path.join(ROOT, 'test', 'run-tests.js')], 'npm test');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = { main, STREAMING_SUITES };
