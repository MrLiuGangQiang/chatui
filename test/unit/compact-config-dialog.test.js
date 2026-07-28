'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function testConfigDialogKeepsOnlyOperationalCopy() {
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');

  [
    'Provider Console',
    '配置 Endpoint、密钥和模型',
    'OpenAI 兼容 Endpoint',
    '连接说明',
    '回复质量和自动意图判断',
    '生图/修图模型和输出尺寸',
    '默认提示词用于聊天',
    '将聊天记录、附件图片',
    'backupConfigHint',
    '备份不包含 API Key'
  ].forEach(copy => assert.ok(!index.includes(copy), `config dialog should omit redundant copy: ${copy}`));

  assert.ok(index.includes('id="systemPrompt" rows="4"'));
  assert.ok(index.includes('id="imageStylePrompt" rows="4"'));
  assert.ok(index.includes('flat-theme.css?v=2.2.3-code-action-motion-compact-config'));
}

function testConfigDialogUsesCompactResponsiveLayout() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8');

  assert.ok(css.includes('#configModal .config-dialog{\n  min-height:auto!important'));
  assert.ok(css.includes('#configModal .config-grid{\n  gap:8px!important'));
  assert.ok(css.includes('#configModal .prompt-config-layout textarea{\n  min-height:92px!important'));
  assert.ok(css.includes('grid-template-columns:minmax(0,.88fr) minmax(0,1.12fr)!important'));
  assert.ok(css.includes('#configModal .backup-config-card{\n  display:grid!important'));
  assert.ok(css.includes('grid-template-columns:minmax(0,1fr) auto!important'));
}

module.exports = [
  testConfigDialogKeepsOnlyOperationalCopy,
  testConfigDialogUsesCompactResponsiveLayout
];
