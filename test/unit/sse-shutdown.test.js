'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { closeJobSubscribers } = require('../../server/jobs/events');

function testCloseJobSubscribersEndsEveryActiveSseConnection() {
  const subscribers = new Map();
  const ended = [];
  const makeResponse = id => ({ id, end() { ended.push(id); } });
  const principal = {};

  const chat = new Set([{ res: makeResponse('chat-1'), principal, job: { id: 'chat-1' } }]);
  const batch = new Set([
    { res: makeResponse('batch-1'), principal, job: { id: 'batch-1' } },
    { res: makeResponse('batch-2'), principal, job: { id: 'batch-1' } },
  ]);
  subscribers.set('chat-1', chat);
  subscribers.set('batch-1', batch);

  assert.strictEqual(closeJobSubscribers(subscribers), 3);
  assert.deepStrictEqual(ended.sort(), ['batch-1', 'batch-2', 'chat-1']);
  assert.strictEqual(subscribers.size, 0);
  assert.strictEqual(chat.size, 0);
  assert.strictEqual(batch.size, 0);
}

function testServerCloseEndsSseBeforeDelegatingToNode() {
  const app = fs.readFileSync(path.join(__dirname, '../../server/app.js'), 'utf8');
  assert.ok(app.includes('closeJobSubscribers(jobSubscribers)'), 'server.close must end active SSE subscribers first');
  assert.ok(app.includes('const originalClose = server.close.bind(server)'), 'the close override must preserve the original Node close');
  assert.ok(app.includes('server.close = function closeServer(callback)'), 'the close hook must be installed on the created server instance');
}

module.exports = [
  testCloseJobSubscribersEndsEveryActiveSseConnection,
  testServerCloseEndsSseBeforeDelegatingToNode,
];
