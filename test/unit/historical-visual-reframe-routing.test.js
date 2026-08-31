'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function modelIntent(operation = 'plain_chat', resourceRefs = []) {
  return JSON.stringify({
    operation,
    relation: 'followup',
    goal: '执行用户当前视觉请求。',
    task_shape: 'single',
    resource_refs: resourceRefs,
  });
}

function textFocusedContext(images = []) {
  return {
    conversation_focus: {
      schema_version: 'conversation_focus.v1',
      kind: 'text',
      text_format: '',
      source_message_index: 4,
      text_message_index: 4,
      image_message_index: 2,
    },
    image_candidates: images,
    recent_messages: [],
    file_candidates: [],
  };
}

function womanImage(index, suffix = '') {
  return {
    index,
    source: 'history',
    image_id: `woman-${index}`,
    resource_id: `res:image:woman-${index}`,
    reference_id: `woman-ref-${index}`,
    // Deliberately keep the provider prompt in English: the test verifies that
    // the user-facing Chinese semantic description still finds this image.
    prompt: `full portrait of an elegant woman ${suffix}`.trim(),
    description: `一位气质优雅的美女${suffix}`.trim(),
    semantic_text: `美女 成人女性 人像 ${suffix}`.trim(),
  };
}

function inspect(input, operation = 'plain_chat', images = [womanImage(1)], resourceRefs = []) {
  return routeService.inspectModelRouteResult(modelIntent(operation, resourceRefs), {
    input,
    attachments: [],
    context: textFocusedContext(images),
  });
}

function testModelSelectedHistoricalWomanIgnoresAStaleTextFocus() {
  const inspected = inspect('美女图片我需要全身图', 'edit_image', [womanImage(1)], [
    { candidate_key: 'i1', role: 'target' },
  ]);

  assert.ok(inspected.route, inspected.reason);
  assert.strictEqual(inspected.route.operationType, 'edit_image');
  assert.strictEqual(inspected.route.api, 'image_edit');
  assert.strictEqual(inspected.route.relation, 'followup');
  assert.strictEqual(inspected.route.dispatchAuthorized, true);
  assert.deepStrictEqual(inspected.route.imageRefs.map(reference => ({
    role: reference.role,
    image_id: reference.image_id,
    source: reference.source,
  })), [{
    role: 'target', image_id: 'woman-1', source: 'history',
  }]);
}

function testMultipleMatchingWomenAskForSelectionInsteadOfEditingAtRandom() {
  const inspected = inspect('美女我需要全身图', 'edit_image', [womanImage(1, '在街头'), womanImage(2, '在咖啡馆')]);

  assert.ok(inspected.route, inspected.reason);
  assert.strictEqual(inspected.route.operationType, 'edit_image');
  assert.strictEqual(inspected.route.api, 'clarify');
  assert.strictEqual(inspected.route.dispatchAuthorized, false);
  assert.strictEqual(inspected.route.needClarification, true);
  assert.match(inspected.route.clarificationQuestion, /多个候选|选择/);
  assert.strictEqual(inspected.route.clarificationSlots[0].choices.length, 2);
}

function testExplicitNewFullBodyImageRequestStillGeneratesANewImage() {
  const inspected = inspect('生成一张美女全身图', 'text_to_image');

  assert.ok(inspected.route, inspected.reason);
  assert.strictEqual(inspected.route.operationType, 'text_to_image');
  assert.strictEqual(inspected.route.api, 'image_generation');
  assert.strictEqual(inspected.route.dispatchAuthorized, true);
  assert.deepStrictEqual(inspected.route.imageRefs, []);
}

module.exports = [
  testModelSelectedHistoricalWomanIgnoresAStaleTextFocus,
  testMultipleMatchingWomenAskForSelectionInsteadOfEditingAtRandom,
  testExplicitNewFullBodyImageRequestStillGeneratesANewImage,
];
