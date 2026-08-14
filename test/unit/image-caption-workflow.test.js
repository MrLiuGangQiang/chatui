'use strict';

const assert = require('assert');

const imageCaptionWorkflow = require('../../client/app/image-caption-workflow');
const imageContextWorkflow = require('../../client/app/image-context-workflow');
const imageResultWorkflow = require('../../client/app/image-result-workflow');
const imageReferences = require('../../client/core/image-references');

function imageResultDeps(extra = {}) {
  let count = 0;
  return {
    extractImageResult: value => value,
    getConfig: () => ({ baseUrl: 'https://upstream.test/v1', chatModel: 'chat-model' }),
    persistImageSrc: async () => ({ persistedSrc: `indexeddb://result-${++count}`, displaySrc: 'blob:live-result' }),
    settleWithin: async value => value,
    imageSrcSize: async () => ({ width: 512, height: 512 }),
    makeImageItemId: (referenceId, ordinal) => `img_${referenceId}_${ordinal}`,
    escapeHtml: value => String(value),
    downloadAllImagesButtonHtml: () => '',
    saveLatestGeneratedImage: () => {},
    ...extra,
  };
}

function testImageTagMessagesArePromptOnlyWithoutVision() {
  const messages = imageCaptionWorkflow.buildImageCaptionMessages({
    images: [
      { prompt: 'an orange cat on a sofa' },
      { prompt: 'a golden retriever in the park' },
    ],
  });
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0].role, 'system');
  const user = String(messages[1].content || '');
  assert.ok(user.includes('1. an orange cat on a sofa'), 'prompt must be embedded in the user message');
  assert.ok(user.includes('2. a golden retriever in the park'), 'prompt must be embedded in the user message');
  const serialized = JSON.stringify(messages);
  assert.ok(!/image_url|data:image|type:\s*["']image/i.test(serialized), 'tag summarization must never embed image pixels');
  assert.ok(!Array.isArray(messages[1].content), 'user content is plain text, not a multimodal part list');
}

function testImageTagResponseParsesNumberedChineseLines() {
  const parsed = imageCaptionWorkflow.parseImageCaptionResponse(
    '1. 一只橘色小猫\n2. 一条金毛犬',
    2,
  );
  assert.deepStrictEqual(parsed, [
    { index: 1, description: '一只橘色小猫' },
    { index: 2, description: '一条金毛犬' },
  ]);
  const chinese = imageCaptionWorkflow.parseImageCaptionResponse('一、雪山日出\n二、海边日落', 2);
  assert.deepStrictEqual(chinese, [
    { index: 1, description: '雪山日出' },
    { index: 2, description: '海边日落' },
  ]);
}

function testImageTagResponseFallsBackToPositionalLinesAndSingleImage() {
  const positional = imageCaptionWorkflow.parseImageCaptionResponse('一只橘色小猫\n一条金毛犬', 2);
  assert.deepStrictEqual(positional, [
    { index: 1, description: '一只橘色小猫' },
    { index: 2, description: '一条金毛犬' },
  ]);
  const single = imageCaptionWorkflow.parseImageCaptionResponse('1. 一只橘色小猫', 1);
  assert.deepStrictEqual(single, [{ index: 1, description: '一只橘色小猫' }]);
  assert.deepStrictEqual(imageCaptionWorkflow.parseImageCaptionResponse('', 2), []);
  assert.deepStrictEqual(imageCaptionWorkflow.parseImageCaptionResponse('抱歉，我无法回答。', 2), []);
}

async function testImageTagDescribeSummarizesPromptsAndNeverSendsVision() {
  const seen = {};
  const workflow = imageCaptionWorkflow.createImageCaptionWorkflow({
    getConfig: () => ({ baseUrl: 'https://upstream.test/v1', chatModel: 'chat-model', apiKey: 'k' }),
    requestJson: async (url, payload, apiKey, options) => {
      seen.url = url;
      seen.payload = payload;
      seen.apiKey = apiKey;
      seen.options = options;
      return {
        choices: [{ message: { content: '1. 一只橘色小猫\n2. 一条金毛犬' } }],
      };
    },
  });
  const tags = await workflow.describeGeneratedImages(
    [
      { src: 'data:image/png;base64,cat', prompt: 'an orange cat on a sofa' },
      { src: 'data:image/png;base64,dog', prompt: 'a golden retriever in the park' },
    ],
    {},
  );
  assert.deepStrictEqual(tags, [
    { index: 1, description: '一只橘色小猫' },
    { index: 2, description: '一条金毛犬' },
  ]);
  assert.strictEqual(seen.url, 'https://upstream.test/v1/chat/completions');
  assert.strictEqual(seen.payload.model, 'chat-model');
  assert.strictEqual(seen.apiKey, 'k');
  assert.strictEqual(seen.options.requestPurpose, 'background_image_tag');
  const serialized = JSON.stringify(seen.payload.messages);
  assert.ok(serialized.includes('an orange cat on a sofa'), 'generation prompt must be sent');
  assert.ok(serialized.includes('a golden retriever in the park'), 'generation prompt must be sent');
  assert.ok(!/image_url|data:image|type:\s*["']image/i.test(serialized), 'payload must never embed image pixels');
}

async function testImageTagDescribeFallsBackToOverallPrompt() {
  const seen = {};
  const workflow = imageCaptionWorkflow.createImageCaptionWorkflow({
    getConfig: () => ({ baseUrl: 'https://upstream.test/v1', chatModel: 'chat-model' }),
    requestJson: async (url, payload, apiKey, options) => {
      seen.payload = payload;
      return { choices: [{ message: { content: '1. 一只橘色小猫' } }] };
    },
  });
  const tags = await workflow.describeGeneratedImages(
    [{ src: 'data:image/png;base64,cat' }],
    { prompt: 'a fluffy orange cat' },
  );
  assert.deepStrictEqual(tags, [{ index: 1, description: '一只橘色小猫' }]);
  assert.ok(JSON.stringify(seen.payload.messages).includes('a fluffy orange cat'));
}

async function testImageTagDescribeFailsSilently() {
  const workflow = imageCaptionWorkflow.createImageCaptionWorkflow({
    getConfig: () => ({ baseUrl: '', chatModel: '' }),
    requestJson: async () => { throw new Error('upstream down'); },
  });
  assert.deepStrictEqual(await workflow.describeGeneratedImages([{ prompt: 'a cat' }], {}), []);
  assert.deepStrictEqual(await workflow.describeGeneratedImages([], {}), []);

  const failing = imageCaptionWorkflow.createImageCaptionWorkflow({
    getConfig: () => ({ baseUrl: 'https://upstream.test/v1', chatModel: 'chat-model' }),
    requestJson: async () => { throw new Error('upstream down'); },
  });
  assert.deepStrictEqual(await failing.describeGeneratedImages([{ prompt: 'a cat' }], {}), []);
}

function testApplyImageTagsEnrichesRecordsAndKeepsFallback() {
  const images = [
    { ordinal: 1, prompt: '一只猫', description: '原始提示描述', labels: [], semantic_text: '原始提示描述' },
    { ordinal: 2, prompt: '一只狗', description: '原始提示描述2', labels: [], semantic_text: '原始提示描述2' },
  ];
  const enriched = imageCaptionWorkflow.applyImageCaptions(images, [
    { index: 1, description: '一只橘色小猫' },
  ]);
  assert.strictEqual(enriched[0].description, '一只橘色小猫');
  assert.strictEqual(enriched[0].label, '一只橘色小猫');
  assert.deepStrictEqual(enriched[0].labels, ['一只橘色小猫']);
  assert.ok(enriched[0].semantic_text.includes('一只橘色小猫'));
  assert.strictEqual(enriched[1].description, '原始提示描述2', 'missing tag keeps prompt-derived description');
  assert.ok(!Object.prototype.hasOwnProperty.call(enriched[0], 'caption'), 'tags never write a display caption field');

  const untouched = imageCaptionWorkflow.applyImageCaptions(images, []);
  assert.strictEqual(untouched[0].description, '原始提示描述');
  assert.ok(!Object.prototype.hasOwnProperty.call(untouched[0], 'caption'));
}

async function testImageResultHtmlAppliesPlanLabelSynchronously() {
  const saved = [];
  const deps = imageResultDeps({
    saveLatestGeneratedImage: (sessionId, latest) => saved.push(latest),
  });
  const result = await imageResultWorkflow.imageResultToHtml({
    kind: 'image',
    images: [
      { src: 'data:image/png;base64,one', raw: 'raw-1', prompt: 'an orange cat' },
      { src: 'data:image/png;base64,two', raw: 'raw-2', prompt: 'a golden retriever' },
    ],
  }, '1s', {
    resultId: 'imgres_tag_test',
    prompt: 'a cat and a dog',
    label: '一只橘色小猫',
  }, deps);

  const attachments = result.imageContext.attachments;
  assert.strictEqual(attachments[0].description, '一只橘色小猫', 'plan label must be applied to stored records');
  assert.strictEqual(attachments[0].label, '一只橘色小猫');
  assert.deepStrictEqual(attachments[0].labels, ['一只橘色小猫']);
  assert.ok(attachments[0].semantic_text.includes('一只橘色小猫'));
  assert.strictEqual(attachments[1].description, '一只橘色小猫');
  assert.ok(!Object.prototype.hasOwnProperty.call(attachments[0], 'caption'), 'no display caption field on stored records');
  assert.ok(!result.html.includes('generated-image-caption'), 'labels must not be rendered in the chat UI');
  assert.ok(!result.html.includes('data-image-caption'), 'no caption DOM attribute may exist');
  assert.ok(!result.html.includes('一只橘色小猫'), 'label text must not leak into the rendered HTML');
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].images[0].description, '一只橘色小猫', 'latest image records carry the plan label');
  assert.ok(!Object.prototype.hasOwnProperty.call(saved[0].images[0], 'caption'));
}

async function testImageResultHtmlWithoutTagPassKeepsPromptDescription() {
  const deps = imageResultDeps();
  const result = await imageResultWorkflow.imageResultToHtml({
    kind: 'image',
    images: [{ src: 'data:image/png;base64,one' }],
  }, '', { resultId: 'imgres_no_tag', prompt: 'a cat' }, deps);
  assert.strictEqual(result.imageContext.attachments[0].description, 'a cat');
  assert.ok(!result.html.includes('generated-image-caption'), 'no caption element without a tag pass');
  assert.ok(!result.html.includes('data-image-caption'), 'no caption DOM attribute without a tag pass');
}

function testRestoredImageRenderingNeverShowsStoredDescription() {
  const html = imageResultWorkflow.renderImageResultHtml([
    {
      imageId: 'restored',
      src: 'indexeddb://restored',
      persistedSrc: 'indexeddb://restored',
      displaySrc: 'blob:restored',
      width: 100,
      height: 80,
      description: '一只橘色小猫',
    },
  ], { escapeHtml: value => String(value), downloadAllImagesButtonHtml: () => '' });
  assert.ok(!html.includes('generated-image-caption'), 'restored images never render the stored description as a caption');
  assert.ok(!html.includes('一只橘色小猫'), 'stored tag text must stay out of the rendered HTML');
  assert.ok(html.includes('<img'), 'thumbnail itself is still rendered');
}

function testStoredDescriptionSurvivesAttachmentNormalizationForRouting() {
  const stored = require('../../client/core/attachments').normalizeStoredImageAttachment({
    id: 'img_1',
    imageId: 'img_imgref_1_1',
    referenceId: 'imgref_1',
    ordinal: 1,
    src: 'indexeddb://x',
    description: '一只橘色小猫',
    semantic_text: '一只橘色小猫 | a cat | 一只橘色小猫',
    labels: ['一只橘色小猫'],
  });
  assert.strictEqual(stored.description, '一只橘色小猫');
  assert.strictEqual(stored.semantic_text, '一只橘色小猫 | a cat | 一只橘色小猫');
  assert.deepStrictEqual(stored.labels, ['一只橘色小猫']);
}

async function testTagDescriptionReachesRouteCandidateLabels() {
  const directory = require('../../client/services/route-candidates').createRouteCandidateDirectory();
  const candidate = { type: 'image', index: 1, source: 'history' };
  const raw = {
    name: 'image-1.png',
    description: '一只橘色小猫',
    labels: ['一只橘色小猫'],
    semantic_text: '一只橘色小猫 | a cat | 一只橘色小猫',
  };
  const label = directory.routeCandidateLabel(candidate, raw);
  assert.ok(label.includes('一只橘色小猫'), 'route candidate label must surface the tag description');
  const selection = directory.routeCandidateSelectionText(candidate, raw);
  assert.ok(selection.includes('一只橘色小猫'), 'route candidate selection text must surface the tag description');
}

async function testPreviousImageAttachmentsCarryTagAsLabel() {
  const workflow = imageContextWorkflow.createImageContextWorkflow({
    getState: () => ({
      activeSessionId: 's1',
      lastGeneratedImage: {
        referenceId: 'imgref_latest',
        prompt: 'a cat and a dog',
        updatedAt: 1,
        images: [
          { imageId: 'img_imgref_latest_1', src: 'indexeddb://cat', filename: 'cat.png', description: '一只橘色小猫' },
          { imageId: 'img_imgref_latest_2', src: 'indexeddb://dog', filename: 'dog.png', description: '一条金毛犬' },
        ],
      },
      sessions: [{ id: 's1', lastGeneratedImage: null }],
    }),
    getActiveSession: () => ({}),
    normalizeLastGeneratedImage: value => value,
    findImageReferenceById: () => null,
    makeImageReferenceId: imageReferences.makeImageReferenceId,
    parseImageReferenceId: imageReferences.parseImageReferenceId,
    makeImageItemId: imageReferences.makeImageItemId,
    normalizeSelectedImageIds: imageReferences.normalizeSelectedImageIds,
    normalizeImageSelection: imageReferences.normalizeImageSelection,
    imageRefToFile: async (src, name) => ({ name, type: 'image/png', size: 10 }),
  });
  const attachments = await workflow.getPreviousImageAttachments('s1', null, 'latest', []);
  assert.strictEqual(attachments.length, 2);
  assert.strictEqual(attachments[0].label, '一只橘色小猫');
  assert.strictEqual(attachments[1].label, '一条金毛犬');
}

module.exports = [
  testImageTagMessagesArePromptOnlyWithoutVision,
  testImageTagResponseParsesNumberedChineseLines,
  testImageTagResponseFallsBackToPositionalLinesAndSingleImage,
  testImageTagDescribeSummarizesPromptsAndNeverSendsVision,
  testImageTagDescribeFallsBackToOverallPrompt,
  testImageTagDescribeFailsSilently,
  testApplyImageTagsEnrichesRecordsAndKeepsFallback,
  testImageResultHtmlAppliesPlanLabelSynchronously,
  testImageResultHtmlWithoutTagPassKeepsPromptDescription,
  testRestoredImageRenderingNeverShowsStoredDescription,
  testStoredDescriptionSurvivesAttachmentNormalizationForRouting,
  testTagDescriptionReachesRouteCandidateLabels,
  testPreviousImageAttachmentsCarryTagAsLabel,
];
