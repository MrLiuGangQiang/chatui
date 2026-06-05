const assert = require('assert');
const jobs = require('../../client/app/job-workflow');

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

(async function run() {
  const storage = memoryStorage();
  const deps = {
    storage,
    sessionChatJobKey: id => `chat:${id}`,
    sessionImageJobKey: id => `image:${id}`,
    safeSetJobStorage: (key, job) => storage.setItem(key, JSON.stringify(job)),
  };
  jobs.saveJob('s1', { id: 'chat-job', responseIndex: 2 }, deps, 'chat');
  assert.deepStrictEqual(jobs.loadJob('s1', deps, 'chat'), { id: 'chat-job', responseIndex: 2 });
  jobs.clearJob('s1', deps, 'chat');
  assert.strictEqual(jobs.loadJob('s1', deps, 'chat'), null);

  jobs.saveJob('s1', { id: 'image-job', mode: 'image' }, deps, 'image');
  assert.deepStrictEqual(jobs.loadJob('s1', deps, 'image'), { id: 'image-job', mode: 'image' });

  const displayDeps = {
    ...deps,
    sessions: [{ id: 's1', display: [
      { id: 'old', role: 'assistant', pending: '1', jobId: 'old-job', responseIndex: '1' },
      { id: 'img', role: 'assistant', pending: '1', jobId: 'img-job', responseIndex: '2', imageContext: '{}' },
      { id: 'new', role: 'assistant', pending: '1', jobId: 'new-job', responseIndex: '3' },
    ] }],
    isImagePendingDisplayItem: item => !!item.imageContext,
  };
  const displayChatJob = jobs.loadDisplayChatJob('s1', displayDeps);
  assert.deepStrictEqual(displayChatJob, {
    id: 'new-job', prompt: '', payload: null, startedAt: displayChatJob.startedAt, displayItemId: 'new', responseIndex: '3',
  });

  const done = await jobs.waitJobEvent('/events', () => {}, {
    EventSource: class MockEventSource {
      constructor() { setTimeout(() => this.listeners.update({ data: JSON.stringify({ status: 'done', data: { content: 'ok' }, metrics: { ms: 1 } }) }), 0); }
      addEventListener(name, fn) { this.listeners = this.listeners || {}; this.listeners[name] = fn; }
      close() {}
    },
  });
  assert.deepStrictEqual(done, { content: 'ok', metrics: { ms: 1 } });

  console.log('app job workflow ok');
})();
