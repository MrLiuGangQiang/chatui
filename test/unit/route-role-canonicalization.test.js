'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');

function currentImages(count = 5) {
  return Array.from({ length: count }, (_, index) => ({
    id: `upload-${index + 1}`,
    imageId: `upload-${index + 1}`,
    type: 'image/png',
    name: `image-${index + 1}.png`,
    dataUrl: `data:image/png;base64,IMAGE${index + 1}`,
  }));
}

function currentFiles(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    id: `file-${index + 1}`,
    fileId: `file-${index + 1}`,
    type: 'application/pdf',
    name: `doc-${index + 1}.pdf`,
    dataUrl: `data:application/pdf;base64,FILE${index + 1}`,
  }));
}

// The route model names the exact images but labels them with an
// operation-incompatible role (target instead of source for a read-only image
// question). The deterministic compiler must canonicalize the role to the
// operation's required role and keep the already-resolved images bound instead
// of re-asking the user to select them.
function testImageQaCanonicalizesTargetRoleToSource() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'image_qa',
    relation: 'followup',
    goal: '判断第一张图和最后一张图分别是什么视角',
    goal_mode: 'replace',
    resource_refs: [
      { candidate_key: 'i1', role: 'target' },
      { candidate_key: 'i5', role: 'target' },
    ],
    task_shape: 'single',
  }), {
    input: '判断第一张图和最后一张图分别是什么视角',
    attachments: currentImages(5),
    context: {},
  });

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.operationType, 'image_qa');
  assert.strictEqual(result.route.needClarification, false,
    '已经解析到具体图片时不得把用户踢回“请选择图片”澄清');
  assert.strictEqual(result.route.readiness, 'ready');
  assert.deepStrictEqual(
    result.route.resources.map(resource => [resource.id, resource.role]),
    [['upload-1', 'source'], ['upload-5', 'source']],
  );
  assert.deepStrictEqual(
    result.route.dispatchContract.bindings.map(binding => [binding.resource_id, binding.role]),
    [['res:image:upload-1', 'source'], ['res:image:upload-5', 'source']],
  );
  assert.strictEqual(routeService.isRouteDispatchable(result.route), true);
}

function testFileQaCanonicalizesSourceRoleToAttachment() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'file_qa',
    relation: 'new',
    goal: '总结这个文件',
    goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'f1', role: 'source' }],
    task_shape: 'single',
  }), {
    input: '总结这个文件',
    attachments: currentFiles(1),
    context: {},
  });

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.needClarification, false,
    'file_qa 的文件角色应规范化为 attachment 而不是踢回澄清');
  assert.deepStrictEqual(
    result.route.resources.map(resource => [resource.id, resource.role]),
    [['file-1', 'attachment']],
  );
}

function testImageReferenceGenCanonicalizesTargetRoleToReference() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'image_reference_gen',
    relation: 'new',
    goal: '参考这张图生成一张新图',
    goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'i1', role: 'target' }],
    task_shape: 'single',
  }), {
    input: '参考这张图生成一张新图',
    attachments: currentImages(2),
    context: {},
  });

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.needClarification, false,
    'image_reference_gen 的 target 应规范化为 reference 而不是踢回澄清');
  assert.deepStrictEqual(
    result.route.resources.map(resource => [resource.id, resource.role]),
    [['upload-1', 'reference']],
  );
}

// A genuinely incompatible role must still fail closed instead of guessing:
// edit_image cannot consume a generic source image as its target.
function testEditImageSourceRoleStillClarifies() {
  const result = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'edit_image',
    relation: 'new',
    goal: '修改这张图',
    goal_mode: 'replace',
    resource_refs: [{ candidate_key: 'i1', role: 'source' }],
    task_shape: 'single',
  }), {
    input: '修改这张图',
    attachments: currentImages(1),
    context: {},
  });

  assert.ok(result.route, result.error || result.reason);
  assert.strictEqual(result.route.needClarification, true,
    'edit_image 的 source 不是可执行的 target/reference，必须保持澄清而不是猜测');
}

module.exports = [
  testImageQaCanonicalizesTargetRoleToSource,
  testFileQaCanonicalizesSourceRoleToAttachment,
  testImageReferenceGenCanonicalizesTargetRoleToReference,
  testEditImageSourceRoleStillClarifies,
];
