#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { readVersion } = require('./version-source');

const ROOT = path.resolve(__dirname, '..');
const REQUIRED_STATIC_FILES = ['index.html', 'pages/route.html', 'pages/files.html', 'app.js', 'styles.css', 'favicon.svg'];
const REQUIRED_RUNTIME_FILES = ['server.js'];
const REQUIRED_DOCUMENTATION_FILES = ['docs/architecture.md', 'docs/development.md'];
const REQUIRED_PROJECT_FILES = ['version.json', 'package.json', 'package-lock.json', 'Dockerfile', 'server/http/static.js'];
const REQUIRED_SCRIPTS = [
  'check:project',
  'check:architecture',
  'check:syntax',
  'check',
  'test',
  'eval:intent',
  'start',
  'verify:release',
  'verify:release-ref',
  'verify:image',
  'identity',
  'release:prepare',
  'preview:release',
];

function fail(message) {
  throw new Error(`[project-check] ${message}`);
}

function readJson(relativePath, root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function requireRegularFile(root, relativePath, description = 'required file') {
  const filePath = path.join(root, relativePath);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    fail(`${description} is missing: ${relativePath}`);
  }
  if (!stat.isFile()) fail(`${description} must be a regular file: ${relativePath}`);
  return filePath;
}

function checkProject({ root = ROOT } = {}) {
  for (const file of REQUIRED_PROJECT_FILES) requireRegularFile(root, file, 'required project file');
  for (const file of REQUIRED_STATIC_FILES) requireRegularFile(root, file, 'required static file');
  for (const file of REQUIRED_RUNTIME_FILES) requireRegularFile(root, file, 'required runtime file');
  for (const file of REQUIRED_DOCUMENTATION_FILES) requireRegularFile(root, file, 'required documentation file');

  const packageJson = readJson('package.json', root);
  const packageLock = readJson('package-lock.json', root);
  const version = readVersion({ root });
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const staticServer = fs.readFileSync(path.join(root, 'server/http/static.js'), 'utf8');

  if (typeof packageJson.name !== 'string' || !packageJson.name.trim()) fail('package.json must define a non-empty package name.');
  if (packageJson.private !== true) fail('package.json must declare private: true to prevent accidental npm publishing.');
  if (packageJson.version !== version) {
    fail(`package.json version ${packageJson.version} must match canonical ${version} from version.json.`);
  }
  if (packageLock.version !== version || packageLock.packages?.['']?.version !== version) {
    fail(`package-lock.json must match canonical version ${version} from version.json.`);
  }
  for (const script of REQUIRED_SCRIPTS) {
    if (typeof packageJson.scripts?.[script] !== 'string' || !packageJson.scripts[script].trim()) {
      fail(`package.json must define a non-empty ${script} script.`);
    }
  }
  if (!dockerfile.includes('COPY pages ./pages')) fail('Dockerfile must package the standalone pages directory.');
  if (!staticServer.includes("'/pages/'")) fail('server/http/static.js must expose the standalone pages directory.');

  return {
    version,
    staticFiles: REQUIRED_STATIC_FILES.length,
    runtimeFiles: REQUIRED_RUNTIME_FILES.length,
    documentationFiles: REQUIRED_DOCUMENTATION_FILES.length,
  };
}

if (require.main === module) {
  const result = checkProject();
  console.log(`Project checks passed for v${result.version} (${result.staticFiles} static files, ${result.runtimeFiles} runtime files, ${result.documentationFiles} documentation files).`);
}

module.exports = {
  ROOT,
  REQUIRED_STATIC_FILES,
  REQUIRED_RUNTIME_FILES,
  REQUIRED_DOCUMENTATION_FILES,
  REQUIRED_PROJECT_FILES,
  REQUIRED_SCRIPTS,
  checkProject,
  readJson,
  requireRegularFile,
};
