#!/usr/bin/env node
'use strict';

const { ROOT, checkProject, readJson } = require('./check-project');

function releaseVersion(tag) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(String(tag || ''));
  if (!match) throw new Error('[release-check] expected a tag in vMAJOR.MINOR.PATCH format.');
  return match[1];
}

function verifyRelease(tag, { root = ROOT } = {}) {
  const expected = releaseVersion(tag);
  const project = checkProject({ root });
  const packageJson = readJson('package.json', root);
  const packageLock = readJson('package-lock.json', root);
  if (packageJson.version !== expected || packageLock.version !== expected || packageLock.packages?.['']?.version !== expected) {
    throw new Error(`[release-check] ${tag} must match package.json and package-lock.json (found ${packageJson.version}).`);
  }
  return { ...project, tag };
}

if (require.main === module) {
  const result = verifyRelease(process.argv[2]);
  console.log(`Release metadata is valid for ${result.tag}.`);
}

module.exports = { releaseVersion, verifyRelease };
