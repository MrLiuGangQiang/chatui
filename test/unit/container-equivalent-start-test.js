#!/usr/bin/env node
const assert = require('assert');
const { spawn } = require('child_process');

const port = Number(process.env.TEST_CONTAINER_EQUIV_PORT || 19876);
const env = {
  ...process.env,
  HOST: '0.0.0.0',
  PORT: String(port),
  CHATUI_DISABLE_PID_FILE: '1',
  POSTGRES_URL: '',
};

const child = spawn(process.execPath, ['server.js'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitReady() {
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/version`);
      if (res.ok) return res.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`server did not become ready\nstdout=${stdout}\nstderr=${stderr}`);
}

(async () => {
  try {
    const version = await waitReady();
    assert.strictEqual(version.version, '1.3.4');
    const bad = await fetch(`http://127.0.0.1:${port}/api/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const payload = await bad.json();
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(payload.error?.code, 'INVALID_BASE_URL');
    await sleep(150);
    assert.strictEqual(child.exitCode, null, `server should stay running\nstdout=${stdout}\nstderr=${stderr}`);
    assert.ok(!stderr.includes('failed to write pid file'), stderr);
    console.log('container equivalent start ok');
  } finally {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 1500).unref();
  }
})().catch(err => {
  console.error(err);
  try { child.kill('SIGKILL'); } catch {}
  process.exit(1);
});
