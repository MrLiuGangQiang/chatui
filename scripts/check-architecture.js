#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { builtinModules } = require('module');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASELINE_PATH = path.join(__dirname, 'architecture-baseline.json');
const SOURCE_ROOTS = ['client', 'server', 'shared'];
const GLOBAL_EXPORT_PATTERN = /(?:window|root(?:\.window)?)\.ChatUI[A-Za-z0-9_$]*\s*=/g;
const WITH_SCOPE_PATTERN = /\bwith\s*\(/g;
const NODE_BUILTINS = new Set(builtinModules.flatMap(name => [name, name.replace(/^node:/, '')]));

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

function literalRequires(source = '') {
  const text = String(source || '');
  const requests = [];
  const isIdentifier = char => /[A-Za-z0-9_$]/.test(char || '');
  const skipTrivia = start => {
    let index = start;
    for (;;) {
      while (/\s/.test(text[index] || '')) index += 1;
      if (text.startsWith('//', index)) {
        index = text.indexOf('\n', index + 2);
        if (index < 0) return text.length;
        continue;
      }
      if (text.startsWith('/*', index)) {
        const end = text.indexOf('*/', index + 2);
        return end < 0 ? text.length : skipTrivia(end + 2);
      }
      return index;
    }
  };
  const quoted = start => {
    const quote = text[start];
    let value = '';
    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (char === '\\') {
        if (index + 1 >= text.length) return null;
        value += text[index + 1];
        index += 1;
      } else if (char === quote) {
        return { value, end: index + 1 };
      } else {
        value += char;
      }
    }
    return null;
  };

  for (let index = 0; index < text.length;) {
    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (['\'', '"', '`'].includes(text[index])) {
      const string = quoted(index);
      index = string?.end || text.length;
      continue;
    }
    if (!text.startsWith('require', index)
      || isIdentifier(text[index - 1])
      || ['.', '/'].includes(text[index - 1])
      || isIdentifier(text[index + 7])) {
      index += 1;
      continue;
    }
    let cursor = skipTrivia(index + 7);
    if (text[cursor] !== '(') {
      index += 7;
      continue;
    }
    cursor = skipTrivia(cursor + 1);
    if (!['\'', '"'].includes(text[cursor])) {
      index += 7;
      continue;
    }
    const request = quoted(cursor);
    if (!request) {
      index += 7;
      continue;
    }
    cursor = skipTrivia(request.end);
    if (text[cursor] === ')') requests.push(request.value);
    index = request.end;
  }
  return requests;
}

function sourceWithoutCommentsAndStrings(source = '') {
  const text = String(source || '');
  let output = '';
  for (let index = 0; index < text.length;) {
    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index + 2);
      output += ' '.repeat((end < 0 ? text.length : end) - index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      const next = end < 0 ? text.length : end + 2;
      output += ' '.repeat(next - index);
      index = next;
      continue;
    }
    if (['\'', '"', '`'].includes(text[index])) {
      const quote = text[index];
      let next = index + 1;
      while (next < text.length) {
        if (text[next] === '\\') next += 2;
        else if (text[next] === quote) { next += 1; break; }
        else next += 1;
      }
      output += ' '.repeat(next - index);
      index = next;
      continue;
    }
    output += text[index];
    index += 1;
  }
  return output;
}

function sourceLayer(root, filePath) {
  const relative = relativePath(root, filePath);
  const first = relative.split('/')[0];
  return SOURCE_ROOTS.includes(first) ? first : '';
}

function checkBoundaries({ root = ROOT } = {}) {
  const files = listJavaScriptFiles(root);
  for (const filePath of files) {
    const layer = sourceLayer(root, filePath);
    const source = fs.readFileSync(filePath, 'utf8');
    const label = relativePath(root, filePath);
    if (layer === 'shared' && /\bprocess\s*\.\s*env\b/.test(sourceWithoutCommentsAndStrings(source))) {
      fail(`${label} reads process.env; shared code must not depend on server configuration.`);
    }
    for (const request of literalRequires(source)) {
      const normalizedRequest = request.replace(/^node:/, '');
      const packageRoot = normalizedRequest.split('/')[0];
      if (['client', 'shared'].includes(layer) && NODE_BUILTINS.has(packageRoot)) {
        fail(`${label} imports Node built-in ${request}; ${layer} code must remain browser-safe.`);
      }
      if (!request.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(filePath), request);
      const targetRelative = relativePath(root, resolved);
      if (targetRelative === '..' || targetRelative.startsWith('../')) {
        fail(`${label} has a relative import outside the repository: ${request}.`);
      }
      const targetLayer = targetRelative.split('/')[0];
      if (layer === 'client' && targetLayer === 'server') fail(`${label} imports server code: ${request}.`);
      if (layer === 'server' && targetLayer === 'client') fail(`${label} imports client code: ${request}.`);
      if (layer === 'shared' && ['client', 'server'].includes(targetLayer)) {
        fail(`${label} imports ${targetLayer} code: ${request}.`);
      }
    }
  }
  return { files: files.length };
}

function checkArchitecture({ root = ROOT, baseline = readBaseline() } = {}) {
  const appPath = path.join(root, 'app.js');
  if (!fs.existsSync(appPath)) fail('root app.js is missing.');
  const appJsBytes = fs.statSync(appPath).size;
  if (appJsBytes > Number(baseline.appJsMaxBytes)) {
    fail(`root app.js grew to ${appJsBytes} bytes (budget: ${baseline.appJsMaxBytes}). Move business logic into client modules instead.`);
  }

  const legacyWithScopes = baseline.legacyWithScopes || {};
  const observedLegacyWithScopes = new Map();
  let globalNamespaceExports = 0;
  let withScopes = 0;
  for (const filePath of listJavaScriptFiles(root)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const relative = relativePath(root, filePath);
    const fileWithScopes = countMatches(source, WITH_SCOPE_PATTERN);
    observedLegacyWithScopes.set(relative, fileWithScopes);
    const allowedWithScopes = Number(legacyWithScopes[relative] || 0);
    if (fileWithScopes > allowedWithScopes) {
      fail(`${relative} contains ${fileWithScopes} with-scopes (legacy allowance: ${allowedWithScopes}). New or expanded with-scopes are forbidden.`);
    }
    withScopes += fileWithScopes;
    globalNamespaceExports += countMatches(source, GLOBAL_EXPORT_PATTERN);
  }

  for (const [relative, expectedCount] of Object.entries(legacyWithScopes)) {
    const observedCount = observedLegacyWithScopes.get(relative) || 0;
    if (observedCount !== Number(expectedCount)) {
      fail(`${relative} contains ${observedCount} with-scopes, but its legacy baseline records ${expectedCount}. Update the baseline when removing recorded legacy debt.`);
    }
  }

  if (globalNamespaceExports > Number(baseline.maxGlobalNamespaceExports)) {
    fail(`browser global namespace exports grew to ${globalNamespaceExports} (budget: ${baseline.maxGlobalNamespaceExports}). Use explicit module composition instead.`);
  }

  const boundaries = checkBoundaries({ root });

  return {
    appJsBytes,
    appJsMaxBytes: Number(baseline.appJsMaxBytes),
    withScopes,
    globalNamespaceExports,
    boundaryFiles: boundaries.files,
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
  literalRequires,
  sourceWithoutCommentsAndStrings,
  checkBoundaries,
  checkArchitecture,
};
