"use strict";

const assert = require("assert");
const routeService = require("../../client/services/route-service");

function fixture(id) {
  const suite = require("../fixtures/intent-routing-eval.v3.json");
  return suite.cases.find(item => item.id === id);
}

function payloadFor(id) {
  const item = fixture(id);
  return routeService.buildRoutePayload({
    model: "route-model",
    input: item.input,
    attachments: item.attachments || [],
    context: item.context || {},
    currentMode: item.current_mode || "chat",
    autoMode: item.auto_mode !== false,
    currentTurn: item.current_turn || null,
  });
}

function testRouteOperationSchemaIsModelOwned() {
  const cases = [
    'recent-image-comparison-after-generation',
    'current-image-ocr-uses-current-image',
    'content-and-style-references-keep-separate-roles',
    'prompt-writing-request-stays-plain-chat',
  ];
  const expected = ['plain_chat', 'web_search', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image'];
  for (const id of cases) assert.deepStrictEqual(payloadFor(id).text.format.schema.properties.operation.enum, expected);
}

function testRouteOperationSchemaDoesNotNarrowFromAttachmentKeywords() {
  const expected = ['plain_chat', 'web_search', 'file_qa', 'multimodal_qa', 'image_qa', 'image_compare', 'ocr', 'text_to_image', 'image_reference_gen', 'edit_image'];
  for (const id of ['mixed-attachments-image-only-selects-image', 'mixed-attachments-file-only-selects-file', 'current-image-and-file-need-multimodal-answer']) {
    assert.deepStrictEqual(payloadFor(id).text.format.schema.properties.operation.enum, expected);
  }
}

function testDeterministicPoliciesPreserveTheDifferenceBetweenContinuationAndFollowup() {
  const continuation = payloadFor("history-reference-continuation-keeps-continuation");
  assert.deepStrictEqual(continuation.text.format.schema.properties.relation.enum, ["new", "followup", "continuation"]);
  const correction = payloadFor("history-reference-correction-keeps-correction");
  assert.deepStrictEqual(correction.text.format.schema.properties.relation.enum, ["followup"]);
  const amendment = payloadFor("multi-text-to-image-amendment-keeps-shared-prior-specification");
  assert.deepStrictEqual(amendment.text.format.schema.properties.goal_mode.enum, ["amend"]);
}

function testUnavailableHistoricalFileStillSelectsFileOperation() {
  const item = fixture('missing-history-file-requires-clarification');
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: item.input,
    attachments: item.attachments || [],
    context: item.context || {},
  });
  assert.ok(payload.text.format.schema.properties.operation.enum.includes('file_qa'));
}

function testExplicitWebSearchDirectiveTightensTheOperationSchema() {
  assert.deepStrictEqual(
    routeService.deterministicOperationKeysForInput('搜索最新AI新闻', {}, []),
    ['web_search'],
  );
  const payload = routeService.buildRoutePayload({
    model: 'route-model',
    input: '搜索最新AI新闻',
    attachments: [],
    context: {},
  });
  assert.ok(payload.text.format.schema.properties.operation.enum.includes('web_search'));
  // 对本地文件的“搜索”不是联网检索，不应被确定性收窄为 web_search。
  assert.strictEqual(
    routeService.deterministicOperationKeysForInput('搜索这个文件里的数据', {}, [
      { type: 'file', candidate_key: 'f1', source: 'current', availability: 'available' },
    ]),
    null,
  );
}

function testRoutePromptDocumentsWebSearchAndEditVsReferenceBoundary() {
  const simplePrompt = routeService.ROUTE_NODE_SYSTEM_PROMPT_SIMPLE;
  assert.match(simplePrompt, /web_search 判定/);
  assert.match(simplePrompt, /沿用参考图生新版本/);
  assert.match(simplePrompt, /image_reference_gen用reference/);
}

function testTextFocusContinuationStaysPlainChatDespiteHistoryImages() {
  const image = [{ type: 'image', candidate_key: 'i1', source: 'history', availability: 'available' }];
  const textFocus = { conversation_focus: { schema_version: 'conversation_focus.v1', kind: 'text' } };
  assert.deepStrictEqual(
    routeService.deterministicOperationKeysForInput('数据库表呢', textFocus, image),
    ['plain_chat'],
  );
  assert.deepStrictEqual(
    routeService.deterministicOperationKeysForInput('哪个效果最好', textFocus, image),
    ['plain_chat'],
  );
  assert.deepStrictEqual(
    routeService.deterministicOperationKeysForInput('哪个效果最好', { conversation_focus: { kind: 'image' } }, image),
    ['image_qa'],
  );
}

module.exports = [
  testUnavailableHistoricalFileStillSelectsFileOperation,
  testRouteOperationSchemaIsModelOwned,
  testRouteOperationSchemaDoesNotNarrowFromAttachmentKeywords,
  testDeterministicPoliciesPreserveTheDifferenceBetweenContinuationAndFollowup,
  testExplicitWebSearchDirectiveTightensTheOperationSchema,
  testRoutePromptDocumentsWebSearchAndEditVsReferenceBoundary,
  testTextFocusContinuationStaysPlainChatDespiteHistoryImages,
];
