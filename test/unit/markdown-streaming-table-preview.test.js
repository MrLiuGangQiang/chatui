'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const markdownEngine = require('../../client/app/markdown/markdown-engine');
const streaming = require('../../client/app/markdown/browser-streaming-renderer');

function testStreamingTableUsesReadablePreviewBeforeFinalRender() {
  const previousDocument = global.document;
  const dom = new JSDOM('<!doctype html><div id="content" class="markdown-body"></div>');
  global.document = dom.window.document;
  try {
    const container = dom.window.document.getElementById('content');
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: markdownEngine.renderMarkdown, enhance: () => {} });

    renderer.append('| Name | Status |\n', container);
    renderer.append('| --- | --- |\n', container);
    renderer.append('| Chat | Ready |\n', container);
    renderer.flush();

    const preview = container.querySelector('[data-markdown-streaming-table]');
    assert.ok(preview, 'an unfinished Markdown table should have a live table preview');
    assert.strictEqual(preview.querySelector('th')?.textContent, 'Name');
    assert.deepStrictEqual([...preview.querySelectorAll('td')].map(cell => cell.textContent), ['Chat', 'Ready']);
    assert.deepStrictEqual([...preview.querySelectorAll('th, td')].map(cell => cell.className), ['md-align-left', 'md-align-left', 'md-align-left', 'md-align-left'], 'unmarked table columns should use explicit left alignment for both headers and body cells');
    assert.ok(!preview.textContent.includes('|') && !preview.textContent.includes('---'), 'the preview must hide Markdown table delimiters');

    const body = preview.querySelector('tbody');
    const firstRow = body.querySelector('tr');
    renderer.append('| Images | Ready |\n', container);
    renderer.flush();
    assert.strictEqual(preview.querySelector('tbody'), body, 'new streamed rows should keep the existing table body');
    assert.strictEqual(body.querySelector('tr'), firstRow, 'new streamed rows should not recreate earlier rows');
    assert.strictEqual(body.rows.length, 2);

    renderer.final(container);
    assert.ok(!container.querySelector('[data-markdown-streaming-table]'), 'the temporary preview should be removed after final Markdown rendering');
    assert.strictEqual(container.querySelector('th')?.textContent, 'Name');
  } finally {
    global.document = previousDocument;
  }
}

function testStreamingTablePreservesColumnAlignment() {
  const previousDocument = global.document;
  const dom = new JSDOM('<!doctype html><div id="content" class="markdown-body"></div>');
  global.document = dom.window.document;
  try {
    const container = dom.window.document.getElementById('content');
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: markdownEngine.renderMarkdown, enhance: () => {} });
    renderer.append('| Left | Center | Right |\n', container);
    renderer.append('| :--- | :---: | ---: |\n', container);
    renderer.append('| A | B | C |\n', container);
    renderer.flush();

    const header = [...container.querySelectorAll('[data-markdown-streaming-table] th')];
    const row = [...container.querySelectorAll('[data-markdown-streaming-table] td')];
    assert.deepStrictEqual(header.map(cell => cell.className), ['md-align-left', 'md-align-center', 'md-align-right']);
    assert.deepStrictEqual(row.map(cell => cell.className), ['md-align-left', 'md-align-center', 'md-align-right']);
    assert.ok(header.every(cell => !cell.getAttribute('style')) && row.every(cell => !cell.getAttribute('style')), 'the preview should use the same semantic alignment classes as final Markdown');
  } finally {
    global.document = previousDocument;
  }
}

function testStreamingTableHidesMarkdownSyntaxWhileItIsOnlyACandidate() {
  const previousDocument = global.document;
  const dom = new JSDOM('<!doctype html><div id="content" class="markdown-body"></div>');
  global.document = dom.window.document;
  try {
    const container = dom.window.document.getElementById('content');
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: markdownEngine.renderMarkdown, enhance: () => {} });

    renderer.append('| Topic | Value |', container);
    const preview = container.querySelector('[data-markdown-streaming-table]');
    assert.ok(preview, 'a potential table header should enter the table block state immediately');
    assert.strictEqual(preview.dataset.markdownStreamingTableState, 'candidate');
    assert.ok(!container.textContent.includes('|'), 'candidate tables must not expose raw Markdown pipes');

    renderer.append('\n| :--- | ---: |\n| Escaped \\| pipe | 7', container);
    renderer.flush();
    assert.strictEqual(preview.dataset.markdownStreamingTableState, 'active');
    assert.deepStrictEqual([...preview.querySelectorAll('td')].map(cell => cell.textContent), ['Escaped | pipe', '7']);
    assert.deepStrictEqual([...preview.querySelectorAll('td')].map(cell => cell.className), ['md-align-left', 'md-align-right']);
  } finally {
    global.document = previousDocument;
  }
}

function testStreamingTableCoalescesRapidRowUpdates() {
  const previousDocument = global.document;
  const previousNow = Date.now;
  const dom = new JSDOM('<!doctype html><div id="content" class="markdown-body"></div>');
  global.document = dom.window.document;
  Date.now = () => 1000;
  try {
    const container = dom.window.document.getElementById('content');
    const renderer = streaming.createStreamingRenderer({ renderMarkdown: markdownEngine.renderMarkdown, enhance: () => {} });
    renderer.append('| Item | State |\n', container);
    renderer.append('| --- | --- |\n', container);
    renderer.append('| One | Ready |\n', container);
    renderer.append('| Two | Ready |\n', container);

    const preview = container.querySelector('[data-markdown-streaming-table]');
    assert.strictEqual(preview.querySelectorAll('td').length, 0, 'rapid rows should wait for the shared table refresh window instead of forcing a DOM update per chunk');
    renderer.flush();
    assert.strictEqual(preview.querySelectorAll('tbody tr').length, 2, 'flushing the block state should commit all buffered rows together');
  } finally {
    Date.now = previousNow;
    global.document = previousDocument;
  }
}

module.exports = [testStreamingTableUsesReadablePreviewBeforeFinalRender, testStreamingTablePreservesColumnAlignment, testStreamingTableHidesMarkdownSyntaxWhileItIsOnlyACandidate, testStreamingTableCoalescesRapidRowUpdates];
