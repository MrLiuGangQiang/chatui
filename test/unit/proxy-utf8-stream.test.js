const assert = require('assert');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const { createOpenAiProxy } = require('../../server/proxy/openai');

function createResponse() {
  const response = new EventEmitter();
  response.status = 0;
  response.headers = {};
  response.chunks = [];
  response.ended = false;
  response.destroyed = false;
  response.writeHead = (status, headers) => { response.status = status; response.headers = headers; };
  response.write = chunk => { response.chunks.push(Buffer.from(chunk)); return true; };
  response.end = chunk => {
    if (chunk) response.chunks.push(Buffer.from(chunk));
    response.ended = true;
  };
  return response;
}

async function testManagedProxyDecodesUtf8AcrossNetworkChunkBoundaries() {
  const originalFetch = global.fetch;
  const originalAllowPrivate = process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
  process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = '1';

  const eventText = 'data: {"choices":[{"delta":{"content":"你"}}]}\n\n';
  const eventBuffer = Buffer.from(eventText);
  const characterStart = eventBuffer.indexOf(Buffer.from('你'));
  const chunks = [eventBuffer.subarray(0, characterStart + 1), eventBuffer.subarray(characterStart + 1)];
  global.fetch = async () => ({
    status: 200,
    ok: true,
    headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null },
    body: Readable.from(chunks),
  });

  const decoded = [];
  const chatJobs = new Map();
  const { proxy } = createOpenAiProxy({
    chatJobs,
    makeChatJob: id => ({ id, status: 'running', createdAt: Date.now(), updatedAt: Date.now() }),
    notifyJob: () => {},
    updateChatJobFromStreamChunk: (_job, text) => decoded.push(text),
    upstreamTimeoutMs: 1000,
    allowedProxyMethods: new Set(['POST']),
    allowedProxyPaths: [/^\/chat\/completions$/],
  });

  const body = JSON.stringify({
    baseUrl: 'http://127.0.0.1:18765/v1',
    method: 'POST',
    jobId: 'chatjob-utf8test',
    requestPurpose: 'intent_recognition',
    payload: { model: 'test-model', stream: true, messages: [] },
  });
  const request = Readable.from([body]);
  request.url = '/api/chat/completions';
  request.headers = { 'content-type': 'application/json' };
  const response = createResponse();

  try {
    await proxy(request, response);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.ended, true);
    assert.strictEqual(decoded.join(''), eventText);
    assert.ok(decoded.every(text => !text.includes('\uFFFD')));
    assert.strictEqual(Buffer.concat(response.chunks).toString('utf8'), eventText);
  } finally {
    global.fetch = originalFetch;
    if (originalAllowPrivate === undefined) delete process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM;
    else process.env.CHATUI_ALLOW_PRIVATE_UPSTREAM = originalAllowPrivate;
  }
}

module.exports = [testManagedProxyDecodesUtf8AcrossNetworkChunkBoundaries];
