'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TEXT_EXTENSIONS = new Set([
  '.css', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.txt', '.yaml', '.yml',
]);
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'vendor']);
const INVALID_TEXT = /[\uE000-\uF8FF\uFFFD]|\?{3,}/g;

function sourceFiles(directory = ROOT) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) {
      return IGNORED_DIRECTORIES.has(entry.name)
        ? []
        : sourceFiles(path.join(directory, entry.name));
    }
    const filePath = path.join(directory, entry.name);
    return entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ? [filePath]
      : [];
  });
}

function lineNumberAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function testTrackedTextHasNoMojibakePlaceholders() {
  const failures = [];
  for (const filePath of sourceFiles()) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(INVALID_TEXT)) {
      failures.push(`${path.relative(ROOT, filePath)}:${lineNumberAt(source, match.index)} ${JSON.stringify(match[0])}`);
    }
  }
  assert.deepStrictEqual(failures, [], `发现疑似乱码或问号占位：\n${failures.join('\n')}`);
}

module.exports = [
  testTrackedTextHasNoMojibakePlaceholders,
];
