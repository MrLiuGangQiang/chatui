#!/usr/bin/env node
const assert = require('assert');
const { extractWordText, extractPowerPointText, extractExcelText } = require('../../server/extract/office');

function dataUrl(buffer) {
  return `data:application/octet-stream;base64,${buffer.toString('base64')}`;
}

(async () => {
  const docx = Buffer.from('not-a-zip');
  await assert.rejects(() => extractWordText('bad.docx', dataUrl(docx)), /Office|zip|文件|mammoth|central/i);
  assert.strictEqual(typeof extractPowerPointText, 'function');
  assert.strictEqual(typeof extractExcelText, 'function');
  console.log('extract ok');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
