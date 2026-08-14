'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const presentation = require('../../client/features/clarification/presentation');
const choiceWorkflowModule = require('../../client/app/clarification-choice-workflow');
const imageActionsModule = require('../../client/app/image-actions-workflow');
const clarification = require('../../shared/clarification-answer');

function routeInfo() {
  return {
    clarificationQuestion: '请确认编辑目标和风格参考图。',
    clarificationSlots: [
      {
        key: 'r1', type: 'image', role: 'target', reason: 'ambiguous',
        choices: [
          { key: 'c1', source: 'history', index: 1, id: 'image-a', resource_id: 'res:image:image-a', reference_id: 'ref-a', label: '橘猫原图 | result-a.png' },
          { key: 'c2', source: 'current', index: 2, id: 'image-b', resource_id: 'res:image:image-b', reference_id: 'ref-current', label: '白猫原图 | upload-b.png' },
        ],
      },
      {
        key: 'r2', type: 'image', role: 'style_reference', reason: 'ambiguous',
        choices: [
          { key: 'c3', source: 'quoted', index: 1, id: 'image-c', resource_id: 'res:image:image-c', reference_id: 'ref-c', label: '水彩风格 | style-c.png' },
          { key: 'c4', source: 'history', index: 2, id: 'image-d', resource_id: 'res:image:image-d', reference_id: 'ref-d', label: '油画风格 | style-d.png' },
        ],
      },
    ],
  };
}

function presentationOptions() {
  return {
    currentImageContext: {
      attachments: [
        { imageId: 'image-a', src: 'indexeddb://image-a', name: 'result-a.png' },
        { imageId: 'image-b', src: 'indexeddb://image-b', name: 'upload-b.png' },
        { imageId: 'image-c', src: 'indexeddb://image-c', name: 'style-c.png' },
        { imageId: 'image-d', src: 'indexeddb://image-d', name: 'style-d.png' },
      ],
    },
  };
}

function makePending() {
  return clarification.createPendingClarification({
    messages: [{ role: 'user', content: '把目标图改成参考图的风格' }],
    clarificationText: routeInfo().clarificationQuestion,
    routeInfo: {
      mode: 'chat', api: 'clarify', outcome: 'business_clarification',
      readiness: 'needs_clarification', needClarification: true,
      dispatchAuthorized: false, operationType: 'edit_image', relation: 'followup',
      resources: [], ...routeInfo(),
    },
  });
}

function buildDom(pending) {
  const rendered = presentation.buildClarificationPresentation(routeInfo(), presentationOptions());
  const dom = new JSDOM(`<!doctype html><div id="messages"><div class="message assistant" data-clarification-id="${pending.id}"><div class="content markdown-body">${rendered.html}</div></div></div>`);
  return { dom, rendered };
}

function clickEvent(target) {
  return { target, preventDefault() {}, stopPropagation() {} };
}

async function testImageClarificationRendersSelectableCardsAndSeparatePreviewControls() {
  const pending = makePending();
  const { dom, rendered } = buildDom(pending);
  const document = dom.window.document;

  assert.strictEqual(rendered.hasImageChoices, true);
  assert.strictEqual(document.querySelectorAll('.clarification-image-choice-select').length, 4,
    'every image candidate must expose the whole card as its selection button');
  assert.strictEqual(document.querySelectorAll('.clarification-choice-preview-button').length, 4,
    'preview must be a separate explicit control for every recoverable image');
  assert.match(rendered.html, /编辑目标/);
  assert.match(rendered.html, /风格参考/);
  assert.match(rendered.html, /第 1\/2 项/);
  assert.match(rendered.html, /历史图片/);
  assert.match(rendered.html, /本轮上传/);
  assert.match(rendered.html, /橘猫原图/);
}

async function testImageClickSelectsWhilePreviewButtonOnlyPreviews() {
  const pending = makePending();
  const { dom } = buildDom(pending);
  const document = dom.window.document;
  const session = { id: 'session-image-choice', pendingClarification: pending };
  const submissions = [];
  const previews = [];
  const workflow = choiceWorkflowModule.createClarificationChoiceWorkflow({
    state: { activeSessionId: session.id, sessions: [session] },
    document,
    messages: document.getElementById('messages'),
    saveSessionsMeta() {},
    onSubmit: async event => submissions.push(event),
    openImagePreview: async (src, filename) => previews.push({ src, filename }),
  });
  workflow.bind();

  const imageActions = imageActionsModule.createImageActionsWorkflow({
    document,
    window: dom.window,
    navigator: dom.window.navigator,
    URL: dom.window.URL,
    fetch: dom.window.fetch,
    getImageBlob: async () => null,
    toast() {},
    openImagePreview: async (src, filename) => previews.push({ src, filename }),
  });
  const message = document.querySelector('.message');
  imageActions.bindImagePreview(message);

  const targetImage = document.querySelector('[data-resource-key="r1"][data-choice-key="c1"] .clarification-choice-image');
  targetImage.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(previews.length, 0, 'clicking the image surface must select the card instead of opening the global preview');
  assert.strictEqual(session.pendingClarification.clarificationAnswer.answers[0].choice_key, 'c1');
  assert.strictEqual(submissions.length, 0, 'the first of two required slots must remain a partial local selection');

  const previewButton = document.querySelector('[data-resource-key="r1"][data-choice-key="c2"] .clarification-choice-preview-button');
  await workflow.onChoiceClick(clickEvent(previewButton));
  assert.deepStrictEqual(previews, [{ src: 'indexeddb://image-b', filename: 'upload-b.png' }]);
  assert.strictEqual(session.pendingClarification.clarificationAnswer.answers.length, 1,
    'previewing a candidate must not mutate the clarification answer');

  const styleCard = document.querySelector('[data-resource-key="r2"][data-choice-key="c3"] .clarification-image-choice-select');
  await workflow.onChoiceClick(clickEvent(styleCard));
  assert.strictEqual(submissions.length, 1, 'selecting the final required role must resume the task once');
}

function testImageClarificationLayoutUsesResponsiveColumnsAndUncroppedMedia() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/messages.css'), 'utf8');
  assert.match(css, /\.markdown-body \.clarification-image-list\{[\s\S]*?grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/,
    'desktop image clarification must use three adaptive columns');
  assert.match(css, /@media \(max-width:700px\)\{[\s\S]*?clarification-image-list[\s\S]*?repeat\(2,minmax\(0,1fr\)\)/,
    'tablet/mobile image clarification must collapse to two columns');
  assert.match(css, /@media \(max-width:420px\)\{[\s\S]*?clarification-image-list[\s\S]*?minmax\(0,1fr\)/,
    'narrow phones must use one image card per row');
  assert.match(css, /img\.clarification-choice-image[\s\S]*?object-fit:contain!important/,
    'candidate previews must not crop visual differences');
}

function testProductionBootstrapPassesThePreviewActionIntoTheChoiceWorkflow() {
  const bootstrap = fs.readFileSync(path.join(__dirname, '../../client/app/bootstrap-workflow.js'), 'utf8');
  const entry = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
  assert.match(bootstrap, /createClarificationChoiceWorkflow\(\{[^}]*openImagePreview/s);
  assert.match(entry, /createBootstrapWorkflow\(\{[^}]*openImagePreview:openImagePreview/s);
}

module.exports = [
  testImageClarificationRendersSelectableCardsAndSeparatePreviewControls,
  testImageClickSelectsWhilePreviewButtonOnlyPreviews,
  testImageClarificationLayoutUsesResponsiveColumnsAndUncroppedMedia,
  testProductionBootstrapPassesThePreviewActionIntoTheChoiceWorkflow,
];
