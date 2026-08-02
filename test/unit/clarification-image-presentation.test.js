'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const intentContract = require('../../client/core/intent-contract');
const imageRouteContext = require('../../client/core/image-route-context');
const imageContextWorkflow = require('../../client/app/image-context-workflow');
const routeService = require('../../client/services/route-service');
const presentation = require('../../client/features/clarification/presentation');
const messageRecords = require('../../client/app/message-records');
const persistence = require('../../client/app/persistence');
const clarification = require('../../client/services/clarification-service');
const submitWorkflow = require('../../client/app/submit-workflow');

function ambiguousImageContract(choices) {
  return {
    schema_version: 'task_contract.v5',
    readiness: 'needs_clarification',
    operation: 'edit_image',
    relation: 'followup',
    resources: [],
    directive: {
      mode: 'patch',
      base_resource_keys: ['r1'],
      unmentioned_policy: 'preserve',
      operations: [{ op: 'replace', target: '狗的颜色', value: '用户指定的新颜色' }],
      constraints: [],
    },
    clarification: {
      question: '检测到多张狗的图片。请选择要修改的其中一张。',
      unresolved_resources: [{ key: 'r1', type: 'image', role: 'target', reason: 'ambiguous', choices }],
    },
    confidence: 0.95,
    review_reasons: [],
    rationale: 'multiple dog images match the target',
  };
}

function dogMessages() {
  return [
    { role: 'user', content: '画一只狗', rawText: '画一只狗', messageIndex: 0 },
    {
      role: 'assistant', content: '[图片生成完成] 画一只狗', responseIndex: 1, id: 'dog-first',
      imageContext: JSON.stringify({ attachments: [{ src: 'indexeddb://dog-first', name: '20260727201719.png' }] }),
    },
    { role: 'user', content: '再画一只狗', rawText: '再画一只狗', messageIndex: 2 },
    {
      role: 'assistant', content: '[图片生成完成] 再画一只狗', responseIndex: 3, id: 'dog-second',
      imageContext: JSON.stringify({ attachments: [{ src: 'indexeddb://dog-second', name: '20260727202021.png' }] }),
    },
  ];
}

function routeChoices(messages) {
  return imageRouteContext.collectRecentImageReferences({ messages, limit: 10 }).map((reference, index) => ({
    key: `c${index + 1}`,
    source: 'history',
    index: index + 1,
    id: reference.candidates[0].image_id,
    reference_id: reference.reference_id,
    label: `狗的颜色换一下 | ${reference.candidates[0].filename} | dog | 狗的颜色换一下`,
  }));
}

function testImageClarificationQuestionDoesNotInlineCandidateMetadata() {
  const choices = routeChoices(dogMessages());
  const plan = intentContract.taskContractToExecutionPlan(ambiguousImageContract(choices), { input: '把狗的颜色换一下' });
  assert.strictEqual(plan.clarificationQuestion, '检测到多张狗的图片。请选择要修改的其中一张。');
  assert.doesNotMatch(plan.clarificationQuestion, /20260727|\| dog|(?:^|\n)1\./);
  assert.deepStrictEqual(plan.clarificationSlots[0].choices, choices, 'stable choice identity must remain in the structured plan');
}

function testImageClarificationRendersNumberedDurableThumbnails() {
  const messages = dogMessages();
  const choices = routeChoices(messages);
  const routeInfo = intentContract.taskContractToExecutionPlan(ambiguousImageContract(choices));
  const rendered = presentation.buildClarificationPresentation(routeInfo, { messages });
  assert.strictEqual(rendered.rawText, routeInfo.clarificationQuestion);
  assert.strictEqual(rendered.hasImageChoices, true);
  assert.match(rendered.html, /class="clarification-image-list"/);
  assert.match(rendered.html, /data-clarification-image-choices="1"/);
  assert.match(rendered.html, /class="clarification-choice-media"><span class="clarification-choice-number" aria-hidden="true">1<\/span><img[^>]+alt="候选图片 1"[^>]*><\/div>/);
  assert.match(rendered.html, /class="clarification-choice-media"><span class="clarification-choice-number" aria-hidden="true">2<\/span><img[^>]+alt="候选图片 2"[^>]*><\/div>/);
  assert.match(rendered.html, /请回复一个编号/);
  assert.match(rendered.html, /一次只能选择一张图片/);
  assert.doesNotMatch(rendered.html, /全部|所有|都要/);
  assert.match(rendered.html, /data-choice-key="c1"/);
  assert.match(rendered.html, /data-choice-key="c2"/);
  assert.match(rendered.html, /data-persisted-src="indexeddb:\/\/dog-second"/);
  assert.match(rendered.html, /data-persisted-src="indexeddb:\/\/dog-first"/);
  assert.doesNotMatch(rendered.html, /clarification-choice-label/);
  assert.doesNotMatch(rendered.html, /data-filename/);
  assert.doesNotMatch(rendered.html, /20260727202021\.png/);
  assert.doesNotMatch(rendered.html, /20260727201719\.png/);
  assert.doesNotMatch(rendered.html, /\| dog|dog \|/);
  assert.ok(rendered.html.indexOf('data-choice-key="c1"') < rendered.html.indexOf('data-choice-key="c2"'), 'reply 2 must keep mapping to the second structured choice');
}

function testPendingAssistanceReusesDegradedImageChoicesInsteadOfClaimingTheyWereShown() {
  const messages = dogMessages();
  const choices = routeChoices(messages);
  const pending = clarification.createPendingClarification({
    messages: [...messages, { role: 'user', content: '不是这只狗，替换成你生成的狗' }],
    clarificationText: '请确认要替换成哪一张狗图。',
    routeInfo: {
      mode: 'chat', api: 'clarify', readiness: 'needs_clarification', needClarification: true,
      clarificationQuestion: '请确认要替换成哪一张狗图。',
      clarificationSlots: [{ key: 'r2', type: 'image', role: 'reference', reason: 'ambiguous', choices }],
      taskContract: null,
      clarificationDegraded: true,
      requiresRerouteAfterClarification: true,
    },
  });
  const assistantReply = '可以，我会把两张候选图片展示给你，请回复要选择的那一张。';
  const rendered = submitWorkflow.buildPendingAssistancePresentation({
    pending,
    assistantReply,
    clarificationService: clarification,
    presentationApi: presentation,
    presentationOptions: { messages },
  });
  assert.strictEqual(rendered.rawText, assistantReply);
  assert.strictEqual(rendered.hasImageChoices, true);
  assert.strictEqual(rendered.displayContent, rendered.html);
  assert.match(rendered.html, /data-clarification-image-choices="1"/);
  assert.strictEqual((rendered.html.match(/class="clarification-choice-card"/g) || []).length, 2);
  assert.strictEqual((rendered.html.match(/class="clarification-choice-image"/g) || []).length, 2);
  assert.match(rendered.html, /data-persisted-src="indexeddb:\/\/dog-second"/);
  assert.match(rendered.html, /data-persisted-src="indexeddb:\/\/dog-first"/);
}

function testPendingAssistanceWithoutImageChoicesRemainsPlainText() {
  const pending = clarification.createPendingClarification({
    messages: [{ role: 'user', content: '把猫改一种颜色' }],
    clarificationText: '请选择一种颜色。',
    routeInfo: {
      mode: 'chat', api: 'clarify', needClarification: true,
      clarificationQuestion: '请选择一种颜色。',
      clarificationSlots: [{ key: 'r1', type: 'text', role: 'source', reason: 'missing', choices: [] }],
      taskContract: null,
    },
  });
  const rendered = submitWorkflow.buildPendingAssistancePresentation({
    pending,
    assistantReply: '共有 8 种颜色。',
    clarificationService: clarification,
    presentationApi: presentation,
  });
  assert.strictEqual(rendered.hasImageChoices, false);
  assert.strictEqual(rendered.html, '');
  assert.strictEqual(rendered.displayContent, '共有 8 种颜色。');
}

function testClarificationPreviewsNeverBecomeNewImageCandidates() {
  const messages = dogMessages();
  const choices = routeChoices(messages);
  const routeInfo = intentContract.taskContractToExecutionPlan(ambiguousImageContract(choices));
  const rendered = presentation.buildClarificationPresentation(routeInfo, { messages });
  const withClarification = [...messages, {
    role: 'assistant', content: rendered.rawText, rawText: rendered.rawText, html: rendered.html, responseIndex: 4,
  }];
  const references = imageRouteContext.collectRecentImageReferences({ messages: withClarification, limit: 10 });
  assert.strictEqual(references.length, 2, 'candidate previews must not be scanned as a third generated image result');

  const workflow = imageContextWorkflow.createImageContextWorkflow({ getState: () => ({}), getActiveSession: () => ({ messages: [], display: [] }) });
  const node = {
    matches: () => false,
    querySelector: selector => selector === '[data-clarification-image-choices="1"]' ? {} : null,
  };
  assert.strictEqual(workflow.getAssistantImageContext(node), null, 'quoting a clarification card must not attach all preview images');
}

function testClarificationThumbnailHtmlSurvivesCanonicalPersistence() {
  const messages = dogMessages();
  const choices = routeChoices(messages);
  const routeInfo = intentContract.taskContractToExecutionPlan(ambiguousImageContract(choices));
  const rendered = presentation.buildClarificationPresentation(routeInfo, { messages });
  const normalized = messageRecords.normalizeCanonicalMessage({
    role: 'assistant', content: rendered.rawText, rawText: rendered.rawText, html: rendered.html, responseIndex: 4,
  }, { sessionId: 'dogs', sequence: 4 });
  assert.strictEqual(normalized.presentation.kind, 'text');
  assert.match(normalized.html, /clarification-image-list/);
  const stored = persistence.sanitizeStoredMessage(normalized);
  assert.match(stored.html, /data-persisted-src="indexeddb:\/\/dog-second"/);
  assert.match(stored.html, /data-persisted-src="indexeddb:\/\/dog-first"/);
  assert.doesNotMatch(stored.html, /blob:|data:image/);
}

function testRouteCandidateDisplayLabelIsShortAndDeduplicated() {
  const catalog = routeService.buildRouteResourceCandidates({ context: { image_candidates: [{
    index: 1,
    source: 'history',
    image_id: 'img_imgref_dog_1',
    reference_id: 'imgref_dog',
    filename: '20260727202021.png',
    semantic_text: '狗的颜色换一下 | 20260727202021.png | dog | 狗的颜色换一下',
    description: '狗的颜色换一下',
    prompt: '狗的颜色换一下',
    labels: ['dog'],
  }] } });
  assert.strictEqual(catalog.length, 1);
  assert.strictEqual(catalog[0].label, '20260727202021.png · 狗的颜色换一下');
  assert.doesNotMatch(catalog[0].label, /\|/);
}

function testClarificationListOverridesGlobalMarkdownTableLayout() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/messages.css'), 'utf8');
  assert.match(css, /\.clarification-presentation\s*\{[^}]*width:min\(640px,calc\(100vw - 112px\)\);/s);
  assert.match(css, /\.markdown-body \.clarification-image-list\s*\{[^}]*--clarification-image-height:72px;[^}]*--clarification-image-width:96px;[^}]*display:grid!important;[^}]*grid-template-columns:repeat\(3,max-content\);[^}]*grid-auto-flow:row;[^}]*justify-content:start;/s);
  assert.match(css, /\.markdown-body \.clarification-image-list>\.clarification-choice-card\s*\{[^}]*display:inline-flex!important;[^}]*align-items:stretch;[^}]*justify-self:center;[^}]*width:max-content;[^}]*overflow:visible;[^}]*border:0;[^}]*background:transparent;[^}]*box-shadow:none;/s);
  assert.doesNotMatch(css, /\.markdown-body \.clarification-image-list>\.clarification-choice-card\s*\{[^}]*position:relative;/s);
  assert.match(css, /\.clarification-choice-number\s*\{[^}]*position:static!important;[^}]*order:0;[^}]*align-self:stretch;[^}]*height:auto;[^}]*margin:0!important;[^}]*padding:0!important;[^}]*background:#2563eb;/s);
  assert.doesNotMatch(css, /\.clarification-choice-number\s*\{[^}]*position:absolute;/s);
  assert.match(css, /\.clarification-choice-media\s*\{[^}]*display:inline-flex!important;[^}]*position:static!important;[^}]*align-items:stretch;[^}]*gap:0!important;[^}]*column-gap:0!important;[^}]*width:max-content;[^}]*height:auto;/s);
  assert.match(css, /\.clarification-choice-media\[data-choice-number\]::after\s*\{[^}]*content:none!important;[^}]*display:none!important;/s);
  assert.match(css, /\.markdown-body img\.clarification-choice-image,\s*\.markdown-body img\.clarification-choice-image\[data-markdown-media-bound="1"\]\s*\{[^}]*width:var\(--clarification-image-width\)!important;[^}]*height:var\(--clarification-image-height\)!important;[^}]*min-width:var\(--clarification-image-width\)!important;[^}]*min-height:var\(--clarification-image-height\)!important;[^}]*max-width:var\(--clarification-image-width\)!important;[^}]*max-height:var\(--clarification-image-height\)!important;[^}]*aspect-ratio:4\/3!important;[^}]*object-fit:cover!important;/s);
  assert.doesNotMatch(css, /\.markdown-body img\.clarification-choice-image[^}]*max-width:100%/s);
  assert.match(css, /\.markdown-body \.clarification-image-list>\.clarification-choice-card::before\s*\{[^}]*content:none!important;[^}]*display:none!important;/s);
  assert.match(css, /\.clarification-image-list\s*\{[^}]*padding:0!important;[^}]*list-style:none!important;/s);
}

function testMessageImagesDoNotInheritGenericFrames() {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/messages.css'), 'utf8');
  assert.match(css, /\.message \.content img:not\(\.image-missing\),\s*\.message \.markdown-body img:not\(\.image-missing\)\s*\{[^}]*border:0!important;[^}]*background:transparent!important;[^}]*box-shadow:none!important;/s);
}

module.exports = [
  testImageClarificationQuestionDoesNotInlineCandidateMetadata,
  testImageClarificationRendersNumberedDurableThumbnails,
  testPendingAssistanceReusesDegradedImageChoicesInsteadOfClaimingTheyWereShown,
  testPendingAssistanceWithoutImageChoicesRemainsPlainText,
  testClarificationPreviewsNeverBecomeNewImageCandidates,
  testClarificationThumbnailHtmlSurvivesCanonicalPersistence,
  testRouteCandidateDisplayLabelIsShortAndDeduplicated,
  testClarificationListOverridesGlobalMarkdownTableLayout,
  testMessageImagesDoNotInheritGenericFrames,
];
