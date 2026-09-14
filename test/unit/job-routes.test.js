const assert = require('assert');

const { createJobRoutes } = require('../../server/api/routes/jobs');
const { sendJson, sendMethodNotAllowed } = require('../../server/http/response');

function createMockResponse() {
  return {
    status: null,
    headers: {},
    body: '',
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body = '') { this.body = String(body || ''); },
  };
}

async function invoke(routes, routeName, url, method = 'GET') {
  const res = createMockResponse();
  const req = { url, method };
  const result = routes[routeName](req, res);
  if (result && typeof result.then === 'function') await result;
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

function createRoutes(calls) {
  return createJobRoutes({
    sendJson,
    sendMethodNotAllowed,
    imageJobs: new Map([['imgjob-ok123456', { id: 'imgjob-ok123456', status: 'running', createdAt: 1, updatedAt: 2 }]]),
    chatJobs: new Map([['chatjob-ok12345', { id: 'chatjob-ok12345', status: 'running', createdAt: 1, updatedAt: 2 }]]),
    abortJob(store, id) { calls.push(['abortJob', id]); return store.get(id) || null; },
    publicJob(job) { calls.push(['publicJob', job.id]); return { id: job.id, status: job.status }; },
    subscribeJob(req, res, store) { calls.push(['subscribeJob', req.url, store.has('chatjob-ok12345') ? 'chat' : 'image']); sendJson(res, 200, { subscribed: true }); },
    startImageJob(req, res) { calls.push(['startImageJob', req.url]); sendJson(res, 200, { started: 'image' }); },
    getImageJob(req, res) { calls.push(['getImageJob', req.url]); sendJson(res, 200, { got: 'image' }); },
    startChatJob(req, res) { calls.push(['startChatJob', req.url]); sendJson(res, 200, { started: 'chat' }); },
    getChatJob(req, res) { calls.push(['getChatJob', req.url]); sendJson(res, 200, { got: 'chat' }); },
  });
}

async function testJobRoutesDispatchChatContracts() {
  const calls = [];
  const routes = createRoutes(calls);

  let result = await invoke(routes, 'routeChatJobs', '/api/chat-jobs', 'POST');
  assert.strictEqual(result.res.status, 200);
  assert.deepStrictEqual(result.json, { started: 'chat' });

  result = await invoke(routes, 'routeChatJobs', '/api/chat-jobs/events?ids=chatjob-ok12345', 'GET');
  assert.strictEqual(result.res.status, 404, 'the removed shared chat Job group endpoint must not be routable');

  result = await invoke(routes, 'routeChatJobs', '/api/chat-jobs/chatjob-ok12345/events?contentLength=1', 'GET');
  assert.strictEqual(result.res.status, 200);
  assert.deepStrictEqual(result.json, { subscribed: true });

  result = await invoke(routes, 'routeChatJobs', '/api/chat-jobs/chatjob-ok12345/abort', 'POST');
  assert.strictEqual(result.res.status, 200);
  assert.deepStrictEqual(result.json, { id: 'chatjob-ok12345', status: 'running' });

  result = await invoke(routes, 'routeChatJobs', '/api/chat-jobs/chatjob-ok12345', 'GET');
  assert.strictEqual(result.res.status, 200);
  assert.deepStrictEqual(result.json, { got: 'chat' });

  assert.deepStrictEqual(calls.map(call => call[0]), ['startChatJob', 'subscribeJob', 'abortJob', 'publicJob', 'getChatJob']);
}

async function testJobRoutesDispatchImageContracts() {
  const calls = [];
  const routes = createRoutes(calls);

  let result = await invoke(routes, 'routeImageJobs', '/api/image-jobs', 'POST');
  assert.strictEqual(result.res.status, 200);
  assert.deepStrictEqual(result.json, { started: 'image' });

  result = await invoke(routes, 'routeImageJobs', '/api/image-jobs/imgjob-ok123456/events', 'GET');
  assert.strictEqual(result.res.status, 200);
  assert.deepStrictEqual(result.json, { subscribed: true });

  result = await invoke(routes, 'routeImageJobs', '/api/image-jobs/imgjob-missing/abort', 'POST');
  assert.strictEqual(result.res.status, 404);
  assert.deepStrictEqual(result.json, { error: { message: '任务不存在或服务已重启' } });

  result = await invoke(routes, 'routeImageJobs', '/api/image-jobs/imgjob-ok123456', 'PUT');
  assert.strictEqual(result.res.status, 405);
  assert.deepStrictEqual(result.json, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } });

  assert.deepStrictEqual(calls.map(call => call[0]), ['startImageJob', 'subscribeJob', 'abortJob']);
}

module.exports = [
  testJobRoutesDispatchChatContracts,
  testJobRoutesDispatchImageContracts,
];
