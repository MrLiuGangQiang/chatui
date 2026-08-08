'use strict';

const assert = require('assert');

const attachments = require('../../client/core/attachments');
const imageService = require('../../client/services/image-service');
const dispatchContract = require('../../shared/dispatch-contract');
const executionValidator = require('../../server/validators/dispatch-contract.validator');

async function testDurableImageBindingSurvivesStorageAndManagedRequestValidation() {
  const original = {
    id: 'cat-1', imageId: 'cat-1', name: 'cat.png', type: 'image/png',
    src: 'data:image/png;base64,QUJDRA==', routeResourceKey: 'r1', routeResourceType: 'image',
    routeRole: 'reference', routeResourceId: 'res:image:cat-1', routeSource: 'history',
  };
  const stored = attachments.normalizeImageContextForStorage({ mode: 'edit_image', attachments: [original] });
  const restored = attachments.parseImageContext(JSON.stringify(stored)).attachments[0];
  assert.deepStrictEqual({
    key: restored.routeResourceKey, type: restored.routeResourceType, role: restored.routeRole,
    resourceId: restored.routeResourceId, source: restored.routeSource,
  }, {
    key: 'r1', type: 'image', role: 'reference', resourceId: 'res:image:cat-1', source: 'history',
  });

  const plan = dispatchContract.compileDispatchContract({
    operation: 'image_reference_gen', relation: 'followup', input: '参考这张猫图生成新的版本。',
    bindings: [{ key: 'r1', type: 'image', role: 'reference', resource_id: 'res:image:cat-1', source: 'history' }],
  });
  const files = await imageService.imageFilesToJobPayload([restored], async () => restored.src);
  const bindingEvidence = dispatchContract.bindingEvidenceFromMedia({ images: [restored] });
  assert.strictEqual(files.length, 1);
  assert.strictEqual(dispatchContract.assertPayloadMatchesDispatchContract(plan, {
    payload: { prompt: plan.arguments.prompt }, mode: 'edit_image', files, masks: [], bindingEvidence,
  }), true);

  const validated = executionValidator.validateManagedImageRequest({
    requestPurpose: 'final_execution', dispatchContract: plan, bindingEvidence, mode: 'edit_image',
    payload: { model: 'gpt-image-2', prompt: plan.arguments.prompt }, files, masks: [],
  });
  assert.strictEqual(validated.mode, 'edit_image');
  assert.strictEqual(validated.dispatchContract, plan);
}

module.exports = [testDurableImageBindingSurvivesStorageAndManagedRequestValidation];
