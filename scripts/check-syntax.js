#!/usr/bin/env node
'use strict';

const fs = require('fs');
const Module = require('module');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ROOT_FILES = Object.freeze(['app.js', 'server.js']);
const SOURCE_ROOTS = Object.freeze(['client', 'server', 'shared', 'scripts', 'test']);

function fail(message) {
  throw new Error(`[syntax-check] ${message}`);
}

function listJavaScriptFiles({
  root = ROOT,
  rootFiles = ROOT_FILES,
  sourceRoots = SOURCE_ROOTS,
} = {}) {
  const files = [];
  for (const relativePath of rootFiles) {
    const filePath = path.join(root, relativePath);
    if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
      fail(`required JavaScript file is missing: ${relativePath}.`);
    }
    files.push(filePath);
  }

  for (const relativeRoot of sourceRoots) {
    const sourceRoot = path.join(root, relativeRoot);
    if (!fs.statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory()) {
      fail(`required JavaScript source directory is missing: ${relativeRoot}.`);
    }
    const queue = [sourceRoot];
    while (queue.length) {
      const current = queue.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.isDirectory()) queue.push(entryPath);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(entryPath);
      }
    }
  }

  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

function sourceForCommonJsParse(source) {
  return String(source || '')
    .replace(/^\uFEFF/, '')
    .replace(/^#![^\r\n]*(?:\r?\n|$)/, '');
}

function checkJavaScriptFile(filePath) {
  const source = sourceForCommonJsParse(fs.readFileSync(filePath, 'utf8'));
  try {
    new vm.Script(Module.wrap(source), { filename: filePath, displayErrors: true });
  } catch (error) {
    const detail = String(error?.message || error).split(/\r?\n/, 1)[0];
    fail(`${filePath} is not valid CommonJS JavaScript: ${detail}`);
  }
}

function checkSyntax(options = {}) {
  const root = options.root || ROOT;
  const files = listJavaScriptFiles({ ...options, root });
  files.forEach(checkJavaScriptFile);
  return {
    files: files.length,
    relativeFiles: files.map(filePath => path.relative(root, filePath).replace(/\\/g, '/')),
  };
}

if (require.main === module) {
  const result = checkSyntax();
  console.log(`Syntax checks passed for ${result.files} project JavaScript files.`);
}

module.exports = {
  ROOT,
  ROOT_FILES,
  SOURCE_ROOTS,
  listJavaScriptFiles,
  sourceForCommonJsParse,
  checkJavaScriptFile,
  checkSyntax,
};
