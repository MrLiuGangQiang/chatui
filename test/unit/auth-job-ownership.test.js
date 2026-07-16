const assert = require('assert');

const { createApp } = require('../../server/app');
const { createRuntimeConfig } = require('../../server/config/runtime-config');
const { createAuthPolicy } = require('../../server/security/auth');
const { makeChatJob } = require('../../server/jobs/chat');
const { assignJobOwner } = require('../../server/jobs/ownership');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function managedAuthPolicy() {
  const config = createRuntimeConfig({
    CHATUI_DEPLOYMENT_MODE: 'managed',
    CHATUI_AUTH_TOKENS: 'alice:alice-secret-token,bob:bob-secret-token',
  });
  return createAuthPolicy(config);
}

function authorization(principal) {
  return { Authorization: `Bearer ${principal}-secret-token` };
}

function seedOwnedJob(store, id = 'chatjob-owned-by-alice') {
  const job = makeChatJob(id, 'https://api.example.com/v1', '', { model: 'test', messages: [] }, { stream: false });
  assignJobOwner(job, { authRequired: true, principal: { id: 'alice' } });
  job.status = 'running';
  job.compactStream = false;
  job.controller = { aborted: false, abort() { this.aborted = true; } };
  store.set(id, job);
  return job;
}

async function withServer(options, run) {
  const app = createApp(options);
  const baseUrl = await listen(app.server);
  try {
    await run({ baseUrl, ...app });
  } finally {
    await close(app.server);
  }
}

async function testManagedApiAuthenticationAndPrincipalIsolation() {
  const policy = managedAuthPolicy();
  await withServer({ authPolicy: policy }, async ({ baseUrl, stores }) => {
    const job = seedOwnedJob(stores.chatJobs);
    const path = `${baseUrl}/api/chat-jobs/${job.id}`;

    const missing = await fetch(path);
    assert.strictEqual(missing.status, 401);
    assert.strictEqual(missing.headers.get('www-authenticate'), 'Bearer');
    const missingPayload = await missing.json();
    assert.deepStrictEqual(missingPayload, { error: { message: 'Authentication required', code: 'AUTHENTICATION_REQUIRED' } });
    assert.ok(!JSON.stringify(missingPayload).includes('secret-token'));

    const invalid = await fetch(path, { headers: { Authorization: 'Bearer not-a-real-token' } });
    assert.strictEqual(invalid.status, 401);

    const publicConfig = await fetch(`${baseUrl}/api/config/public`);
    assert.strictEqual(publicConfig.status, 200, 'bootstrap-safe public config remains readable without a bearer token');

    const aliceRead = await fetch(path, { headers: authorization('alice') });
    assert.strictEqual(aliceRead.status, 200);
    const alicePayload = await aliceRead.json();
    assert.strictEqual(alicePayload.id, job.id);
    assert.strictEqual(Object.hasOwn(alicePayload, 'ownerId'), false);

    for (const [method, suffix] of [['GET', ''], ['GET', '/events'], ['POST', '/abort'], ['DELETE', '']]) {
      const response = await fetch(`${path}${suffix}`, { method, headers: authorization('bob') });
      assert.strictEqual(response.status, 404, `Bob must not access Alice's job through ${method} ${suffix || '/'}`);
      assert.deepStrictEqual(await response.json(), { error: { message: '\u4efb\u52a1\u4e0d\u5b58\u5728\u6216\u670d\u52a1\u5df2\u91cd\u542f', code: 'JOB_NOT_FOUND' } });
      assert.strictEqual(stores.chatJobs.get(job.id), job);
      assert.strictEqual(job.status, 'running');
    }

    const aborted = await fetch(`${path}/abort`, { method: 'POST', headers: authorization('alice') });
    assert.strictEqual(aborted.status, 200);
    assert.strictEqual(job.status, 'error');
    assert.strictEqual(job.controller.aborted, true);
  });
}

async function testManagedClientJobIdCannotCrossOwnerReuseOrReassignOwnership() {
  const policy = managedAuthPolicy();
  await withServer({ authPolicy: policy }, async ({ baseUrl, stores }) => {
    const job = seedOwnedJob(stores.chatJobs, 'chatjob-client-selected-id');
    const response = await fetch(`${baseUrl}/api/chat-jobs`, {
      method: 'POST',
      headers: { ...authorization('bob'), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.id,
        baseUrl: 'https://api.example.com/v1',
        apiKey: '',
        payload: { model: 'test', messages: [] },
      }),
    });
    assert.strictEqual(response.status, 404);
    assert.strictEqual(stores.chatJobs.get(job.id).ownerId, 'alice');

    const created = makeChatJob('chatjob-new-owner', 'https://api.example.com/v1', '', { model: 'test', messages: [] });
    created.compactStream = false;
    assignJobOwner(created, { authRequired: true, principal: { id: 'bob' } });
    assert.strictEqual(created.ownerId, 'bob');
    assert.strictEqual(Object.hasOwn(require('../../server/jobs/events').publicJob(created), 'ownerId'), false);
  });
}

async function testLocalModeRemainsBackwardCompatibleForJobReads() {
  await withServer({}, async ({ baseUrl, stores }) => {
    const job = seedOwnedJob(stores.chatJobs);
    const response = await fetch(`${baseUrl}/api/chat-jobs/${job.id}`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).id, job.id);
  });
}

module.exports = [
  testManagedApiAuthenticationAndPrincipalIsolation,
  testManagedClientJobIdCannotCrossOwnerReuseOrReassignOwnership,
  testLocalModeRemainsBackwardCompatibleForJobReads,
];
