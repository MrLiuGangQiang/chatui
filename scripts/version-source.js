#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  VERSION_FILE,
  VERSION_PATTERN,
  MAX_PATCH,
  parseVersion,
  validateVersion,
  readVersion,
} = require('../server/version-source');

function incrementVersion(value) {
  const parsed = parseVersion(value);
  if (parsed.patch < MAX_PATCH) return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  return `${parsed.major}.${parsed.minor + 1}.0`;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function syncPackageVersions({ root = ROOT, version = readVersion({ root }) } = {}) {
  const canonical = validateVersion(version);
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  packageJson.version = canonical;
  packageLock.version = canonical;
  if (!packageLock.packages || typeof packageLock.packages !== 'object') packageLock.packages = {};
  if (!packageLock.packages[''] || typeof packageLock.packages[''] !== 'object') packageLock.packages[''] = {};
  packageLock.packages[''].version = canonical;
  writeJson(packagePath, packageJson);
  writeJson(lockPath, packageLock);
  return canonical;
}

function writeVersion({ root = ROOT, version } = {}) {
  const canonical = validateVersion(version);
  writeJson(path.join(root, VERSION_FILE), { version: canonical });
  return canonical;
}

if (require.main === module) process.stdout.write(`${readVersion()}\n`);

module.exports = {
  ROOT,
  VERSION_FILE,
  VERSION_PATTERN,
  MAX_PATCH,
  parseVersion,
  validateVersion,
  readVersion,
  incrementVersion,
  syncPackageVersions,
  writeVersion,
};
