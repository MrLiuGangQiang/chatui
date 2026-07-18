#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REQUIRED_STATIC_FILES = ['index.html', 'route.html', 'app.js', 'styles.css', 'favicon.svg'];

function fail(message) {
  throw new Error(`[project-check] ${message}`);
}

function readJson(relativePath, root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

function checkProject({ root = ROOT } = {}) {
  const packageJson = readJson('package.json', root);
  const packageLock = readJson('package-lock.json', root);
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const staticServer = fs.readFileSync(path.join(root, 'server/http/static.js'), 'utf8');

  if (!packageJson.name) fail('package.json must define a package name.');
  if (!packageJson.private) fail('package.json must declare private: true to prevent accidental npm publishing.');
  if (packageLock.version !== packageJson.version || packageLock.packages?.['']?.version !== packageJson.version) {
    fail(`package-lock.json must match package.json version ${packageJson.version}.`);
  }
  for (const script of ['check:project', 'check:architecture', 'check:syntax', 'check', 'test', 'start', 'verify:release']) {
    if (!packageJson.scripts?.[script]) fail(`package.json is missing the ${script} script.`);
  }
  for (const file of REQUIRED_STATIC_FILES) {
    if (!fs.existsSync(path.join(root, file))) fail(`required static file is missing: ${file}`);
  }
  if (!dockerfile.includes('route.html')) fail('Dockerfile must package route.html.');
  if (!staticServer.includes("'/route.html'")) fail('server/http/static.js must expose /route.html.');

  return { version: packageJson.version, staticFiles: REQUIRED_STATIC_FILES.length };
}

if (require.main === module) {
  const result = checkProject();
  console.log(`Project checks passed for v${result.version} (${result.staticFiles} required static files).`);
}

module.exports = { ROOT, REQUIRED_STATIC_FILES, checkProject, readJson };
