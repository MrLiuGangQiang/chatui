const assert = require('assert');
const { publicJob } = require('../../server/jobs/common');

const runningJob = {
  id: 'chatjob-test-get-offset',
  status: 'running',
  compactStream: true,
  streamSeq: 7,
  data: { choices: [{ message: { content: '0123456789', reasoning_content: 'abcdef' } }] },
  firstTokenMs: 11,
};

const running = publicJob(runningJob, { resumeUrl: '/api/chat-jobs/chatjob-test-get-offset?contentLength=6&reasoningLength=2' });
assert.deepEqual(running, { d: '6789', r: 'cdef' });

const doneJob = { ...runningJob, status: 'done' };
const done = publicJob(doneJob, { resumeUrl: '/api/chat-jobs/chatjob-test-get-offset?contentLength=10&reasoningLength=6' });
assert.deepEqual(done, { done: 1 });

const full = publicJob(doneJob);
assert.equal(full.data.choices[0].message.content, '0123456789');

console.log('chat job compact get offset ok');
