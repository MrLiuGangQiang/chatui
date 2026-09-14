'use strict';

const assert = require('assert');
const jobResume = require('../../client/app/job-resume-workflow');

function testTailOnlyCursorRestartsServerReplayFromZero() {
  const offsets = jobResume.buildChatResumeOffsets({
    rawText: 'only the recovered tail',
    reasoningText: 'recovered reasoning tail',
    streamCheckpointRecovered: true,
    streamCheckpointTailOnly: true,
  }, () => false);

  assert.deepStrictEqual(offsets, {
    baseContent: '',
    baseReasoning: '',
    contentLength: 0,
    reasoningLength: 0,
  }, 'a tail-only cursor must never be treated as the full prefix when resuming offsets');
}

function testOrdinaryResumeStillUsesCanonicalPendingPrefix() {
  const offsets = jobResume.buildChatResumeOffsets({
    rawText: 'complete visible prefix',
    reasoningText: 'visible reasoning',
  }, value => value === 'status');

  assert.deepStrictEqual(offsets, {
    baseContent: 'complete visible prefix',
    baseReasoning: 'visible reasoning',
    contentLength: 'complete visible prefix'.length,
    reasoningLength: 'visible reasoning'.length,
  });
}

function testStatusOnlyPendingItemResumesWithoutFakeContentOffset() {
  const offsets = jobResume.buildChatResumeOffsets({
    rawText: '正在处理 已等待 3 秒',
    reasoningText: '',
  }, value => /^正在处理/.test(String(value || '')));

  assert.deepStrictEqual(offsets, {
    baseContent: '',
    baseReasoning: '',
    contentLength: 0,
    reasoningLength: 0,
  });
}

module.exports = [
  testTailOnlyCursorRestartsServerReplayFromZero,
  testOrdinaryResumeStillUsesCanonicalPendingPrefix,
  testStatusOnlyPendingItemResumesWithoutFakeContentOffset,
];
