'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const formattingModule = require('../../client/app/formatting');

const root = path.join(__dirname, '../..');

function testExecutionMapAssetsShipTogether() {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const formatting = fs.readFileSync(path.join(root, 'client/app/formatting.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

  const rendered = formattingModule.pendingFeedbackHtml('正在执行');
  assert.ok(rendered.includes('data-execution-map="true"'), 'pending feedback must render the execution map container at runtime');
  assert.ok(rendered.includes('pending-map-step'), 'pending feedback runtime output must contain map steps');
  for (const label of ['接收任务', '保存上下文', '路由预检', '准备请求', '执行并等待响应']) {
    assert.ok(formatting.includes(label), `missing execution map step: ${label}`);
  }
  assert.ok(styles.includes('[data-execution-map]') && styles.includes('.pending-map-step.active'), 'root styles must include execution map layout and active-state styling');
  const stylesheetRevision = index.match(/(?:^|["' ])(?:\.\/)?styles\.css\?v=([^"'\s]+)/)?.[1] || '';
  const formattingRevision = index.match(/(?:^|["' ])(?:\.\/)?client\/app\/formatting\.js\?v=([^"'\s]+)/)?.[1] || '';
  assert.ok(stylesheetRevision, 'the root stylesheet must carry a cache revision');
  assert.ok(formattingRevision, 'the formatting module must carry a cache revision');
}

module.exports = [
  testExecutionMapAssetsShipTogether,
];
