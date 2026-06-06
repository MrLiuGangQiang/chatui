const assert = require('assert');
const { createJobEvents } = require('../../server/jobs/common');

const job = {
  id: 'chatjob-test-offset',
  status: 'running',
  compactStream: true,
  streamSeq: 5,
  data: { choices: [{ message: { content: 'abcdef', reasoning_content: 'uvwxyz' } }] },
  firstTokenMs: 9,
};
const store = new Map([[job.id, job]]);
const writes = [];
const res = {
  writeHead(code, headers) { this.code = code; this.headers = headers; },
  write(text) { writes.push(text); },
  flushHeaders() {},
  end() { this.ended = true; },
};
const req = {
  url: `/api/chat-jobs/${job.id}/events?contentLength=3&reasoningLength=2`,
  on() {},
};
const { subscribeJob } = createJobEvents({ jobSubscribers: new Map() });
subscribeJob(req, res, store);
assert.equal(res.code, 200);
const dataLine = writes[0].split('\n').find(line => line.startsWith('data: '));
const payload = JSON.parse(dataLine.slice(6));
assert.deepEqual(payload, { d: 'def', r: 'wxyz' });
console.log('chat job compact resume offset ok');
