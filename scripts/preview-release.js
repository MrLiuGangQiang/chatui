#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const { identity } = require('./runtime-identity');
const { command, verifyImageRuntime } = require('./verify-image-runtime');

function git(args) {
  return command('git', args, { cwd: process.cwd() });
}

async function previewRelease() {
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  if (status) throw new Error('release preview requires a clean committed worktree');
  const gitSha = git(['rev-parse', 'HEAD']);
  if (identity.gitSha !== gitSha || identity.dirty) throw new Error('runtime identity does not match the clean candidate commit');
  const image = `chatui-release-candidate:${gitSha.slice(0, 12)}`;
  const args = [
    'build', '--pull',
    '--build-arg', `CHATUI_VERSION=${identity.version}`,
    '--build-arg', `CHATUI_BUILD_SHA=${gitSha}`,
    '--build-arg', `CHATUI_SOURCE_REVISION=${identity.sourceRevision}`,
    '--tag', image,
    '.',
  ];
  const build = spawnSync(process.env.DOCKER_CLI || 'docker', args, { encoding: 'utf8', stdio: 'inherit' });
  if (build.status !== 0) throw new Error('candidate Docker build failed');
  await verifyImageRuntime({ image, expectedVersion: identity.version, expectedGitSha: gitSha, expectedSourceRevision: identity.sourceRevision });
  console.log(`Release preview passed for ${identity.version} at ${gitSha} (${identity.sourceRevision}).`);
}

if (require.main === module) previewRelease().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { previewRelease };
