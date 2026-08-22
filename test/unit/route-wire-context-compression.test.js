'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const imageRouteContext = require('../../client/core/image-route-context');

function testRoutePayloadUsesOnlyShortCandidateKeysForResourceSelection() {
  const longMessageId = 'display_message_7f4ca3e8-9a2c-4dce-a6f2-0123456789ab';
  const longImageId = 'img_imgref_display_result_7f4ca3e8-9a2c-4dce-a6f2-0123456789ab_1';
  const longResourceId = `res:image:${longImageId}`;
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: 'edit the cat image color',
    attachments: [],
    context: {
      recent_messages: [{
        index: 7,
        id: longMessageId,
        resource_id: `res:message:${longMessageId}`,
        role: 'assistant',
        content: 'A gray cat sitting by a window.',
      }],
      quoted_message: { index: 7, id: longMessageId, role: 'assistant' },
      image_candidates: [{
        index: 1,
        image_id: longImageId,
        resource_id: longResourceId,
        reference_id: 'imgref_display_result_7f4ca3e8-9a2c-4dce-a6f2-0123456789ab',
        source: 'history',
        prompt: 'A gray cat sitting by a window.',
      }],
      last_generated_image: {
        reference_id: 'imgref_display_result_7f4ca3e8-9a2c-4dce-a6f2-0123456789ab',
        prompt: 'A gray cat sitting by a window.',
        count: 1,
        candidates: [{ index: 1, image_id: longImageId, resource_id: longResourceId, prompt: 'A gray cat' }],
      },
      previous_execution: {
        result_reference_id: longResourceId,
        operation: 'edit_image',
        family: 'edit',
        source_message_index: 7,
      },
      clarification_context: {
        selected_resources: [{
          resource_key: 'r1', type: 'image', role: 'target', source: 'history',
          id: longImageId, resource_id: longResourceId,
        }],
      },
    },
  }).input[1].content);

  assert.deepStrictEqual(payload.resource_candidates.map(candidate => candidate.candidate_key), ['i1', 'm1']);
  assert.deepStrictEqual(payload.context.recent_messages.map(message => message.index), [7],
    'visual editing still receives the bounded text window for intent and reference resolution');
  assert.strictEqual(payload.context.quoted_message.id, undefined);
  assert.strictEqual(payload.context.last_generated_image.reference_id, undefined);
  assert.strictEqual(payload.context.last_generated_image.prompt, undefined);
  assert.strictEqual(payload.context.previous_execution.result_reference_id, undefined);
  assert.strictEqual(payload.context.clarification_context.selected_resources[0].resource_key, 'r1');
  assert.strictEqual(payload.context.clarification_context.selected_resources[0].resource_id, undefined);

  const modelContext = JSON.stringify(payload);
  for (const identity of [longMessageId, longImageId, longResourceId]) {
    assert.ok(!modelContext.includes(identity), `model payload must not contain durable identity ${identity}`);
  }
}

function testImageMemoryAddsRetrievedOlderCardsAlongsideBoundedCandidates() {
  const longOldImageId = 'img_old_amber_cat_6ec7f5ec-4e30-47a4-8d1e-0123456789ab';
  const longOldResourceId = `res:image:${longOldImageId}`;
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: 'change the older amber cat by the window',
    context: {
      image_candidates: [{
        index: 1, image_id: 'img_recent_dog', resource_id: 'res:image:img_recent_dog', source: 'history',
        description: 'A black dog in a field.', prompt: 'A black dog in a field.',
      }],
      image_memory_cards: [
        {
          type: 'image', memory_index: 13, image_id: longOldImageId, resource_id: longOldResourceId,
          reference_id: 'imgref_old_amber_cat', source: 'history',
          description: 'An amber cat sitting by a window.', prompt: 'An amber cat sitting by a window.',
          labels: ['amber cat', 'window'],
        },
        {
          type: 'image', memory_index: 14, image_id: 'img_unrelated', resource_id: 'res:image:img_unrelated',
          reference_id: 'imgref_unrelated', source: 'history',
          description: 'A sailboat on the ocean.', prompt: 'A sailboat on the ocean.', labels: ['sailboat'],
        },
      ],
    },
  }).input[1].content);

  assert.deepStrictEqual(payload.resource_candidates, [{
    candidate_key: 'i1',
    type: 'image',
    source: 'history',
    label: 'A black dog in a field.',
    availability: 'available',
  }, {
    candidate_key: 'i2',
    type: 'image',
    source: 'history',
    label: 'An amber cat sitting by a window.',
    availability: 'available',
  }], 'retrieved image memory augments rather than replaces the bounded model-facing catalog');
  const sent = JSON.stringify(payload);
  assert.ok(!sent.includes('A sailboat on the ocean.'), 'unrelated old images must stay out of the model context');
  assert.ok(!sent.includes('image_memory_cards'), 'local image memory must never be serialized into the model context');
  assert.ok(!sent.includes(longOldImageId));
  assert.ok(!sent.includes(longOldResourceId));
}


function testStandaloneRequestReceivesCompactExecutionAndFocusEvidence() {
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '解释一下向量数据库的索引原理',
    context: {
      last_generated_image: { count: 4, prompt: 'old image prompt '.repeat(100), reference_id: 'imgref-old' },
      latest_uploaded_image: { count: 2, description: 'upload '.repeat(100) },
      latest_image_reference: { count: 4, target: 'previous', reason: 'old-result' },
      previous_execution: { operation: 'edit_image', family: 'edit', result_reference_id: 'res:image:old' },
      previous_visual_execution: { operation: 'edit_image', image_count: 4 },
      conversation_focus: { kind: 'image', text_format: 'markdown', source_message_index: 88 },
      conversation_continuity: { relation: 'followup', anchor: 'old task '.repeat(100), inherited: true },
    },
  }).input[1].content);

  assert.strictEqual(payload.context.last_generated_image.count, 4);
  assert.strictEqual(payload.context.previous_execution.operation, 'edit_image');
  assert.strictEqual(payload.context.conversation_focus.kind, 'image');
  const wire = JSON.stringify(payload);
  assert.ok(!wire.includes('old image prompt'), 'verbose prior execution prompts stay local');
  assert.ok(!wire.includes('res:image:old'), 'canonical resource identities stay local');
  assert.ok(wire.length < 900, `semantic evidence must remain compact, got ${wire.length} chars`);
}

function testClarificationWireContextKeepsOnlySemanticRoutingFacts() {
  const selectedImageId = 'img_selected_0b64c3d2-46cf-42f3-aef6-0123456789ab';
  const selectedResourceId = `res:image:${selectedImageId}`;
  const longQuestion = '请选择要处理的图片。'.repeat(100);
  const rawClarification = {
    schema_version: 'clarification_context.v4',
    base_task: '比较第一张和第三张产品图的构图与色调差异。',
    clarification_question: longQuestion,
    operation: 'image_compare',
    relation: 'followup',
    unresolved_resources: [{
      key: 'r1', type: 'image', role: 'compare_b', parameter_name: 'target_image',
      choices: Array.from({ length: 8 }, (_, index) => ({
        key: `c${index + 1}`, id: `img-${index + 1}`, resource_id: `res:image:img-${index + 1}`,
        source: 'history', index: index + 1, label: `候选图片 ${index + 1} ${'x'.repeat(180)}`,
      })),
    }],
    pending_task: { id: 'clarify-secret', base_input: '比较第一张和第三张产品图的构图与色调差异。', supplements: ['extra '.repeat(100)] },
    selected_choices: ['第一张产品图'],
    selected_parameters: { tone: 'warm', ignored: { nested: 'must not cross the wire' } },
    selected_resources: [{
      resource_key: 'r1', choice_key: 'c1', type: 'image', role: 'compare_a', source: 'history', index: 1,
      id: selectedImageId, resource_id: selectedResourceId, reference_id: 'imgref-selected', label: '第一张产品图',
    }],
    answer_complete: true,
  };
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: rawClarification.base_task,
    context: {
      image_candidates: [{ index: 1, image_id: selectedImageId, resource_id: selectedResourceId, source: 'history', label: '第一张产品图' }],
      clarification_context: rawClarification,
    },
  }).input[1].content);
  const compact = payload.context.clarification_context;

  assert.deepStrictEqual(payload.resource_candidates.map(candidate => candidate.candidate_key), ['i1'],
    'the selected clarification resource must remain addressable by the router');
  assert.strictEqual(compact.base_task, rawClarification.base_task);
  assert.strictEqual(compact.operation, 'image_compare');
  assert.strictEqual(compact.selected_parameters.tone, 'warm');
  assert.strictEqual(compact.selected_parameters.ignored, undefined);
  assert.strictEqual(compact.selected_resources[0].resource_key, 'r1');
  assert.strictEqual(compact.selected_resources[0].resource_id, undefined);
  assert.strictEqual(compact.unresolved_resources[0].choices.length, 4, 'wire choices must be bounded');
  const wire = JSON.stringify(payload);
  assert.ok(!wire.includes(longQuestion), 'presentation-only clarification question must stay local');
  assert.ok(!wire.includes(selectedImageId) && !wire.includes(selectedResourceId), 'durable identities must stay local');
  assert.ok(JSON.stringify(compact).length < JSON.stringify(rawClarification).length / 3,
    'clarification state must be semantically projected rather than copied wholesale');
}

function testEstablishedClarificationResourceRemainsInTheModelCatalog() {
  const catId = 'img-established-cat';
  const catResourceId = `res:image:${catId}`;
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '彩色鱼',
    context: {
      image_candidates: [
        { index: 1, image_id: 'img-car', resource_id: 'res:image:img-car', source: 'history', label: '汽车' },
        { index: 2, image_id: 'img-color-fish', resource_id: 'res:image:img-color-fish', source: 'history', label: '彩色鱼' },
        { index: 3, image_id: catId, resource_id: catResourceId, source: 'history', label: '猫' },
      ],
      clarification_context: {
        schema_version: 'clarification_context.v4',
        base_task: '把猫和鱼合并成一张图',
        operation: 'image_reference_gen',
        relation: 'followup',
        unresolved_resources: [],
        established_resources: [{
          key: 'r1', type: 'image', role: 'reference', source: 'history', index: 3,
          id: catId, resource_id: catResourceId, label: '猫',
        }],
        selected_resources: [],
        answer_complete: false,
      },
    },
  }).input[1].content);

  assert.ok(payload.resource_candidates.some(candidate => candidate.label === '猫'),
    'a pre-clarification binding must stay visible even when the short answer mentions only the unresolved resource');
  assert.ok(payload.resource_candidates.some(candidate => candidate.label === '彩色鱼'));
  assert.strictEqual(payload.context.clarification_context.established_resources[0].resource_key, 'r1');
  assert.strictEqual(payload.context.clarification_context.established_resources[0].resource_id, undefined);
  assert.ok(!JSON.stringify(payload).includes(catId) && !JSON.stringify(payload).includes(catResourceId),
    'established resources must remain addressable without leaking durable identities');
}


function testDeliveryEvidenceDistinguishesActualImageFromAssistantClaim() {
  const payload = JSON.parse(routeService.buildRoutePayload({
    model: 'route-model',
    input: '图片呢',
    context: imageRouteContext.buildRouteContext({
      messages: [
        { index: 1, role: 'user', content: '设计住宅户型图，中央设置堂屋。' },
        { index: 2, role: 'assistant', content: '图片已经生成。' },
      ],
    }),
  }).input[1].content);
  assert.deepStrictEqual(payload.context.delivery_evidence, {
    schema_version: 'delivery_evidence.v1',
    actual_image_result: { available: false },
    assistant_image_claim: { present: true, verified: false },
    image_delivery_confirmed: false,
  });
}

module.exports = [
  testRoutePayloadUsesOnlyShortCandidateKeysForResourceSelection,
  testImageMemoryAddsRetrievedOlderCardsAlongsideBoundedCandidates,
  testStandaloneRequestReceivesCompactExecutionAndFocusEvidence,
  testClarificationWireContextKeepsOnlySemanticRoutingFacts,
  testEstablishedClarificationResourceRemainsInTheModelCatalog,
  testDeliveryEvidenceDistinguishesActualImageFromAssistantClaim,
];
