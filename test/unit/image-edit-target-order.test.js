'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const imageExecution = require('../../client/core/image-execution');
const { compileDispatchContract } = require('../../shared/dispatch-contract');

function testOrderImageInputRefsKeepsUploadedOrder() {
  // Model may emit target before reference (i.e. not upload order); the
  // ordering helper must restore the user's uploaded order (i1 before i2).
  const ordered = routeService.orderImageInputRefs([
    { candidate_key: 'i2', role: 'target' },
    { candidate_key: 'i1', role: 'reference' },
  ]);
  assert.deepStrictEqual(
    ordered.map(ref => `${ref.candidate_key}:${ref.role}`),
    ['i1:reference', 'i2:target'],
  );
}

function testOrderImageInputRefsPreservesAlreadyUploadOrderedInputs() {
  const ordered = routeService.orderImageInputRefs([
    { candidate_key: 'i1', role: 'style_reference' },
    { candidate_key: 'i2', role: 'reference' },
    { candidate_key: 'i3', role: 'target' },
  ]);
  assert.deepStrictEqual(
    ordered.map(ref => `${ref.candidate_key}:${ref.role}`),
    ['i1:style_reference', 'i2:reference', 'i3:target'],
  );
}

function testOrderImageInputRefsIsStableForSameUploadIndex() {
  const ordered = routeService.orderImageInputRefs([
    { candidate_key: 'i1', role: 'reference', id: 'a' },
    { candidate_key: 'i1', role: 'reference', id: 'b' },
  ]);
  assert.deepStrictEqual(
    ordered.map(ref => ref.id),
    ['a', 'b'],
  );
}

function testImageRoleGuideLabelsImagesByTheSameOrderAsSubmission() {
  const guide = imageExecution.buildImageRoleGuide([
    { routeRole: 'reference', routeSource: 'current', routeResourceKey: 'r1' },
    { routeRole: 'target', routeSource: 'current', routeResourceKey: 'r2' },
  ], compileDispatchContract({
    operation: 'edit_image',
    relation: 'new',
    input: 'x',
    prompt: 'x',
    parameterInput: 'x',
    bindings: [
      { key: 'r1', type: 'image', role: 'reference', resource_id: 'res:image:r', source: 'current' },
      { key: 'r2', type: 'image', role: 'target', resource_id: 'res:image:t', source: 'current' },
    ],
  }));
  assert.ok(guide.includes('按发送顺序'), 'role guide must describe the submission order');
  assert.ok(!guide.includes('依上传顺序'), 'role guide must not claim a different order than it sends');
  const referenceLine = guide.split('\n').find(line => line.includes('内容参考'));
  const targetLine = guide.split('\n').find(line => line.includes('作为编辑目标图'));
  assert.ok(referenceLine && referenceLine.startsWith('- 图片1'), 'uploaded image 1 must be described as the reference');
  assert.ok(targetLine && targetLine.startsWith('- 图片2'), 'uploaded image 2 must be described as the edit target');
}

module.exports = [
  testOrderImageInputRefsKeepsUploadedOrder,
  testOrderImageInputRefsPreservesAlreadyUploadOrderedInputs,
  testOrderImageInputRefsIsStableForSameUploadIndex,
  testImageRoleGuideLabelsImagesByTheSameOrderAsSubmission,
];
