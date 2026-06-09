#!/usr/bin/env node
const assert = require('assert');
const { EventEmitter } = require('events');
const { createOpenAiProxy } = require('../../server/proxy/openai');

function makeReq({ url, method = 'POST', body = {} }) {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  req.setEncoding = () => {};
  process.nextTick(() => {
    req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    destroyed: false,
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk) { this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk); },
    end(chunk = '') { if (chunk) this.write(chunk); this.ended = true; },
    on() {},
  };
}

(async () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '../../server/proxy/openai.js'), 'utf8');
  assert.ok(!source.includes('clearTimeout(timer);'), 'proxy must not clear a block-scoped timer in finally');
  assert.ok(source.includes('let upstreamTimer = null'), 'proxy keeps upstream timer in outer scope');
  assert.ok(source.includes('clearTimeout(upstreamTimer)'), 'proxy clears the outer-scoped upstream timer');

  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('synthetic upstream failure'); };
  try {
    const { proxy } = createOpenAiProxy({
      chatJobs: new Map(),
      makeChatJob: () => ({}),
      notifyJob: () => {},
      updateChatJobFromStreamChunk: () => {},
      upstreamTimeoutMs: 30000,
      allowedProxyMethods: new Set(['GET', 'POST']),
      allowedProxyPaths: [/^\/models\/?$/],
    });
    const req = makeReq({
      url: '/api/models',
      body: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', payload: {} },
    });
    const res = makeRes();
    await proxy(req, res);
    assert.strictEqual(res.statusCode, 502);
    assert.match(res.body, /UPSTREAM_CONNECTION_FAILED/);
    console.log('openai proxy timer scope ok');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
