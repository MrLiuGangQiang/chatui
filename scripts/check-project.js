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

function dockerCopySources(dockerfile = '') {
  const instructions = String(dockerfile || '').replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+#.*$/, '').trim())
    .filter(line => /^COPY\s+/i.test(line));
  const sources = new Set();
  for (const instruction of instructions) {
    const body = instruction.replace(/^COPY\s+/i, '').trim();
    if (body.startsWith('[')) {
      let values;
      try { values = JSON.parse(body); } catch { fail(`invalid JSON COPY instruction: ${instruction}`); }
      values.slice(0, -1).forEach(value => sources.add(String(value).replace(/^\.\//, '')));
      continue;
    }
    const values = body.split(/\s+/).filter(value => value && !value.startsWith('--'));
    values.slice(0, -1).forEach(value => sources.add(value.replace(/^\.\//, '')));
  }
  return sources;
}

function loadStaticPolicy(root) {
  const filePath = path.join(root, 'server', 'http', 'static.js');
  let resolved;
  try {
    resolved = require.resolve(filePath);
    delete require.cache[resolved];
    return require(resolved);
  } catch (error) {
    fail(`cannot load server/http/static.js: ${error?.message || error}`);
  } finally {
    if (resolved) delete require.cache[resolved];
  }
}

function checkProject({ root = ROOT } = {}) {
  const packageJson = readJson('package.json', root);
  const packageLock = readJson('package-lock.json', root);
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const dockerSources = dockerCopySources(dockerfile);

  if (!packageJson.name) fail('package.json must define a package name.');
  if (!packageJson.private) fail('package.json must declare private: true to prevent accidental npm publishing.');
  if (packageLock.version !== packageJson.version || packageLock.packages?.['']?.version !== packageJson.version) {
    fail(`package-lock.json must match package.json version ${packageJson.version}.`);
  }
  for (const script of ['check:project', 'check:vendor', 'check:architecture', 'check:syntax', 'check', 'test', 'eval:intent', 'start', 'verify:release']) {
    if (!packageJson.scripts?.[script]) fail(`package.json is missing the ${script} script.`);
  }
  for (const file of REQUIRED_STATIC_FILES) {
    if (!fs.existsSync(path.join(root, file))) fail(`required static file is missing: ${file}`);
    if (!dockerSources.has(file)) fail(`Dockerfile must copy required static file: ${file}.`);
  }
  const staticPolicy = loadStaticPolicy(root);
  if (typeof staticPolicy?.isPublicStaticPath !== 'function') fail('server/http/static.js must export isPublicStaticPath.');
  for (const file of REQUIRED_STATIC_FILES) {
    if (!staticPolicy.isPublicStaticPath(`/${file}`)) fail(`server/http/static.js must expose /${file}.`);
  }
  for (const privatePath of ['/package.json', '/../package.json', '/server.js']) {
    if (staticPolicy.isPublicStaticPath(privatePath)) fail(`server/http/static.js must not expose ${privatePath}.`);
  }

  return { version: packageJson.version, staticFiles: REQUIRED_STATIC_FILES.length };
}

if (require.main === module) {
  const result = checkProject();
  console.log(`Project checks passed for v${result.version} (${result.staticFiles} required static files).`);
}

module.exports = { ROOT, REQUIRED_STATIC_FILES, dockerCopySources, loadStaticPolicy, checkProject, readJson };
