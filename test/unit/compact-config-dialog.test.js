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
  assert.ok(index.includes('flat-theme.css?v=2.2.14-welcome-fonts'));
}

function testBackupActionsLiveInsideConnectionCard() {
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const connectionCardStart = index.indexOf('<section class="config-card connection-config-card">');
  const modelCardStart = index.indexOf('<section class="config-card">', connectionCardStart + 1);
  const exportButton = index.indexOf('id="exportBackupBtn"');
  const importButton = index.indexOf('id="importBackupBtn"');
  const transferStatus = index.indexOf('id="backupTransferStatus"');

  assert.ok(connectionCardStart >= 0, 'connection card should expose a dedicated layout hook');
  assert.ok(modelCardStart > connectionCardStart, 'model card should follow the connection card');
  [exportButton, importButton, transferStatus].forEach(position => {
    assert.ok(position > connectionCardStart && position < modelCardStart, 'backup controls should stay inside the connection card');
  });
  assert.ok(!index.includes('backup-config-card'), 'backup controls should not occupy a separate card');
}

function testConfigDialogUsesCompactResponsiveLayout() {
  // The repository canonicalizes source to LF, but editors can leave CRLF in
  // the working tree. Normalize before asserting exact selector formatting so
  // the layout contract remains cross-platform deterministic.
  const css = fs.readFileSync(path.join(__dirname, '../../styles/flat-theme.css'), 'utf8').replace(/\r\n?/g, '\n');

  assert.ok(css.includes('#configModal .config-dialog{\n  min-height:auto!important'));
  assert.ok(css.includes('#configModal .config-grid{\n  gap:8px!important'));
  assert.ok(css.includes('#configModal .prompt-config-layout textarea{\n  min-height:92px!important'));
  assert.ok(css.includes('grid-template-columns:minmax(0,.88fr) minmax(0,1.12fr)!important'));
  assert.ok(css.includes('#configModal .connection-config-card{\n  display:flex!important'));
  assert.ok(css.includes('#configModal .connection-backup-actions{\n  margin-top:auto!important'));
  assert.ok(css.includes('#configModal .connection-backup-actions{\n    display:grid!important'));
}

module.exports = [
  testConfigDialogKeepsOnlyOperationalCopy,
  testBackupActionsLiveInsideConnectionCard,
  testConfigDialogUsesCompactResponsiveLayout
];
