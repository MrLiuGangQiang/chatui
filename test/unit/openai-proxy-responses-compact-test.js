#!/usr/bin/env node
const assert = require('assert');
const { EventEmitter } = require('events');
const { createOpenAiProxy } = require('../../server/proxy/openai');
const { makeChatJob } = require('../../server/jobs/chat');

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
    chunks: [],
    destroyed: false,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    },
    end(chunk = '') {
      if (chunk) this.write(chunk);
      this.ended = true;
    },
    on() {},
  };
}

(async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.strictEqual(url, 'https://api.example.com/v1/responses');
    assert.strictEqual(options.method, 'POST');
    assert.strictEqual(options.headers.Accept, 'text/event-stream');
    const upstream = [
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"he"}\n\n',
      'event: response.reasoning_summary_text.delta\n',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"plan"}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"llo"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"output_text":"hello"}}\n\n',
    ].join('');
    return new Response(upstream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  };

  try {
    const { proxy } = createOpenAiProxy({
      chatJobs: new Map(),
      makeChatJob,
      notifyJob: () => {},
      updateChatJobFromStreamChunk: () => {},
      upstreamTimeoutMs: 30000,
      allowedProxyMethods: new Set(['GET', 'POST']),
      allowedProxyPaths: [/^\/models\/?$/, /^\/chat\/completions\/?$/, /^\/responses\/?$/],
    });
    const req = makeReq({
      url: '/api/responses',
      body: {
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        payload: { model: 'gpt-5', input: 'hi', stream: true },
      },
    });
    const res = makeRes();
    await proxy(req, res);
    const output = res.chunks.join('');
    assert.strictEqual(res.statusCode, 200);
    assert.match(String(res.headers['Content-Type'] || ''), /text\/event-stream/);
    assert(!output.includes('response.output_text.delta'), output);
    assert(!output.includes('response.reasoning_summary_text.delta'), output);
    assert.match(output, /event: update\ndata: \{"d":"he","ft":\d+\}\n\n/);
    assert.match(output, /event: update\ndata: \{"r":"plan"\}\n\n/);
    assert.match(output, /event: update\ndata: \{"d":"llo"\}\n\n/);
    assert.match(output, /event: update\ndata: \{"done":1\}\n\n/);
    console.log('openai proxy responses compact ok');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
