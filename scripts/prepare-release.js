#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  incrementVersion,
  readVersion,
  syncPackageVersions,
  validateVersion,
  writeVersion,
} = require('./version-source');

function prepareRelease({ root = ROOT, version } = {}) {
  const currentVersion = readVersion({ root });
  const nextVersion = version ? validateVersion(String(version).trim()) : incrementVersion(currentVersion);
  if (nextVersion === currentVersion) {
    throw new Error(`[release-prepare] explicit version ${nextVersion} must differ from the current version`);
  }
  const notesDirectory = path.join(root, 'docs', 'releases');
  const notesPath = path.join(notesDirectory, `v${nextVersion}.md`);
  if (fs.existsSync(notesPath)) {
    throw new Error(`[release-prepare] release notes already exist: docs/releases/v${nextVersion}.md`);
  }

  fs.mkdirSync(notesDirectory, { recursive: true });
  writeVersion({ root, version: nextVersion });
  syncPackageVersions({ root, version: nextVersion });
  fs.writeFileSync(notesPath, `# ChatUI v${nextVersion}\n\n## Changes\n\n- Fill in the user-facing changes for this formal release.\n`, 'utf8');
  return { previousVersion: currentVersion, version: nextVersion, notesPath };
}

if (require.main === module) {
  try {
    const result = prepareRelease({ version: process.argv[2] });
    console.log(`Prepared release v${result.version} (previously v${result.previousVersion}).`);
    console.log(`Update ${path.relative(ROOT, result.notesPath).replace(/\\/g, '/')} before committing.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { prepareRelease };
