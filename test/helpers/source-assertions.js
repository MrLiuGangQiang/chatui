const fs = require('fs');
const path = require('path');
const assert = require('assert');

function readSource(relativePath, rootDir = path.join(__dirname, '../..')) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function assertIncludes(source, needle, message) {
  assert.ok(String(source).includes(needle), message || `Expected source to include: ${needle}`);
}

function assertNotIncludes(source, needle, message) {
  assert.ok(!String(source).includes(needle), message || `Expected source not to include: ${needle}`);
}

function assertInOrder(source, first, second, message) {
  const text = String(source);
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  assert.ok(firstIndex >= 0 && secondIndex > firstIndex, message || `Expected ${first} to appear before ${second}`);
}

module.exports = Object.freeze({ readSource, assertIncludes, assertNotIncludes, assertInOrder });
