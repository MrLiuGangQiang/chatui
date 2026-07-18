#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASELINE_PATH = path.join(__dirname, 'architecture-baseline.json');
const SOURCE_ROOTS = ['client', 'server', 'shared'];
const GLOBAL_EXPORT_PATTERN = /(?:window|root(?:\.window)?)\.ChatUI[A-Za-z0-9_$]*\s*=/g;
const WITH_SCOPE_PATTERN = /\bwith\s*\(/g;

function fail(message) {
  throw new Error(`[architecture-check] ${message}`);
}

function readBaseline(filePath = DEFAULT_BASELINE_PATH) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listJavaScriptFiles(root = ROOT) {
  const files = [];
  for (const relativeRoot of SOURCE_ROOTS) {
    const sourceRoot = path.join(root, relativeRoot);
    if (!fs.existsSync(sourceRoot)) continue;
    const queue = [sourceRoot];
    while (queue.length) {
      const current = queue.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) queue.push(fullPath);
        else if (entry.isFile() && entry.name.endsWith('.js')) files.push(fullPath);
      }
    }
  }
  return files.sort();
}

function countMatches(source, pattern) {
  return (String(source || '').match(pattern) || []).length;
}

function relativePath(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function checkArchitecture({ root = ROOT, baseline = readBaseline() } = {}) {
  const appPath = path.join(root, 'app.js');
  if (!fs.existsSync(appPath)) fail('root app.js is missing.');
  const appJsBytes = fs.statSync(appPath).size;
  if (appJsBytes > Number(baseline.appJsMaxBytes)) {
    fail(`root app.js grew to ${appJsBytes} bytes (budget: ${baseline.appJsMaxBytes}). Move business logic into client modules instead.`);
  }

  const legacyWithScopes = baseline.legacyWithScopes || {};
  let globalNamespaceExports = 0;
  let withScopes = 0;
  for (const filePath of listJavaScriptFiles(root)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const relative = relativePath(root, filePath);
    const fileWithScopes = countMatches(source, WITH_SCOPE_PATTERN);
    const allowedWithScopes = Number(legacyWithScopes[relative] || 0);
    if (fileWithScopes > allowedWithScopes) {
      fail(`${relative} contains ${fileWithScopes} with-scopes (legacy allowance: ${allowedWithScopes}). New or expanded with-scopes are forbidden.`);
    }
    withScopes += fileWithScopes;
    globalNamespaceExports += countMatches(source, GLOBAL_EXPORT_PATTERN);
  }

  if (globalNamespaceExports > Number(baseline.maxGlobalNamespaceExports)) {
    fail(`browser global namespace exports grew to ${globalNamespaceExports} (budget: ${baseline.maxGlobalNamespaceExports}). Use explicit module composition instead.`);
  }

  return {
    appJsBytes,
    appJsMaxBytes: Number(baseline.appJsMaxBytes),
    withScopes,
    globalNamespaceExports,
  };
}

if (require.main === module) {
  const result = checkArchitecture();
  console.log(`Architecture checks passed: app.js ${result.appJsBytes}/${result.appJsMaxBytes} bytes, ${result.withScopes} legacy with-scopes, ${result.globalNamespaceExports} browser global exports.`);
}

module.exports = {
  ROOT,
  DEFAULT_BASELINE_PATH,
  SOURCE_ROOTS,
  GLOBAL_EXPORT_PATTERN,
  WITH_SCOPE_PATTERN,
  readBaseline,
  listJavaScriptFiles,
  countMatches,
  checkArchitecture,
};
