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
  assert.match(rendered.html, /class="clarification-choice-number">1</);
  assert.match(rendered.html, /class="clarification-choice-number">2</);
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
  assert.match(css, /\.markdown-body \.clarification-image-list\s*\{[^}]*display:grid!important;/s);
  assert.match(css, /\.markdown-body \.clarification-image-list\s*\{[^}]*grid-template-columns:repeat\(auto-fill,minmax\([^;]+\)\);[^}]*grid-auto-flow:row;/s);
  assert.match(css, /\.markdown-body \.clarification-image-list>\.clarification-choice-card\s*\{[^}]*display:grid!important;[^}]*grid-template-columns:[^;]+!important;[^}]*align-items:center!important;[^}]*gap:[^;]+!important;/s);
  assert.match(css, /\.markdown-body \.clarification-image-list>\.clarification-choice-card::before\s*\{[^}]*content:none!important;[^}]*display:none!important;/s);
  assert.match(css, /\.clarification-image-list\s*\{[^}]*padding:0!important;[^}]*list-style:none!important;/s);
}

module.exports = [
  testImageClarificationQuestionDoesNotInlineCandidateMetadata,
  testImageClarificationRendersNumberedDurableThumbnails,
  testClarificationPreviewsNeverBecomeNewImageCandidates,
  testClarificationThumbnailHtmlSurvivesCanonicalPersistence,
  testRouteCandidateDisplayLabelIsShortAndDeduplicated,
  testClarificationListOverridesGlobalMarkdownTableLayout,
];
