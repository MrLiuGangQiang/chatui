'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const core = require('../../client/core/web-preview');
const ui = require('../../client/ui/web-preview');

function testWebPreviewDetectsFullHtmlResponsesWithoutTreatingSnippetsAsPages() {
  const candidates = core.extractWebPreviewCandidates([
    'Here is the page:',
    '```html',
    '<!doctype html><html><head><title>Portfolio</title></head><body><main>Content</main></body></html>',
    '```',
  ].join('\n'));
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].title, 'Portfolio');
  assert.strictEqual(candidates[0].origin, 'fence');
  assert.deepStrictEqual(core.extractWebPreviewCandidates('```html\n<div>a snippet</div>\n```'), []);
}

function testWebPreviewKeepsInteractiveDocumentContent() {
  const source = '<!doctype html><html><head><title>Portfolio</title><script src="/app.js"></script></head><body onload="boot()"><form action="/submit"><button>Go</button></form><script>function boot(){}</script></body></html>';
  const document = core.buildPreviewDocument(source);
  assert.strictEqual(document, source);
  assert.match(document, /<script\b/i);
  assert.match(document, /<form\b/i);
  assert.match(document, /onload="boot\(\)"/i);
}

function testWebPreviewDetectsEachCompletePageInOneResponse() {
  const first = '<!doctype html><html><head><title>First page</title></head><body><h1>First</h1></body></html>';
  const second = '<html><head><title>Second page</title></head><body><h1>Second</h1></body></html>';
  const candidates = core.extractWebPreviewCandidates(`${first}\n\n${second}`);
  assert.strictEqual(candidates.length, 2);
  assert.deepStrictEqual(candidates.map(candidate => candidate.id), ['web-preview-1', 'web-preview-2']);
  assert.deepStrictEqual(candidates.map(candidate => candidate.title), ['First page', 'Second page']);
  assert.deepStrictEqual(candidates.map(candidate => candidate.source), [first, second]);
}

function testWebPreviewDialogHasNoVisualBorder() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/messages.css'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
  const panel = css.match(/\.web-preview-dialog-panel\{([\s\S]*?)\n\}/)?.[1] || '';
  const header = css.match(/\.web-preview-dialog-header\{([\s\S]*?)\n\}/)?.[1] || '';
  const frame = css.match(/#webPreviewFrame\{([^}]*)\}/)?.[1] || '';
  assert.match(panel, /border:0;/, 'the preview dialog panel must not render an outer border');
  assert.match(panel, /box-shadow:none;/, 'the preview dialog panel must not render a shadow that looks like a border');
  assert.match(header, /border-bottom:0;/, 'the preview dialog header must not render a divider border');
  assert.match(frame, /border:none!important;/, 'the preview iframe must not render a border');
  assert.match(frame, /outline:0!important;/, 'the preview iframe must not render a focus outline');
  assert.match(frame, /box-shadow:none!important;/, 'the preview iframe must not render a shadow');
  assert.match(index, /<iframe id="webPreviewFrame"[^>]*frameborder="0"/, 'the preview iframe should disable legacy frame borders too');
}

function createDownloadTestEnvironment({ openWindow = () => null } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <article class="message assistant"><div class="content"></div></article>
    <div id="webPreview" aria-hidden="true"><div><strong id="webPreviewTitle"></strong><div><button id="webPreviewDownload" type="button" disabled>Download</button><button id="webPreviewClose" type="button">Close</button></div><iframe id="webPreviewFrame" sandbox="allow-scripts allow-forms allow-popups allow-downloads" referrerpolicy="no-referrer"></iframe></div></div>
  </body>`, { pretendToBeVisual: true });
  const blobs = [];
  const urls = [];
  const revoked = [];
  const clicks = [];
  class TestBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
      blobs.push(this);
    }
  }
  const urlApi = {
    createObjectURL(blob) {
      const value = `blob:preview-${urls.length + 1}`;
      urls.push({ blob, value });
      return value;
    },
    revokeObjectURL(value) { revoked.push(value); },
  };
  const originalClick = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function click() {
    clicks.push({ href: this.href, download: this.download });
  };
  const controller = ui.createWebPreviewController({
    document: dom.window.document,
    core,
    Blob: TestBlob,
    URL: urlApi,
    openWindow,
    setTimeout(fn) { fn(); return 0; },
  });
  return { dom, controller, blobs, urls, revoked, clicks, restore() { dom.window.HTMLAnchorElement.prototype.click = originalClick; } };
}

function testWebPreviewOpensInNewWindowAndKeepsThePageSandboxed() {
  const opened = [];
  const { dom, controller, restore } = createDownloadTestEnvironment({
    openWindow(...args) {
      const popup = new JSDOM('<!doctype html><title>Loading</title>', {
        pretendToBeVisual: true,
        runScripts: 'dangerously',
      }).window;
      popup.focus = () => {};
      opened.push({ args, popup });
      return popup;
    },
  });
  try {
    const message = dom.window.document.querySelector('.message');
    const source = '<html><head><title>Example</title><script>window.ready = true</script></head><body><form><button>Go</button></form><h1>Hello</h1></body></html>';
    controller.syncMessagePreviews(message, `\`\`\`html\n${source}\n\`\`\``);

    message.querySelector('.web-preview-open-btn').click();
    assert.strictEqual(opened.length, 1, 'the preview action should create a separate window');
    assert.deepStrictEqual(opened[0].args, ['', '_blank', 'popup=yes,width=1440,height=960']);
    assert.strictEqual(opened[0].popup.opener, null, 'the generated page must not retain an opener reference');
    assert.strictEqual(opened[0].popup.document.title, 'Example');
    const frame = opened[0].popup.document.getElementById('preview');
    assert.match(frame.getAttribute('sandbox'), /allow-scripts/);
    assert.match(frame.getAttribute('srcdoc'), /window\.ready = true/);
    assert.strictEqual(dom.window.document.getElementById('webPreview').classList.contains('show'), false, 'a successful popup should not also open the in-page dialog');
  } finally {
    restore();
  }
}

function testWebPreviewUiRendersInteractiveSandboxedIframe() {
  const { dom, controller, restore } = createDownloadTestEnvironment();
  try {
    const message = dom.window.document.querySelector('.message');
    const count = controller.syncMessagePreviews(message, '```html\n<html><head><title>Example</title><script>window.ready = true</script></head><body><form><button>Go</button></form><h1>Hello</h1></body></html>\n```');
    assert.strictEqual(count, 1);
    const button = message.querySelector('.web-preview-open-btn');
    assert.ok(button);
    assert.ok(button.querySelector('svg path[d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"]'), 'preview action should use an eye outline icon');
    assert.ok(button.querySelector('svg circle[cx="12"][cy="12"][r="3"]'), 'preview action should include an eye pupil');
    assert.strictEqual(message.querySelector('[data-copy-exclude="1"]').textContent.includes('Example'), true);
    const modal = dom.window.document.getElementById('webPreview');
    const frame = dom.window.document.getElementById('webPreviewFrame');
    const modalDownload = dom.window.document.getElementById('webPreviewDownload');
    const originalSetAttribute = frame.setAttribute.bind(frame);
    const originalGetBoundingClientRect = modal.getBoundingClientRect.bind(modal);
    let modalWasVisibleWhenDocumentLoaded = false;
    let layoutCommittedBeforeDocumentLoaded = false;
    let layoutCommitCount = 0;
    modal.getBoundingClientRect = () => {
      layoutCommitCount += 1;
      return originalGetBoundingClientRect();
    };
    frame.setAttribute = (name, value) => {
      if (name === 'srcdoc') {
        modalWasVisibleWhenDocumentLoaded = modal.classList.contains('show');
        layoutCommittedBeforeDocumentLoaded = layoutCommitCount > 0;
      }
      return originalSetAttribute(name, value);
    };
    let documentClicks = 0;
    dom.window.document.addEventListener('click', () => { documentClicks += 1; });
    button.click();
    assert.ok(modal.classList.contains('show'));
    assert.strictEqual(modalWasVisibleWhenDocumentLoaded, true, 'the dialog must be visible before iframe navigation starts on the first click');
    assert.strictEqual(layoutCommittedBeforeDocumentLoaded, true, 'the dialog layout must be committed before iframe navigation starts on the first click');
    assert.strictEqual(documentClicks, 0, 'opening a preview must not bubble into global click handlers');
    assert.strictEqual(modal.getAttribute('aria-hidden'), 'false');
    assert.match(frame.getAttribute('sandbox'), /allow-scripts/);
    assert.match(frame.getAttribute('sandbox'), /allow-forms/);
    assert.match(frame.getAttribute('srcdoc'), /window\.ready = true/);
    assert.strictEqual(modalDownload.disabled, false);
    controller.closePreview();
    assert.strictEqual(modal.getAttribute('aria-hidden'), 'true');
    assert.strictEqual(frame.hasAttribute('srcdoc'), false);
    assert.strictEqual(modalDownload.disabled, true);
  } finally {
    restore();
  }
}

function testWebPreviewDownloadsTheActivePageFromCardAndModal() {
  const { dom, controller, blobs, urls, revoked, clicks, restore } = createDownloadTestEnvironment();
  try {
    const message = dom.window.document.querySelector('.message');
    const source = '<html><head><title>Sales: July/2026?.html</title></head><body><script>boot()</script><form><button>Go</button></form></body></html>';
    controller.syncMessagePreviews(message, `\`\`\`html\n${source}\n\`\`\``);
    const cardDownload = message.querySelector('.web-preview-download-btn');
    const open = message.querySelector('.web-preview-open-btn');
    assert.ok(cardDownload);
    cardDownload.click();
    assert.strictEqual(blobs.length, 1);
    assert.strictEqual(blobs[0].parts[0], source);
    assert.strictEqual(blobs[0].options.type, 'text/html;charset=utf-8');
    assert.deepStrictEqual(clicks[0], { href: 'blob:preview-1', download: 'Sales July 2026.html' });
    assert.deepStrictEqual(revoked, ['blob:preview-1']);

    open.click();
    const modalDownload = dom.window.document.getElementById('webPreviewDownload');
    modalDownload.click();
    assert.strictEqual(blobs.length, 2);
    assert.strictEqual(blobs[1].parts[0], source);
    assert.deepStrictEqual(clicks[1], { href: 'blob:preview-2', download: 'Sales July 2026.html' });
    assert.deepStrictEqual(urls.map(entry => entry.value), ['blob:preview-1', 'blob:preview-2']);
  } finally {
    restore();
  }
}

function testWebPreviewCardsKeepMultiplePagesIndependent() {
  const { dom, controller, blobs, clicks, restore } = createDownloadTestEnvironment();
  try {
    const message = dom.window.document.querySelector('.message');
    const first = '<html><head><title>First page</title></head><body><h1>First content</h1></body></html>';
    const second = '<html><head><title>Second page</title></head><body><h1>Second content</h1></body></html>';
    assert.strictEqual(controller.syncMessagePreviews(message, `${first}\n${second}`), 2);

    const cards = [...message.querySelectorAll('[data-web-preview-card="1"]')];
    assert.strictEqual(cards.length, 2);
    assert.deepStrictEqual(cards.map(card => card.dataset.webPreviewId), ['web-preview-1', 'web-preview-2']);

    const openButtons = [...message.querySelectorAll('.web-preview-open-btn')];
    const downloadButtons = [...message.querySelectorAll('.web-preview-download-btn')];
    assert.strictEqual(openButtons.length, 2);
    assert.strictEqual(downloadButtons.length, 2);
    for (const button of openButtons.concat(downloadButtons)) {
      assert.strictEqual(button.textContent, '');
      assert.ok(button.querySelector('svg'));
      assert.ok(button.title);
      assert.ok(button.getAttribute('aria-label'));
    }

    openButtons[0].click();
    const frame = dom.window.document.getElementById('webPreviewFrame');
    assert.match(frame.getAttribute('srcdoc'), /First content/);

    downloadButtons[1].click();
    assert.strictEqual(blobs.length, 1);
    assert.strictEqual(blobs[0].parts[0], second);
    assert.deepStrictEqual(clicks[0], { href: 'blob:preview-1', download: 'Second page.html' });

    openButtons[1].click();
    assert.match(frame.getAttribute('srcdoc'), /Second content/);

    downloadButtons[0].click();
    assert.strictEqual(blobs.length, 2);
    assert.strictEqual(blobs[1].parts[0], first);
    assert.deepStrictEqual(clicks[1], { href: 'blob:preview-2', download: 'First page.html' });
  } finally {
    restore();
  }
}

module.exports = [
  testWebPreviewDetectsFullHtmlResponsesWithoutTreatingSnippetsAsPages,
  testWebPreviewKeepsInteractiveDocumentContent,
  testWebPreviewDetectsEachCompletePageInOneResponse,
  testWebPreviewDialogHasNoVisualBorder,
  testWebPreviewOpensInNewWindowAndKeepsThePageSandboxed,
  testWebPreviewUiRendersInteractiveSandboxedIframe,
  testWebPreviewDownloadsTheActivePageFromCardAndModal,
  testWebPreviewCardsKeepMultiplePagesIndependent,
];
