#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ROOT_FILES = Object.freeze(['app.js', 'server.js']);
const SOURCE_ROOTS = Object.freeze(['client', 'server', 'shared', 'scripts', 'test']);
const EXCLUDED_DIRECTORIES = Object.freeze([
  '.git',
  '.nyc_output',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'temp',
  'test-results',
  'vendor',
]);
const EXCLUDED_DIRECTORY_SET = new Set(EXCLUDED_DIRECTORIES.map(name => name.toLowerCase()));

function relativePath(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function isExcludedDirectory(name) {
  return EXCLUDED_DIRECTORY_SET.has(String(name || '').toLowerCase());
}

function collectDirectoryJavaScript(directory, files) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!isExcludedDirectory(entry.name)) collectDirectoryJavaScript(filePath, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.js')) {
      files.push(filePath);
    }
  }
}

function requireControlledPath(absoluteRoot, relativePathname, expectedType) {
  const target = path.join(absoluteRoot, relativePathname);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`[syntax-check] required ${expectedType} is missing: ${relativePathname}.`);
  }
  const valid = expectedType === 'source directory' ? stat.isDirectory() : stat.isFile();
  if (!valid) {
    throw new Error(`[syntax-check] required ${expectedType} has the wrong type: ${relativePathname}.`);
  }
  return target;
}

function listJavaScriptFiles(root = ROOT) {
  const absoluteRoot = path.resolve(root);
  const files = [];

  for (const relativeFile of ROOT_FILES) {
    files.push(requireControlledPath(absoluteRoot, relativeFile, 'root JavaScript file'));
  }

  for (const relativeRoot of SOURCE_ROOTS) {
    const sourceRoot = requireControlledPath(absoluteRoot, relativeRoot, 'source directory');
    collectDirectoryJavaScript(sourceRoot, files);
  }

  return files.sort((left, right) => relativePath(absoluteRoot, left).localeCompare(relativePath(absoluteRoot, right)));
}

function checkFileSyntax(filePath) {
  const result = spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) return result.error.message;
  if (result.status === 0) return '';
  return String(result.stderr || result.stdout || `Node exited with status ${result.status}.`).trim();
}

function checkSyntax({ root = ROOT } = {}) {
  const absoluteRoot = path.resolve(root);
  const files = listJavaScriptFiles(absoluteRoot);
  const failures = [];

  for (const filePath of files) {
    const diagnostic = checkFileSyntax(filePath);
    if (diagnostic) failures.push({ file: relativePath(absoluteRoot, filePath), diagnostic });
  }

  if (failures.length) {
    const details = failures.map(({ file, diagnostic }) => `${file}\n${diagnostic}`).join('\n\n');
    const error = new Error(`[syntax-check] JavaScript syntax check failed for ${failures.length} file(s):\n\n${details}`);
    error.failures = failures;
    throw error;
  }

  return {
    files: files.map(filePath => relativePath(absoluteRoot, filePath)),
    fileCount: files.length,
  };
}

if (require.main === module) {
  try {
    const result = checkSyntax();
    console.log(`JavaScript syntax checks passed for ${result.fileCount} controlled files.`);
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}

module.exports = {
  ROOT,
  ROOT_FILES,
  SOURCE_ROOTS,
  EXCLUDED_DIRECTORIES,
  relativePath,
  isExcludedDirectory,
  requireControlledPath,
  listJavaScriptFiles,
  checkFileSyntax,
  checkSyntax,
};
