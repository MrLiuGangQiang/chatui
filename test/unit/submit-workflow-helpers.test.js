const assert = require('assert');

const helpers = require('../../client/app/submit-workflow.helpers');
const messagePrimitives = require('../../client/core/message-primitives');
const attachments = require('../../client/core/attachments');
const routeService = require('../../client/services/route-service');

function testSubmitHelpersParseAndPreviewQuoteContext() {
  assert.deepStrictEqual(helpers.parseContextValue('{"role":"user","content":" hello  world "}'), { role: 'user', content: ' hello  world ' });
  assert.strictEqual(helpers.parseContextValue('{bad'), null);
  assert.deepStrictEqual(helpers.parseContextValue({ ok: true }), { ok: true });
  assert.strictEqual(helpers.parseContextValue, messagePrimitives.parseContext, 'submit helpers should reuse the shared context parser');
  assert.strictEqual(helpers.parseContextValue('[]'), null, 'non-object context payloads should fail closed');
  const preview = helpers.previewQuoteText('  第一行\n第二行  '.repeat(10));
  assert.strictEqual(preview.length, 48);
  assert.ok(preview.startsWith('第一行 第二行 第一行 第二行'));
  const html = helpers.withPendingQuotePreview('<p>正文</p>', { role: 'assistant', content: '<b>结果</b>' });
  assert.ok(html.includes('sent-quote-preview'));
  assert.ok(html.includes('追问 AI'));
  assert.ok(html.includes('&lt;b&gt;结果&lt;/b&gt;'));
  assert.ok(html.endsWith('<p>正文</p>'));
  assert.strictEqual(helpers.withPendingQuotePreview('<button class="sent-quote-preview"></button>', { role: 'user', content: 'x' }), '<button class="sent-quote-preview"></button>');
}

function testQuotedRouteContextUsesOneCanonicalIdentityPolicy() {
  const quotedMessage = {
    role: 'assistant',
    content: '  参考这张产品图  ',
    display_item_id: 'quote-message-1',
  };
  const persistedImage = {
    image_id: 'img_imgref_product_2',
    filename: '产品参考.png',
    type: 'image/png',
  };
  const result = helpers.buildQuotedRouteContext({
    quotedMessage,
    quotedImageContext: {
      target: 'uploaded',
      attachments: [persistedImage],
      prompt: '旧提示词',
    },
    restoredImageAttachments: [],
    quotedFileCandidates: [{ index: 1, id: 'file-1', name: '规格书.pdf' }],
    currentInput: '按这个风格生成海报',
    cleanQuotedContent: routeService.cleanQuotedContent,
    buildQuotedRouteContent: routeService.buildQuotedRouteContent,
  });

  assert.strictEqual(result.hasQuotedMessage, true);
  assert.strictEqual(result.hasQuotedImage, true, 'persisted image metadata must remain routable when IndexedDB restoration is unavailable');
  assert.strictEqual(result.context.quoted_message.id, 'quote-message-1');
  assert.strictEqual(result.context.image_candidates[0].image_id, 'img_imgref_product_2');
  assert.strictEqual(result.context.image_candidates[0].reference_id, 'imgref_product');
  assert.strictEqual(result.context.image_candidates[0].filename, '产品参考.png');
  assert.strictEqual(result.context.latest_uploaded_image.reference_id, 'imgref_product');
  assert.strictEqual(result.context.latest_assistant_image_result, null);
  assert.deepStrictEqual(result.context.file_candidates, [{ index: 1, id: 'file-1', name: '规格书.pdf' }]);
  assert.match(result.context.suggested_contextual_image_prompt, /参考这张产品图[\s\S]*按这个风格生成海报/);
}

function testSubmitHelpersImageIndexGuidePreservesOriginalIndexes() {
  assert.strictEqual(helpers.originalImageIndex({ sourceIndex: 3, imageId: 'img_any_1' }, 0), 3);
  assert.strictEqual(helpers.originalImageIndex({ imageId: 'img_ref_4' }, 0), 4);
  const guide = helpers.imageAttachmentIndexGuide([
    { sourceIndex: 2, imageId: 'img_a_2', name: '第二张.png', type: 'image/png' },
    { sourceIndex: 5, imageId: 'img_a_5', name: '第五张.png', type: 'image/png' },
  ]);
  assert.ok(guide.includes('图片引用说明'));
  assert.ok(guide.includes('当前随附图片1 = 原消息第2张'));
  assert.ok(guide.includes('image_id=img_a_5'));
  assert.strictEqual(helpers.imageAttachmentIndexGuide([{ imageId: 'img_a_1', type: 'image/png' }]), '');
}

function testRouteMessageContextProjectionUsesOnlyResolvedBindings() {
  const history = [
    { role: 'user', content: 'older request', displayItemId: 'message-1' },
    { role: 'assistant', content: 'selected answer', displayItemId: 'message-2' },
    { role: 'user', content: 'newer unrelated request', displayItemId: 'message-3' },
  ];
  const route = { messageRefs: [{ key: 'r1', index: 2, message_id: 'message-2', source: 'history' }] };
  const projection = helpers.projectRouteMessageContext(route, history);
  assert.deepStrictEqual(projection.messages, [history[1]], 'the execution base must contain the route-selected message only');
  assert.strictEqual(projection.protectedMessageCount, 1);
  assert.strictEqual(projection.usesExplicitQuote, false);

  assert.strictEqual(helpers.projectRouteMessageContext({ messageRefs: [{ key: 'r1', index: 2, message_id: 'missing', source: 'history' }] }, history), null, 'a stale message id must fail closed');

  const explicitQuote = { role: 'assistant', content: 'quoted answer', displayItemId: 'quote-1' };
  const quoteProjection = helpers.projectRouteMessageContext({ messageRefs: [{ key: 'r1', index: 1, message_id: 'quote-1', source: 'history' }] }, history, explicitQuote);
  assert.deepStrictEqual(quoteProjection.messages, [explicitQuote]);
  assert.strictEqual(quoteProjection.usesExplicitQuote, true, 'the UI quote is allowed only when it matches the route binding');
}

function testRouteExecutionMediaProjectionIsCanonicalAndRoleAware() {
  const route = {
    executionResources: {
      version: 'execution_resources.v1',
      operation: 'edit_image',
      images: [
        { key: 'r1', type: 'image', source: 'current', role: 'target', index: 1, id: 'target', reference_id: '', missing: false },
        { key: 'r2', type: 'image', source: 'current', role: 'mask', index: 2, id: 'mask', reference_id: '', missing: false },
      ],
      files: [],
    },
  };
  const media = helpers.projectRouteExecutionMedia(route, {
    imagePools: { current: [{ id: 'target' }, { id: 'mask' }] },
  });
  assert.deepStrictEqual(media.targets.map(item => item.routeResourceKey), ['r1']);
  assert.deepStrictEqual(media.masks.map(item => item.routeResourceKey), ['r2']);
  assert.throws(
    () => helpers.projectRouteExecutionMedia({ taskContract: {} }, {}),
    error => error.code === 'EXECUTION_RESOURCE_PROJECTION_MISSING'
  );
}

async function testExecutionResourcePoolsKeepSourcesSeparateAndRestoreSelectedHistoryFiles() {
  const route = {
    executionResources: {
      version: 'execution_resources.v1',
      operation: 'multimodal_qa',
      images: [{ key: 'r1', type: 'image', source: 'quoted', role: 'source', index: 1, id: 'quoted-image', reference_id: 'quoted-ref', identity_aliases: [], index_aliases: [] }],
      files: [{ key: 'r2', type: 'file', source: 'history', role: 'attachment', index: 1, id: 'history-file', reference_id: '', identity_aliases: [], index_aliases: [] }],
    },
  };
  const messages = [{
    role: 'user',
    attachmentContext: JSON.stringify({ attachments: [
      { id: 'history-file', name: 'selected.txt', type: 'text/plain', text: 'selected body' },
      { id: 'unselected-file', name: 'other.txt', type: 'text/plain', text: 'other body' },
    ] }),
  }];
  const restoredHistory = await helpers.restoreHistoricalFilePool(route, {
    messages,
    isImageFile: item => String(item?.type || '').startsWith('image/'),
    restoreUserAttachmentsFromContext: async context => context.attachments.map(item => ({
      attachmentId: item.id,
      name: item.name,
      type: item.type,
      text: item.text,
    })),
  });
  assert.deepStrictEqual(restoredHistory.map(item => item.attachmentId), ['history-file']);

  const pools = helpers.buildExecutionResourcePools({
    current: [{ attachmentId: 'current-file', type: 'text/plain' }],
    quoted: [{ imageId: 'quoted-image', referenceId: 'quoted-ref', type: 'image/png' }],
    history: restoredHistory,
  });
  const media = helpers.projectRouteExecutionMedia(route, pools);
  assert.deepStrictEqual(media.chatImages.map(item => item.routeSource), ['quoted']);
  assert.deepStrictEqual(media.chatFiles.map(item => item.attachmentId), ['history-file']);
  assert.ok(!media.chatFiles.some(item => item.attachmentId === 'current-file'), 'an unselected current file must not leak into execution');
}

function testContinuationAttachmentPoolReachesTheCanonicalChatRequest() {
  const originalWorkbook = {
    attachmentId: 'workbook-low-code',
    name: 'low-code-scope.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 2048,
    inputFile: true,
    file: { name: 'low-code-scope.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 2048 },
  };
  const requestAttachments = helpers.mergeContinuationAttachments({
    pending: [originalWorkbook],
    current: [{ ...originalWorkbook }],
  });
  assert.strictEqual(requestAttachments.length, 1, 'the restored workbook must be carried once even if the answer turn also references it');

  const metadata = attachments.buildRouteAttachmentMetadata(requestAttachments);
  const routePayload = routeService.buildRoutePayload({ model: 'route-model', input: '按人日估算全部适合低代码的功能', attachments: metadata });
  const routeUserPayload = JSON.parse(routePayload.messages[1].content);
  assert.strictEqual(routeUserPayload.attachments[0].file_id, 'workbook-low-code', 'the full router must receive the restored workbook as a current request attachment');

  const route = routeService.parseRouteResult(JSON.stringify({
    schema_version: 'route_decision.v1', readiness: 'ready', operation: 'file_qa', relation: 'continuation',
    bindings: [{ candidate_key: 'f1', role: 'attachment' }], changes: [], constraints: [],
    clarification: { question: '', unresolved: [] }, confidence: 0.99, rationale: 'the restored workbook is required for the estimate',
  }), { input: '按人日估算全部适合低代码的功能', attachments: metadata, context: {} });
  assert.ok(route);
  const execution = helpers.projectRouteExecutionMedia(route, helpers.buildExecutionResourcePools({ current: requestAttachments }));
  assert.deepStrictEqual(execution.chatFiles.map(item => item.attachmentId), ['workbook-low-code'], 'the same restored workbook must be the only file sent to chat execution');
}

module.exports = [
  testSubmitHelpersParseAndPreviewQuoteContext,
  testQuotedRouteContextUsesOneCanonicalIdentityPolicy,
  testSubmitHelpersImageIndexGuidePreservesOriginalIndexes,
  testRouteMessageContextProjectionUsesOnlyResolvedBindings,
  testRouteExecutionMediaProjectionIsCanonicalAndRoleAware,
  testExecutionResourcePoolsKeepSourcesSeparateAndRestoreSelectedHistoryFiles,
  testContinuationAttachmentPoolReachesTheCanonicalChatRequest,
];
