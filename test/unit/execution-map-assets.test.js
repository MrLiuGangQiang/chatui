'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');

function testExecutionMapAssetsShipTogether() {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const formatting = fs.readFileSync(path.join(root, 'client/app/formatting.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

  assert.ok(formatting.includes('data-execution-map="true"'), 'pending feedback must render the execution map container');
  for (const label of ['接收任务', '保存上下文', '路由预检', '准备请求', '执行并等待响应']) {
    assert.ok(formatting.includes(label), `missing execution map step: ${label}`);
  }
  assert.ok(styles.includes('[data-execution-map]') && styles.includes('.pending-map-step.active'), 'root styles must include execution map layout and active-state styling');
  assert.ok(index.includes('styles.css?v=1.3.4-execution-map-compact-secret-free-backup'), 'the root stylesheet cache version must include the execution map and compact backup release');
  assert.ok(index.includes('formatting.js?v=1.2.69-execution-map'), 'the formatting module cache version must include the execution map release');
}

module.exports = [
  testExecutionMapAssetsShipTogether,
];
