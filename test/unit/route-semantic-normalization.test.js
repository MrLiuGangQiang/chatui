'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function currentPdfContext() {
  return {
    attachments: [{ id: 'pdf-1', fileId: 'pdf-1', name: 'spec.pdf', type: 'application/pdf', hasExtractedText: true }],
    context: {
      image_candidates: [],
      file_candidates: [{ index: 1, source: 'current', file_id: 'pdf-1', name: 'spec.pdf', has_extracted_text: true }],
    },
  };
}

function testModelOwnedRouteNeverNormalizesAttachmentModality() {
  const media = currentPdfContext();
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'image_qa',
    relation: 'new',
    goal: '说明当前图片内容。',
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'f1', role: 'source' }],
  }), {
    input: '说明这个附件',
    attachments: media.attachments,
    context: media.context,
  });
  assert.ok(inspected.route, inspected.reason);
  assert.strictEqual(inspected.route.operationType, 'image_qa');
  assert.strictEqual(inspected.route.readiness, 'needs_clarification');
  assert.strictEqual(inspected.route.normalizedFrom, null);
  assert.strictEqual(inspected.route.normalizationReason, '');
}

function testModelOwnedRelationIsNotRewrittenFromInputKeywords() {
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'edit_image',
    relation: 'new',
    goal: '把所选猫图改成黑白。',
    task_shape: 'single',
    resource_refs: [{ candidate_key: 'i1', role: 'target' }],
  }), {
    input: '把之前的猫图改成黑白',
    attachments: [],
    context: {
      recent_messages: [{ index: 1, role: 'assistant', content: '[图片生成完成] 猫' }],
      image_candidates: [{ index: 1, source: 'history', image_id: 'cat', reference_id: 'cat-ref', description: '猫' }],
      file_candidates: [],
    },
  });
  assert.ok(inspected.route, inspected.reason);
  assert.strictEqual(inspected.route.relation, 'new');
  assert.strictEqual(inspected.route.normalizedFrom, null);
}

function testLocalAttachmentNormalizationPublishesAuditableEvidence() {
  const media = currentPdfContext();
  const route = routeService.compileLocalRoute({
    operation: 'image_qa',
    relation: 'new',
    arguments: { prompt: '说明这个附件' },
    bindings: [{ key: 'r1', type: 'file', role: 'source', resource_id: 'f1', source: 'current' }],
    constraints: [],
  }, {
    input: '说明这个附件',
    attachments: media.attachments,
    context: media.context,
  });
  assert.strictEqual(route.operationType, 'file_qa');
  assert.deepStrictEqual(route.normalizedFrom, { operation: 'image_qa' });
  assert.strictEqual(route.normalizationReason, 'attachment_modality_alignment');
  assert.deepStrictEqual(route.normalizationChanges, [{
    field: 'operation',
    from: 'image_qa',
    to: 'file_qa',
    reason: 'attachment_modality_alignment',
  }]);
}

function testTransformPolicyForbidsSemanticChangesOnModelOwnedRoutes() {
  assert.deepStrictEqual(routeService.LOCAL_ROUTE_TRANSFORM_POLICY.model_owned.allowedSemanticFields, []);
  assert.deepStrictEqual(routeService.LOCAL_ROUTE_TRANSFORM_POLICY.local_compiler.allowedSemanticFields,
    ['operation', 'relation']);
}

module.exports = [
  testModelOwnedRouteNeverNormalizesAttachmentModality,
  testModelOwnedRelationIsNotRewrittenFromInputKeywords,
  testLocalAttachmentNormalizationPublishesAuditableEvidence,
  testTransformPolicyForbidsSemanticChangesOnModelOwnedRoutes,
];
