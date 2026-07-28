'use strict';

const assert = require('assert');
const JSZip = require('jszip');

const { createApp } = require('../../server/app');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

async function withServer(run) {
  const { server } = createApp();
  const baseUrl = await listen(server);
  try {
    await run(baseUrl);
  } finally {
    await close(server);
  }
}

async function postAttachment(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/extract-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.strictEqual(response.status, 200, JSON.stringify(payload));
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  return payload;
}

async function createDocxDataUrl() {
  const archive = new JSZip();
  archive.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  archive.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  archive.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>ChatUI attachment extraction smoke test</w:t></w:r></w:p>
    <w:p><w:r><w:t>中文正文：附件解析链路真实可用。</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`);
  const buffer = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${buffer.toString('base64')}`;
}

async function testAttachmentExtractionHttpSmokeUsesRealDocxParser() {
  await withServer(async baseUrl => {
    const payload = await postAttachment(baseUrl, {
      filename: '真实附件.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      dataUrl: await createDocxDataUrl(),
    });

    assert.strictEqual(payload.parser, 'mammoth');
    assert.match(payload.text, /ChatUI attachment extraction smoke test/);
    assert.match(payload.text, /中文正文：附件解析链路真实可用/);
  });
}

async function testAttachmentExtractionHttpSmokeUsesRealPlainTextDecoder() {
  await withServer(async baseUrl => {
    const source = 'Plain attachment line.\n中文文本附件可被完整读取。';
    const payload = await postAttachment(baseUrl, {
      filename: 'notes.txt',
      type: 'text/plain; charset=utf-8',
      dataUrl: `data:text/plain;charset=utf-8;base64,${Buffer.from(source).toString('base64')}`,
    });

    assert.strictEqual(payload.parser, 'plain-text');
    assert.match(payload.text, /Plain attachment line\./);
    assert.match(payload.text, /中文文本附件可被完整读取/);
  });
}

module.exports = [
  testAttachmentExtractionHttpSmokeUsesRealDocxParser,
  testAttachmentExtractionHttpSmokeUsesRealPlainTextDecoder,
];
