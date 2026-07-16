#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function expectedNodeMajor(root = ROOT) {
  const raw = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
  const match = /^(?:v)?(\d+)(?:\.\d+)?(?:\.\d+)?$/.exec(raw);
  if (!match) throw new Error(`[runtime-check] .nvmrc must declare a major Node version, found: ${raw || '(empty)'}`);
  return Number(match[1]);
}

function parseNodeMajor(version = process.version) {
  const match = /^v?(\d+)\./.exec(String(version || '').trim());
  if (!match) throw new Error(`[runtime-check] invalid Node version: ${version}`);
  return Number(match[1]);
}

function inspectRuntime({ root = ROOT, version = process.version } = {}) {
  const expectedMajor = expectedNodeMajor(root);
  const actualMajor = parseNodeMajor(version);
  return { expectedMajor, actualMajor, matches: actualMajor === expectedMajor };
}

function main() {
  const result = inspectRuntime();
  const strict = process.argv.includes('--strict') || process.env.CI === 'true' || process.env.CHATUI_ENFORCE_NODE_VERSION === '1';
  if (result.matches) {
    console.log(`Runtime check passed: Node ${process.version} matches .nvmrc (${result.expectedMajor}).`);
    return;
  }
  const message = `Node ${process.version} does not match the release runtime Node ${result.expectedMajor} declared in .nvmrc.`;
  if (strict) throw new Error(`[runtime-check] ${message}`);
  console.warn(`[runtime-check] ${message} Local checks continue, but release preflight is strict.`);
}

if (require.main === module) main();

module.exports = { ROOT, expectedNodeMajor, parseNodeMajor, inspectRuntime };
