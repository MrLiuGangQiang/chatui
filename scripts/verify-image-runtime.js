#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const { identity: localIdentity } = require('./runtime-identity');

function command(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', stdio: 'pipe', ...options });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${file} ${args.join(' ')} failed${details ? `:\n${details}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function optionValue(args, name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

async function waitForIdentity(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/version`, { cache: 'no-store' });
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw new Error(`container did not become ready: ${lastError?.message || 'timeout'}`);
}

async function verifyImageRuntime({
  image,
  expectedVersion = localIdentity.version,
  expectedGitSha = localIdentity.gitSha,
  expectedSourceRevision = localIdentity.sourceRevision,
  port = Number(process.env.CHATUI_VERIFY_PORT || 18765),
  docker = process.env.DOCKER_CLI || 'docker',
} = {}) {
  if (!image) throw new Error('--image is required');
  const safeName = String(image).replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(-45);
  const containerName = `chatui-verify-${process.pid}-${safeName}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  let started = false;
  try {
    command(docker, ['run', '--rm', '-d', '--name', containerName, '-p', `127.0.0.1:${port}:8765`, image]);
    started = true;
    const remoteIdentity = await waitForIdentity(baseUrl);
    assert.strictEqual(remoteIdentity.version, expectedVersion, 'container version differs from the release candidate');
    assert.strictEqual(remoteIdentity.gitSha, expectedGitSha, 'container Git SHA differs from the release candidate');
    assert.strictEqual(remoteIdentity.sourceRevision, expectedSourceRevision, 'container runtime files differ from the local release candidate');
    assert.strictEqual(remoteIdentity.dirty, false, 'published container must never identify as a dirty workspace');
    assert.strictEqual(remoteIdentity.mode, 'image', 'published container must identify as an image build');

    const labelRevision = command(docker, ['image', 'inspect', image, '--format', '{{ index .Config.Labels "org.opencontainers.image.revision" }}']);
    assert.strictEqual(labelRevision, expectedGitSha, 'OCI revision label differs from the release candidate');

    const homeResponse = await fetch(`${baseUrl}/`, { cache: 'no-store' });
    assert.strictEqual(homeResponse.status, 200);
    const home = await homeResponse.text();
    const bundleMatch = home.match(/\.\/assets\/chatui\.bundle\.js\?v=([a-f0-9]{32})/);
    assert.ok(bundleMatch, 'container homepage must expose its content-addressed JavaScript bundle');
    const bundleResponse = await fetch(`${baseUrl}/assets/chatui.bundle.js?v=${bundleMatch[1]}`, { cache: 'no-store' });
    assert.strictEqual(bundleResponse.status, 200);
    assert.strictEqual(String(bundleResponse.headers.get('etag') || '').replace(/"/g, ''), bundleMatch[1]);
    const bundle = await bundleResponse.text();
    assert.ok(bundle.includes('dispatch_contract.v1'), 'container bundle is missing the execution plan protocol');
    assert.ok(bundle.includes('g.__displayItem=u'), 'container bundle is missing the stream completion ownership fix');
    return remoteIdentity;
  } finally {
    if (started) {
      try { execFileSync(docker, ['stop', '--time', '3', containerName], { stdio: 'ignore' }); } catch {}
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const remoteIdentity = await verifyImageRuntime({
    image: optionValue(args, '--image'),
    expectedVersion: optionValue(args, '--version', localIdentity.version),
    expectedGitSha: optionValue(args, '--git-sha', localIdentity.gitSha),
    expectedSourceRevision: optionValue(args, '--source-revision', localIdentity.sourceRevision),
    port: Number(optionValue(args, '--port', String(process.env.CHATUI_VERIFY_PORT || 18765))),
  });
  console.log(`Verified image runtime ${remoteIdentity.version} ${remoteIdentity.gitSha} ${remoteIdentity.sourceRevision}`);
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { command, optionValue, waitForIdentity, verifyImageRuntime };
