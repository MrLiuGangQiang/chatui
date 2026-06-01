#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '../..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

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
const state={reasoningMode:true,reasoningType:'high',reasoningProvider:'auto'};
const window={ChatUICore:{reasoning:{reasoningBudgetTokens:(level)=>({low:1024,medium:4096,high:8192,xhigh:16384}[level]||4096)}}};
${extractFunctionSource('normalizeReasoningProvider')}
${extractFunctionSource('reasoningBudgetTokens')}
${extractFunctionSource('reasoningModelProfile')}
${extractFunctionSource('inferReasoningProvider')}
${extractFunctionSource('reasoningPayloadOptions')}
`;

const context = {};
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
