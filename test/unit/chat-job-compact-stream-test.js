const assert = require('assert');
const { publicJob, createJobEvents } = require('../../server/jobs/common');

const job = {
  id: 'chatjob-test-compact',
  status: 'running',
  createdAt: 1,
  updatedAt: 2,
  compactStream: true,
  streamSeq: 3,
  streamDelta: { content: '增量', reasoning: '思考' },
  data: { choices: [{ message: { content: '完整内容增量', reasoning_content: '完整思考思考' } }] },
  firstTokenMs: 12,
};

const snapshot = publicJob(job);
assert.equal(snapshot.id, job.id);
assert.equal(snapshot.status, 'running');
assert.equal(snapshot.data.choices[0].message.content, '完整内容增量');
assert.equal(snapshot.metrics.firstTokenMs, 12);
assert.equal(snapshot.d, undefined);

const live = publicJob(job, { live: true });
assert.deepEqual(live, { d: '增量', r: '思考', ft: 12 });

const writes = [];
const res = { write(text) { writes.push(text); }, flushHeaders() {} };
const subscribers = new Map([[job.id, new Set([res])]]);
createJobEvents({ jobSubscribers: subscribers }).notifyJob(job);
assert.equal(job.firstTokenNotified, true);
job.streamDelta = { content: '后续' };
assert.deepEqual(publicJob(job, { live: true }), { d: '后续' });

job.status = 'done';
const done = publicJob(job, { live: true });
assert.deepEqual(done, { done: 1 });

const doneSnapshot = publicJob(job);
assert.equal(doneSnapshot.status, 'done');
assert.equal(doneSnapshot.data.choices[0].message.content, '完整内容增量');

console.log('chat job compact stream ok');
