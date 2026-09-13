'use strict';
const assert = require('assert');
const { createJobEvents } = require('../../server/jobs/events');
const { bindJobOwner } = require('../../server/security/job-ownership');
const { makeTestPrincipal } = require('../helpers/request-principal-fixture');

function fakeRequest(url, principal) { return { url, authPrincipal: principal, on() {}, removeListener() {} }; }
function fakeResponse() {
  return { chunks: [], ends: 0, writeHead(status) { this.status = status; }, flushHeaders() {}, write(chunk) { this.chunks.push(String(chunk)); return true; }, once() {}, removeListener() {}, end() { this.ends += 1; } };
}
function parseEvents(chunks) {
  return chunks.join('').split(/\n\n/).filter(Boolean).map(block => JSON.parse(block.split('\n').find(line => line.startsWith('data: ')).slice(6)));
}

async function testTwoHundredSyntheticChatJobsReachIndependentTerminalStates() {
  const principal = makeTestPrincipal();
  const store = new Map();
  const subscribers = new Map();
  const { subscribeJobGroup } = createJobEvents({ jobSubscribers: subscribers });
  const responses = [];
  for (let index = 0; index < 200; index += 1) {
    const id = `chatjob-capacity${String(index).padStart(4, '0')}`;
    const job = { id, status: 'done', compactStream: true, data: { choices: [{ message: { content: `answer-${index}`, reasoning_content: `reason-${index}` } }] }, createdAt: 1, updatedAt: 2, durationMs: 1 };
    bindJobOwner(job, principal);
    store.set(id, job);
    const response = fakeResponse();
    subscribeJobGroup(fakeRequest(`/api/chat-jobs/events?ids=${id}&offset=${id}%3A0%3A0`, principal), response, store);
    responses.push(response);
  }
  assert.strictEqual(responses.length, 200);
  for (const [index, response] of responses.entries()) {
    assert.strictEqual(response.status, 200);
    const events = parseEvents(response.chunks);
    assert.strictEqual(events.at(-1).done, 1, `job ${index} must reach done`);
    assert.match(events.map(event => event.d || '').join(''), new RegExp(`answer-${index}`));
    assert.strictEqual(response.ends, 1);
  }
  assert.strictEqual(subscribers.size, 0, 'terminal jobs must not leave subscribers behind');
}

module.exports = [testTwoHundredSyntheticChatJobsReachIndependentTerminalStates];
