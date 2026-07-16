#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOTS = Object.freeze(['client', 'server', 'shared', 'scripts', 'test']);
const ROOT_FILES = Object.freeze(['app.js', 'server.js']);

function collectJavaScriptFiles(root = ROOT) {
  const files = ROOT_FILES.map(file => path.join(root, file));
  const visit = relativeDir => {
    const directory = path.join(root, relativeDir);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.join(root, relativePath));
    }
  };
  SOURCE_ROOTS.forEach(visit);
  return files.sort();
}

function assertNoBomBeforeShebang(files = collectJavaScriptFiles()) {
  for (const file of files) {
    const bytes = fs.readFileSync(file);
    if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && bytes.subarray(3, 5).toString('utf8') === '#!') {
      throw new Error(`[syntax-check] ${path.relative(ROOT, file)} must not contain a UTF-8 BOM before its shebang.`);
    }
  }
  return files.length;
}

function checkSyntax(files = collectJavaScriptFiles()) {
  assertNoBomBeforeShebang(files);
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status === 0) continue;
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`[syntax-check] ${path.relative(ROOT, file)}\n${output}`);
  }
  return files.length;
}

if (require.main === module) {
  const checked = checkSyntax();
  console.log(`Syntax checks passed for ${checked} JavaScript files.`);
}

module.exports = { ROOT, SOURCE_ROOTS, ROOT_FILES, collectJavaScriptFiles, assertNoBomBeforeShebang, checkSyntax };
