#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const reasoningWorkflow = fs.readFileSync(path.join(root, 'client/app/reasoning-workflow.js'), 'utf8');

assert.match(appJs, /function updateReasoning\(/, 'updateReasoning adapter should exist');
assert.match(reasoningWorkflow, /function renderReasoningMarkdown\(/, 'reasoning should use a dedicated markdown renderer');
assert.match(appJs, /function protectReasoningMarkdownText\(/, 'reasoning markdown should protect plain English text');
assert.match(
  reasoningWorkflow,
  /const e=!0===s\.done\|\|!0===s\.renderMarkdown/,
  'reasoning stream should avoid full Markdown rendering until done'
);
assert.match(
  reasoningWorkflow,
  /renderReasoningMarkdown\(n\)/,
  'reasoning final content should use dedicated Markdown rendering'
);
assert.match(
  reasoningWorkflow,
  /o\.textContent=n,o\.dataset\.streamingText=n/,
  'reasoning stream should update textContent lightly to avoid flicker'
);
assert.doesNotMatch(
  appJs,
  /setTimeout\(h,900\)/,
  'reasoning should not be marked complete before the response stream finishes'
);
assert.doesNotMatch(
  appJs,
  /I\.flush\(C\)/,
  'final response rendering should avoid an extra streaming DOM flush before final Markdown render'
);
assert.match(
  appJs,
  /deferDomUpdate/,
  'live display persistence should be able to skip duplicate active DOM updates'
);
assert.doesNotMatch(
  reasoningWorkflow,
  /reasoning-content"\),r=escapeHtml\(n\)\.replace\(\/\\n\/g,"<br>"\)/,
  'reasoning content should not be forced to plain text'
);

assert.match(
  reasoningWorkflow,
  /未返回思考内容/,
  'missing reasoning should use an accurate title instead of 思考完成'
);
assert.match(
  reasoningWorkflow,
  /当前模型或接口没有返回可展示的思考内容；已完成回答，但只能展示最终结果。/,
  'missing reasoning copy should explain that the provider did not return displayable thinking text'
);

console.log('reasoning render contract ok');
