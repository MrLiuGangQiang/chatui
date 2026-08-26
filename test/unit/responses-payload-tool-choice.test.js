'use strict';

// Regression coverage for the Qwen/DashScope 400:
//   "When using `tool_choice`, `tools` must be set."
//
// Strict OpenAI-compatible gateways reject a payload that carries tool_choice
// without a tools array. ChatUI's intent/image-instruction one-shot requests
// passed toolChoice: 'none' with no tools, so every such request failed on
// Qwen. tool_choice is only meaningful alongside tools; `none` is the implicit
// default when no tools exist and must simply be omitted.

const assert = require('assert');
const chatService = require('../../client/services/chat-service');

const { buildResponsesPayload } = chatService;

function messages() {
  return [{ role: 'user', content: 'hello' }];
}

function testToolChoiceNoneWithoutToolsIsOmitted() {
  const payload = buildResponsesPayload('qwen-test', messages(), {
    stream: false,
    noReasoning: true,
    toolChoice: 'none',
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'tool_choice'),
    `tool_choice must be omitted when no tools are set (Qwen rejects it), got: ${JSON.stringify(payload)}`);
  assert.ok(!Array.isArray(payload.tools), 'no tools must be advertised without a tools array');
}

function testToolChoiceIsKeptWhenToolsExist() {
  const payload = buildResponsesPayload('qwen-test', messages(), {
    stream: false,
    webSearch: true,
    toolChoice: 'auto',
  });
  assert.deepStrictEqual(payload.tools, [{ type: 'web_search' }]);
  assert.strictEqual(payload.tool_choice, 'auto', 'tool_choice must be kept when a tools array is present');
}

function testNoToolFieldsByDefault() {
  const payload = buildResponsesPayload('qwen-test', messages(), { stream: false });
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'tool_choice'));
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, 'tools'));
}

function testToolChoiceNoneWithToolsIsKept() {
  const payload = buildResponsesPayload('qwen-test', messages(), {
    stream: false,
    webSearch: true,
    toolChoice: 'none',
  });
  assert.deepStrictEqual(payload.tools, [{ type: 'web_search' }]);
  assert.strictEqual(payload.tool_choice, 'none', 'explicit none is preserved when tools exist');
}

module.exports = [
  testToolChoiceNoneWithoutToolsIsOmitted,
  testToolChoiceIsKeptWhenToolsExist,
  testNoToolFieldsByDefault,
  testToolChoiceNoneWithToolsIsKept,
];