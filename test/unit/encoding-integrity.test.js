'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const TEXT_EXTENSIONS = new Set([
  '.css', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.txt', '.yaml', '.yml',
]);
const INVALID_TEXT = /[\uE000-\uF8FF\uFFFD]|\?{3,}/g;

function sourceFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT });
  return output.toString('utf8').split('\0')
    .filter(Boolean)
    .filter(relativePath => TEXT_EXTENSIONS.has(path.extname(relativePath).toLowerCase()))
    .map(relativePath => path.join(ROOT, relativePath))
    .filter(filePath => fs.existsSync(filePath) && fs.statSync(filePath).isFile());
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
