#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const reasoningWorkflowModule = require('../../client/app/reasoning-workflow');

function extractFunctionSource(name) {
  const start = appJs.indexOf(`function ${name}`);
  assert.notStrictEqual(start, -1, `${name} should exist`);
  let parenDepth = 0;
  let bodyStart = -1;
  for (let i = appJs.indexOf('(', start); i < appJs.length; i += 1) {
    if (appJs[i] === '(') parenDepth += 1;
    else if (appJs[i] === ')') parenDepth -= 1;
    else if (appJs[i] === '{' && parenDepth === 0) {
      bodyStart = i;
      break;
    }
  }
  assert.notStrictEqual(bodyStart, -1, `${name} body should exist`);
  let depth = 0;
  for (let i = bodyStart; i < appJs.length; i += 1) {
    if (appJs[i] === '{') depth += 1;
    else if (appJs[i] === '}') {
      depth -= 1;
      if (depth === 0) return appJs.slice(start, i + 1);
    }
  }
  throw new Error(`${name} source not found`);
}

const source = `
var state={reasoningMode:true,reasoningType:'high',reasoningProvider:'auto'};
function normalizeText(value){if(!value)return '';if(typeof value==='string')return value;if(Array.isArray(value))return value.map(item=>normalizeText(item?.text||item?.content||item?.summary||item?.output_text||item)).filter(Boolean).join('');if(typeof value==='object')return normalizeText(value.text||value.content||value.summary||value.output_text||value.output||'');return String(value||'')}
const normalizeContentText=normalizeText;
const normalizeReasoningText=normalizeText;
const window={ChatUICore:{reasoning:{reasoningBudgetTokens:(level)=>({low:1024,medium:4096,high:8192,xhigh:16384}[level]||4096)}}};
${extractFunctionSource('normalizeReasoningProvider')}
${extractFunctionSource('reasoningBudgetTokens')}
const reasoningWorkflow = ReasoningWorkflow.createReasoningWorkflow({ state, normalizeReasoningProvider, reasoningBudgetTokens });
function getReasoningWorkflow(){ return reasoningWorkflow; }
${extractFunctionSource('reasoningModelProfile')}
${extractFunctionSource('inferReasoningProvider')}
${extractFunctionSource('reasoningPayloadOptions')}
${extractFunctionSource('responsesInputFromChatMessages')}
${extractFunctionSource('shouldUseResponsesReasoning')}
${extractFunctionSource('buildResponsesPayload')}
${extractFunctionSource('extractResponsesResult')}
${extractFunctionSource('extractResponsesStreamDelta')}
`;

const context = { ReasoningWorkflow: reasoningWorkflowModule };
vm.createContext(context);
vm.runInContext(source, context, { filename: 'reasoning-provider-contract.vm.js' });

assert.strictEqual(context.normalizeReasoningProvider('thinking-budget'), 'qwen');
assert.strictEqual(context.inferReasoningProvider('gpt-5', 'auto'), 'openai');
assert.strictEqual(context.inferReasoningProvider('claude-sonnet-4.5', 'auto'), 'anthropic');
assert.strictEqual(context.inferReasoningProvider('qwen3-max', 'auto'), 'openai');
assert.strictEqual(context.inferReasoningProvider('deepseek-reasoner', 'auto'), 'openai');
assert.strictEqual(context.inferReasoningProvider('kimi-k2.6', 'auto'), 'openai');
assert.strictEqual(context.inferReasoningProvider('glm-4.7', 'auto'), 'openai');
assert.strictEqual(context.inferReasoningProvider('moonshot-v1', 'auto'), 'openai');
assert.strictEqual(context.inferReasoningProvider('bigmodel/glm-5', 'auto'), 'openai');
assert.strictEqual(context.inferReasoningProvider('deepseek-chat', 'openai'), 'openai');

assertJsonEqual(context.reasoningModelProfile('kimi-k2.6', 'auto'), { provider: 'openai', reasoningKey: 'reasoning_effort', reasoningFields: ['reasoning_content', 'reasoning', 'thinking', 'reasoning_details', 'thinking_content', 'delta', 'reasoning_delta', 'thinking_delta'] });
assertJsonEqual(context.reasoningModelProfile('glm-4.7', 'auto'), { provider: 'openai', reasoningKey: 'reasoning_effort', reasoningFields: ['reasoning_content', 'reasoning', 'thinking', 'reasoning_details', 'thinking_content', 'delta', 'reasoning_delta', 'thinking_delta'] });
assertJsonEqual(context.reasoningModelProfile('claude-sonnet-4.5', 'auto'), { provider: 'anthropic', reasoningKey: 'thinking', reasoningFields: ['reasoning_content', 'reasoning', 'thinking', 'reasoning_details', 'thinking_content', 'delta', 'reasoning_delta', 'thinking_delta'] });

function assertJsonEqual(actual, expected) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}


assert.strictEqual(context.shouldUseResponsesReasoning('gpt-5', 'auto'), true);
assert.strictEqual(context.shouldUseResponsesReasoning('claude-sonnet-4.5', 'auto'), false);
context.state.reasoningMode = false;
assert.strictEqual(context.shouldUseResponsesReasoning('gpt-5', 'auto'), false);
context.state.reasoningMode = true;
assertJsonEqual(context.responsesInputFromChatMessages([
  { role: 'system', content: 'sys' },
  { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
]), [
  { role: 'system', content: 'sys' },
  { role: 'user', content: [{ type: 'input_text', text: 'hello' }, { type: 'input_image', image_url: 'data:image/png;base64,abc' }] },
]);
assertJsonEqual(context.buildResponsesPayload('gpt-5', [{ role: 'user', content: 'hi' }], { reasoningEffort: 'xhigh', stream: false }), {
  model: 'gpt-5',
  input: [{ role: 'user', content: 'hi' }],
  reasoning: { effort: 'xhigh', summary: 'auto' },
});
assertJsonEqual(context.extractResponsesResult({
  output_text: 'answer',
  output: [{ type: 'reasoning', summary: [{ text: 'summary' }] }],
}), { content: 'answer', reasoning: 'summary' });
assertJsonEqual(context.extractResponsesStreamDelta({ type: 'response.output_text.delta', delta: 'hello' }), { content: 'hello', reasoning: '' });
assertJsonEqual(context.extractResponsesStreamDelta({ type: 'response.reasoning_summary_text.delta', delta: 'plan' }), { content: '', reasoning: 'plan' });

assertJsonEqual(context.reasoningPayloadOptions({ model: 'gpt-5', reasoningEffort: 'xhigh' }), { reasoning_effort: 'xhigh' });
assertJsonEqual(context.reasoningPayloadOptions({ model: 'claude-sonnet-4.5', reasoningEffort: 'medium' }), { thinking: { type: 'enabled', budget_tokens: 4096 } });
assertJsonEqual(context.reasoningPayloadOptions({ model: 'qwen3-max', reasoningEffort: 'low' }), { reasoning_effort: 'low' });
assertJsonEqual(context.reasoningPayloadOptions({ model: 'kimi-k2.6', reasoningEffort: 'high' }), { reasoning_effort: 'high' });
assertJsonEqual(context.reasoningPayloadOptions({ model: 'glm-4.7', reasoningEffort: 'high' }), { reasoning_effort: 'high' });
assertJsonEqual(context.reasoningPayloadOptions({ model: 'deepseek-reasoner', reasoningEffort: 'high' }), { reasoning_effort: 'high' });
assertJsonEqual(context.reasoningPayloadOptions({ model: 'qwen3-max', reasoningProvider: 'qwen', reasoningEffort: 'low' }), { enable_thinking: true, thinking_budget: 1024 });
assertJsonEqual(context.reasoningPayloadOptions({ model: 'kimi-k2.6', reasoningProvider: 'kimi', reasoningEffort: 'high' }), { enable_thinking: true, thinking_budget: 8192 });
assertJsonEqual(context.reasoningPayloadOptions({ model: 'glm-4.7', reasoningProvider: 'glm', reasoningEffort: 'high' }), { thinking: { type: 'enabled' } });
assertJsonEqual(context.reasoningPayloadOptions({ model: 'deepseek-reasoner', reasoningProvider: 'deepseek', reasoningEffort: 'high' }), {});

for (const provider of ['auto', 'openai', 'anthropic', 'qwen', 'deepseek', 'kimi', 'glm', 'generic']) {
  assert.match(indexHtml, new RegExp(`data-reasoning-provider="${provider}"`), `${provider} provider menu item should exist`);
}
assert.match(indexHtml, /data-reasoning-type="xhigh"/, 'xhigh reasoning menu item should exist');

console.log('reasoning provider contract ok');
