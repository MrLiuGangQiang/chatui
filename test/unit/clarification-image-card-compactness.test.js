'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const presentation = require('../../client/features/clarification/presentation');

function buildRenderedCard() {
  const routeInfo = {
    clarificationQuestion: '请选择要编辑的图片。',
    clarificationSlots: [{
      key: 'target',
      type: 'image',
      role: 'target',
      choices: [{
        key: 'choice-1',
        source: 'history',
        index: 1,
        id: 'image-1',
        reference_id: 'ref-1',
        label: '附件：11_评测.png、12_方案.png、13_业务.png',
      }],
    }],
  };
  const rendered = presentation.buildClarificationPresentation(routeInfo, {
    currentImageContext: {
      attachments: [{
        imageId: 'image-1',
        src: 'indexeddb://image-1',
        name: '11_评测.png',
      }],
    },
  });
  const dom = new JSDOM(`<!doctype html><div class="markdown-body">${rendered.html}</div>`);
  return { rendered, document: dom.window.document };
}

function testImageClarificationCardDoesNotRenderImageNames() {
  const { document } = buildRenderedCard();
  const card = document.querySelector('.clarification-image-choice-select');
  assert.ok(card, 'the image candidate must remain selectable');
  assert.strictEqual(card.querySelector('.clarification-choice-label'), null,
    'image candidate cards must not render a visible image-name row');
  assert.doesNotMatch(card.textContent, /(?:11_评测|12_方案|13_业务|\.png)/,
    'image filenames must not appear in the visible card copy');
  assert.match(card.textContent, /历史图片/);
  assert.match(card.textContent, /选择此图/);
  assert.strictEqual(
    document.querySelector('.clarification-choice-preview-button')?.dataset.previewFilename,
    '11_评测.png',
    'removing the visible filename must not break the preview filename metadata',
  );
}

function testImageClarificationThumbnailsUseCompactAutoFilledDesktopTracks() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/messages.css'), 'utf8');
  const dom = new JSDOM(`<!doctype html><style>${css}</style><div class="markdown-body"><div class="clarification-presentation" data-clarification-image-choices="1"><ol class="clarification-image-list"><li class="clarification-choice-card"><div class="clarification-image-choice-shell"><button class="clarification-choice-button clarification-image-choice-select"><span class="clarification-choice-media"></span><span class="clarification-image-choice-copy"></span></button></div></li></ol></div></div>`, {
    pretendToBeVisual: true,
  });
  const listStyle = dom.window.getComputedStyle(dom.window.document.querySelector('.clarification-image-list'));
  const cardStyle = dom.window.getComputedStyle(dom.window.document.querySelector('.clarification-image-choice-select'));
  assert.strictEqual(listStyle.gridTemplateColumns.replace(/\s+/g, ''), 'repeat(auto-fill,100px)',
    'clarification thumbnails must keep compact 100px tracks while deriving the per-row count from available width');
  assert.strictEqual(cardStyle.gridTemplateRows.replace(/\s+/g, ''), 'autoauto',
    'cards without a name row must not reserve the previous 76px copy area');
}

module.exports = [
  testImageClarificationCardDoesNotRenderImageNames,
  testImageClarificationThumbnailsUseCompactAutoFilledDesktopTracks,
];
