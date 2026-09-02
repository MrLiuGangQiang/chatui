'use strict';

const assert = require('assert');
const prompts = require('../../client/services/route-prompts');

function testRouteNodePromptDisambiguatesFileOnlyFromMultimodal() {
  const prompt = prompts.ROUTE_NODE_SYSTEM_PROMPT;
  assert.match(prompt, /仅文件无图是file_qa/,
    'the route prompt must keep file-only turns out of multimodal_qa');
}

function testRouteNodePromptTreatsExplicitDeicticQuotedAsContextEvidence() {
  const prompt = prompts.ROUTE_NODE_SYSTEM_PROMPT;
  assert.match(prompt, /这个描述\/上述/,
    'the route prompt must recognize explicit deictic quoted references as context-binding evidence');
}

module.exports = [
  testRouteNodePromptDisambiguatesFileOnlyFromMultimodal,
  testRouteNodePromptTreatsExplicitDeicticQuotedAsContextEvidence,
];
