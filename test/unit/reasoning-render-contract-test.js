#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const appJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

assert.match(appJs, /function updateReasoning\(/, 'updateReasoning should exist');
assert.match(
  appJs,
  /reasoning-content"\),r=escapeHtml\(n\)\.replace\(\/\\n\/g,"<br>"\)/,
  'reasoning content should be escaped plain text, not rendered as Markdown'
);
assert.doesNotMatch(
  appJs,
  /reasoning-content"\),r=renderMarkdown\(n\)/,
  'reasoning content must not use renderMarkdown because model thinking may contain Markdown-like symbols'
);

assert.match(
  appJs,
  /未返回思考内容/,
  'missing reasoning should use an accurate title instead of 思考完成'
);
assert.match(
  appJs,
  /当前模型或接口没有返回可展示的思考内容；已完成回答，但只能展示最终结果。/,
  'missing reasoning copy should explain that the provider did not return displayable thinking text'
);

console.log('reasoning render contract ok');
