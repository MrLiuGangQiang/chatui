'use strict';

const assert = require('assert');
const attachmentsCore = require('../../client/core/attachments');
const routeContext = require('../../client/core/image-route-context');
const routeService = require('../../client/services/route-service');

function uploadedImageMessage(content, attachments) {
  return {
    role: 'user',
    content,
    rawText: content,
    imageContext: JSON.stringify({
      mode: 'chat',
      target: 'uploaded',
      attachments,
    }),
  };
}

function routeWirePayload(input, context) {
  const payload = routeService.buildRoutePayload({
    model: 'test-model',
    input,
    context,
  });
  return JSON.parse(payload.input[1].content);
}

function testUploadedImageLabelUsesSemanticDescriptionThenMeaningfulFilenameThenOrdinal() {
  const metadata = attachmentsCore.buildRouteAttachmentMetadata([
    {
      id: 'semantic-image',
      type: 'image/png',
      name: 'IMG_20260814_120000.png',
      description: '产品需求页面',
    },
    {
      id: 'named-image',
      type: 'image/png',
      name: 'C:\\uploads\\10_需求.png',
    },
    {
      id: 'generic-image',
      type: 'image/png',
      name: 'IMG_20260814_123456.png',
    },
  ]);

  assert.deepStrictEqual(
    metadata.map(item => item.label),
    ['产品需求页面', '10_需求', '第 3 张上传图片'],
  );
  assert.strictEqual(metadata[0].description, '产品需求页面');
}

function testHistoricalUploadedImagesKeepIndependentLabelsInsteadOfSharedUserPrompt() {
  const messages = [uploadedImageMessage('帮我看看这些图片', [
    {
      id: 'requirement-image',
      type: 'image/png',
      name: 'IMG_20260814_120000.png',
      src: 'indexeddb://requirement-image',
      description: '产品需求页面',
    },
    {
      id: 'evaluation-image',
      type: 'image/png',
      name: '11_评测.png',
      src: 'indexeddb://evaluation-image',
    },
  ])];

  const references = routeContext.collectRecentUploadedImageReferences({ messages });
  assert.deepStrictEqual(
    references[0].candidates.map(item => item.label),
    ['产品需求页面', '11_评测'],
  );
  assert.deepStrictEqual(
    references[0].candidates.map(item => item.description),
    ['产品需求页面', ''],
    'a filename fallback must not be persisted as a semantic description',
  );

  const context = routeContext.buildRouteContext({ messages });
  assert.ok(context.image_candidates.every(item => item.semantic_text.includes('帮我看看这些图片')));
  const wire = routeWirePayload('继续分析', context);
  assert.deepStrictEqual(
    wire.resource_candidates.filter(item => item.type === 'image').map(item => item.label),
    ['产品需求页面', '11_评测'],
  );
}

function testAttachmentPlaceholderTextNeverBecomesEachUploadedImageLabel() {
  const placeholderText = [
    '[image id=a1 name=10_需求.png type=image/png size=100]',
    '[image id=a2 name=11_评测.png type=image/png size=100]',
  ].join(' ');
  const messages = [uploadedImageMessage(placeholderText, [
    {
      id: 'a1',
      type: 'image/png',
      name: '10_需求.png',
      src: 'indexeddb://a1',
    },
    {
      id: 'a2',
      type: 'image/png',
      name: '11_评测.png',
      src: 'indexeddb://a2',
    },
  ])];

  const context = routeContext.buildRouteContext({ messages });
  const wireLabels = routeWirePayload('比较这两张图片', context)
    .resource_candidates
    .filter(item => item.type === 'image')
    .map(item => item.label);

  assert.deepStrictEqual(wireLabels, ['10_需求', '11_评测']);
  assert.ok(wireLabels.every(label => !label.includes('[image id=')));
  assert.strictEqual(new Set(wireLabels).size, 2);
}

function testRouteServiceUploadGuardRejectsPromptLabelsWithoutChangingGeneratedImageLabels() {
  const catalog = routeService.buildResourceCandidates([], {
    image_candidates: [
      {
        image_id: 'uploaded-generic',
        source: 'user_message',
        target: 'uploaded',
        index: 3,
        filename: 'IMG_20260814_123456.png',
        prompt: '帮我看看这些图片',
      },
      {
        image_id: 'generated-cat',
        source: 'history',
        target: 'previous',
        index: 4,
        filename: 'image-4.png',
        prompt: '一只坐在窗边的猫',
      },
    ],
  });

  assert.strictEqual(catalog[0].label, '第 3 张上传图片');
  assert.strictEqual(catalog[1].label, '一只坐在窗边的猫');
}

module.exports = [
  testUploadedImageLabelUsesSemanticDescriptionThenMeaningfulFilenameThenOrdinal,
  testHistoricalUploadedImagesKeepIndependentLabelsInsteadOfSharedUserPrompt,
  testAttachmentPlaceholderTextNeverBecomesEachUploadedImageLabel,
  testRouteServiceUploadGuardRejectsPromptLabelsWithoutChangingGeneratedImageLabels,
];
