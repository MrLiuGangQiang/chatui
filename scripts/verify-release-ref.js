#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');

function git(args) {
  return String(execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim();
}

function verifyReleaseRef(tag, mainRef = 'origin/main') {
  if (!/^v\d+\.\d+\.\d+$/.test(String(tag || ''))) throw new Error('release tag must match vMAJOR.MINOR.PATCH');
  if (git(['cat-file', '-t', tag]) !== 'tag') throw new Error(`${tag} must be an annotated tag`);
  const tagCommit = git(['rev-list', '-n', '1', tag]);
  const mainCommit = git(['rev-parse', `${mainRef}^{commit}`]);
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', tagCommit, mainCommit], { stdio: 'ignore' });
  } catch {
    throw new Error(`${tag} (${tagCommit}) is not contained in ${mainRef} (${mainCommit})`);
  }
  return { tag, tagCommit, mainRef, mainCommit };
}

if (require.main === module) {
  try {
    const result = verifyReleaseRef(process.argv[2], process.argv[3] || 'origin/main');
    console.log(`Release ref is valid: ${result.tag} -> ${result.tagCommit} in ${result.mainRef}.`);
  } catch (error) {
    console.error(`[release-ref] ${error.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = { verifyReleaseRef };
