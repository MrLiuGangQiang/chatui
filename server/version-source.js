'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERSION_FILE = 'version.json';
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_PATCH = 99;

function fail(message) {
  throw new Error(`[version] ${message}`);
}

function parseVersion(value) {
  const text = String(value == null ? '' : value).trim();
  const match = VERSION_PATTERN.exec(text);
  if (!match) fail(`version must match a.b.c with non-negative integers: ${text || '(empty)'}`);
  const parts = match.slice(1).map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) fail(`version components must be safe integers: ${text}`);
  if (parts[2] > MAX_PATCH) fail(`patch component must be between 0 and ${MAX_PATCH}: ${text}`);
  return Object.freeze({ major: parts[0], minor: parts[1], patch: parts[2], version: text });
}

function validateVersion(value) {
  return parseVersion(value).version;
}

function readVersion({ root = ROOT } = {}) {
  const versionPath = path.join(root, VERSION_FILE);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
  } catch (error) {
    fail(`cannot read ${VERSION_FILE}: ${error.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail(`${VERSION_FILE} must contain an object.`);
  return validateVersion(data.version);
}

module.exports = {
  ROOT,
  VERSION_FILE,
  VERSION_PATTERN,
  MAX_PATCH,
  parseVersion,
  validateVersion,
  readVersion,
};
