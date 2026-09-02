'use strict';

const assert = require('assert');
const prompts = require('../../client/services/route-prompts');

function testRouteNodePromptsTeachResourceRefCandidateKeyField() {
  const variants = [
    ['full', prompts.ROUTE_NODE_SYSTEM_PROMPT],
    ['simple', prompts.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE],
  ];
  for (const [name, prompt] of variants) {
    assert.match(prompt, /每项仅candidate_key与role/,
      `${name} route prompt must declare the resource_refs item fields`);
    assert.match(prompt, /candidate_key取resource_candidates原值/,
      `${name} route prompt must require candidate_key to come from resource_candidates`);
    assert.match(prompt, /禁自造message_index\/ref\/key/,
      `${name} route prompt must forbid invented resource_refs field names`);
  }
}

module.exports = [
  testRouteNodePromptsTeachResourceRefCandidateKeyField,
];
