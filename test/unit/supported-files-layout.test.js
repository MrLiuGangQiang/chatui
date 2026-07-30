'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

function readPage() {
  return fs.readFileSync(path.join(__dirname, '../../pages/files.html'), 'utf8');
}

function testSupportedFilesPanelsUseAlignedGeometry() {
  const html = readPage();
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { document } = dom.window;
  const style = document.querySelector('style').textContent;

  assert.match(style, /\.format-panel\.image\s*{[^}]*top:\s*184px;[^}]*width:\s*726px;[^}]*height:\s*218px;/s);
  assert.match(style, /\.format-panel\.pdf\s*{[^}]*left:\s*774px;[^}]*top:\s*184px;[^}]*width:\s*726px;[^}]*height:\s*218px;/s);
  assert.match(style, /\.format-panel\.sheet\s*{[^}]*top:\s*413px;[^}]*width:\s*726px;[^}]*height:\s*158px;/s);
  assert.match(style, /\.format-panel\.document\s*{[^}]*left:\s*774px;[^}]*top:\s*413px;[^}]*width:\s*726px;[^}]*height:\s*158px;/s);
  assert.match(style, /\.format-panel\.presentation\s*{[^}]*width:\s*1464px;/s);
  assert.strictEqual(document.querySelectorAll('.info-card').length, 3);
  assert.strictEqual(document.querySelectorAll('.format-panel').length, 6);
  assert.match(style, /#poster\s*{[^}]*border-radius:\s*0;/s, 'the standalone page must keep square bottom corners');
}

function testSupportedFilesContentFitsDedicatedRegions() {
  const html = readPage();
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const { document } = dom.window;
  const style = document.querySelector('style').textContent;
  const imageTags = [...document.querySelectorAll('.format-panel.image .tag')].map(tag => tag.textContent);
  const codeTags = [...document.querySelectorAll('.format-panel.code .tag')].map(tag => tag.textContent);

  assert.ok(imageTags.includes('.svg'), 'the final image extension must remain visible in the image tag region');
  assert.ok(codeTags.includes('.dockerfile'), 'the final code extension must remain visible in the code tag region');
  assert.match(style, /\.info-description\s*{[^}]*width:\s*236px;[^}]*white-space:\s*normal;/s);
  assert.match(style, /\.image \.tag-list\s*{[^}]*width:\s*430px;/s);
  assert.ok(document.querySelector('.notice-description').textContent.includes('单次上传合计也须小于 10 MB'));
}

module.exports = [testSupportedFilesPanelsUseAlignedGeometry, testSupportedFilesContentFitsDedicatedRegions];
