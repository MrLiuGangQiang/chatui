'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFileWriter } = require('../../server/logging/logger');

async function withTempDir(prefix, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readNdjson(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

async function testLogWriterHotPathNeverCallsSynchronousFilesystemApis() {
  await withTempDir('chatui-async-log-', async root => {
    const file = path.join(root, 'logs', 'events.ndjson');
    const writer = createFileWriter(file, { maxBytes: 1024 * 1024, rotations: 1 });
    const methods = ['appendFileSync', 'writeFileSync', 'statSync', 'existsSync', 'mkdirSync', 'renameSync', 'rmSync'];
    const originals = new Map(methods.map(method => [method, fs[method]]));
    for (const method of methods) {
      fs[method] = () => { throw new Error(`synchronous filesystem API used: ${method}`); };
    }
    try {
      assert.strictEqual(writer.writeLine({ index: 1, event: 'queued' }), true);
      await writer.flush();
    } finally {
      for (const [method, original] of originals) fs[method] = original;
    }
    assert.deepStrictEqual(readNdjson(file), [{ index: 1, event: 'queued' }]);
  });
}

async function testLogWriterQueueIsBoundedAndReportsDroppedEntries() {
  await withTempDir('chatui-bounded-log-', async root => {
    const file = path.join(root, 'events.ndjson');
    const drops = [];
    const writer = createFileWriter(file, {
      maxBytes: 1024 * 1024,
      rotations: 1,
      maxQueue: 2,
      maxQueueBytes: 1024 * 1024,
      onDrop: event => drops.push(event),
    });
    assert.strictEqual(writer.writeLine({ index: 1 }), true);
    assert.strictEqual(writer.writeLine({ index: 2 }), true);
    assert.strictEqual(writer.writeLine({ index: 3 }), false, 'a full queue must reject new log entries instead of growing without bound');
    assert.deepStrictEqual(writer.stats(), {
      pending: 2,
      queued_bytes: writer.stats().queued_bytes,
      dropped: 1,
      failed: 0,
      current_bytes: 0,
      last_error: '',
    });
    assert.strictEqual(drops.length, 1);
    await writer.flush();
    assert.deepStrictEqual(readNdjson(file).map(entry => entry.index), [1, 2]);
    assert.strictEqual(writer.stats().pending, 0);
  });
}

async function testLogWriterBatchesQueuedEntriesAndFlushesOnClose() {
  await withTempDir('chatui-batched-log-', async root => {
    const file = path.join(root, 'events.ndjson');
    const originalAppendFile = fs.promises.appendFile;
    let appendCalls = 0;
    fs.promises.appendFile = async (...args) => {
      appendCalls += 1;
      return originalAppendFile.call(fs.promises, ...args);
    };
    try {
      const writer = createFileWriter(file, {
        maxBytes: 1024 * 1024,
        rotations: 1,
        batchItems: 16,
        batchBytes: 1024 * 1024,
      });
      for (let index = 0; index < 8; index += 1) {
        assert.strictEqual(writer.writeLine({ index }), true);
      }
      await writer.close();
      assert.strictEqual(appendCalls, 1, 'one queued batch should use one asynchronous append');
      assert.deepStrictEqual(readNdjson(file).map(entry => entry.index), [0, 1, 2, 3, 4, 5, 6, 7]);
      assert.strictEqual(writer.writeLine({ index: 9 }), false, 'a closed writer must reject later entries');
    } finally {
      fs.promises.appendFile = originalAppendFile;
    }
  });
}

async function testLogWriterFlushCompletesRotationBeforeReturning() {
  await withTempDir('chatui-rotating-log-', async root => {
    const file = path.join(root, 'events.ndjson');
    const writer = createFileWriter(file, {
      maxBytes: 180,
      rotations: 1,
      batchItems: 16,
      batchBytes: 1024 * 1024,
    });
    for (let index = 0; index < 5; index += 1) {
      assert.strictEqual(writer.writeLine({ index, text: 'x'.repeat(70) }), true);
    }
    await writer.flush();
    assert.strictEqual(fs.existsSync(file), true);
    assert.strictEqual(fs.existsSync(`${file}.1`), true);
    const indexes = [
      ...readNdjson(`${file}.1`).map(entry => entry.index),
      ...readNdjson(file).map(entry => entry.index),
    ];
    assert.deepStrictEqual(indexes, [3, 4], 'one configured rotation retains the newest previous segment plus the active segment');
  });
}

module.exports = [
  testLogWriterHotPathNeverCallsSynchronousFilesystemApis,
  testLogWriterQueueIsBoundedAndReportsDroppedEntries,
  testLogWriterBatchesQueuedEntriesAndFlushesOnClose,
  testLogWriterFlushCompletesRotationBeforeReturning,
];