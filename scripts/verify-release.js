#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, checkProject, readJson } = require('./check-project');
const { readVersion, validateVersion } = require('./version-source');

function releaseVersion(tag) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(String(tag || ''));
  if (!match) throw new Error('[release-check] expected a tag in vMAJOR.MINOR.PATCH format.');
  return validateVersion(match[1]);
}

function verifyRelease(tag) {
  const expected = releaseVersion(tag);
  const project = checkProject();
  const canonicalVersion = readVersion({ root: ROOT });
  const packageJson = readJson('package.json');
  const packageLock = readJson('package-lock.json');
  if (canonicalVersion !== expected) {
    throw new Error(`[release-check] ${tag} must match version.json (found ${canonicalVersion}).`);
  }
  if (packageJson.version !== canonicalVersion || packageLock.version !== canonicalVersion || packageLock.packages?.['']?.version !== canonicalVersion) {
    throw new Error(`[release-check] package.json and package-lock.json must mirror version.json ${canonicalVersion}.`);
  }
  const notesPath = path.join(ROOT, 'docs', 'releases', `${tag}.md`);
  if (!fs.existsSync(notesPath)) throw new Error(`[release-check] missing release notes: docs/releases/${tag}.md.`);
  const notes = fs.readFileSync(notesPath, 'utf8').trim();
  if (!notes.startsWith(`# ChatUI ${tag}`)) throw new Error(`[release-check] docs/releases/${tag}.md must start with # ChatUI ${tag}.`);
  if (notes.includes('Fill in the user-facing changes for this formal release.')) {
    throw new Error(`[release-check] docs/releases/${tag}.md still contains the release-prepare placeholder.`);
  }
  return { ...project, tag, notesPath };
}

if (require.main === module) {
  const result = verifyRelease(process.argv[2]);
  console.log(`Release metadata is valid for ${result.tag}.`);
}

module.exports = { releaseVersion, verifyRelease };
