const fs = require('fs');
const path = require('path');

const RELEASE_FILE_PATTERN = /^v(\d+)\.(\d+)\.(\d+)\.md$/i;
// Keep the v1.10.4 platform-overview baseline inside the served changelog:
// each new release adds a file, and api-contract.test.js requires the baseline
// to remain reachable (it fails when a new release pushes it past the cap).
const MAX_RELEASE_FILES = 200;
const MAX_RELEASE_BYTES = 512 * 1024;

function versionParts(version) {
  const match = String(version || '').match(/^v?(\d+)\.(\d+)\.(\d+)$/i);
  return match ? match.slice(1).map(Number) : [0, 0, 0];
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
}

function readReleaseNotes({ root, fsImpl = fs } = {}) {
  const releaseRoot = path.join(path.resolve(root || process.cwd()), 'docs', 'releases');
  let names;
  try {
    names = fsImpl.readdirSync(releaseRoot);
  } catch {
    return Object.freeze([]);
  }
  const releases = names
    .map(name => {
      const match = String(name).match(RELEASE_FILE_PATTERN);
      if (!match) return null;
      const version = `v${match[1]}.${match[2]}.${match[3]}`;
      const filePath = path.join(releaseRoot, name);
      try {
        const stat = fsImpl.statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_RELEASE_BYTES) return null;
        const sourceBody = fsImpl.readFileSync(filePath, 'utf8').trim();
        if (!sourceBody) return null;
        const firstHeading = sourceBody.match(/^#\s+(.+)$/m);
        // The files retain the original technical record in a collapsible details
        // block; the API serves the curated Chinese summary shown in the dialog.
        const body = sourceBody.replace(/\n?##\s+变更明细[\s\S]*$/u, '').trim();
        return Object.freeze({ version, title: firstHeading ? firstHeading[1].trim() : `ChatUI ${version}`, body });
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => compareVersions(left.version, right.version))
    .slice(0, MAX_RELEASE_FILES);
  return Object.freeze(releases);
}

module.exports = { readReleaseNotes, compareVersions, RELEASE_FILE_PATTERN };
