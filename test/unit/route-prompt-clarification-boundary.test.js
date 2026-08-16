'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routingFixture = require('../fixtures/intent-routing-eval.v3.json');


function fixtureCase(id) {
  const value = routingFixture.cases.find(item => item.id === id);
  assert.ok(value, `missing routing fixture ${id}`);
  return value;
}

function currentImage(index, id, description) {
  return {
    index,
    source_index: index,
    source: 'current',
    image_id: id,
    reference_id: `imgref-${id}`,
    target: 'uploaded',
    description,
  };
}

function testPromptKeepsExecutionGoalSeparateFromClarificationUi() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /不写[^。\n]*澄清问题/);
  assert.match(prompt, /执行层(?:澄清|询问)/);
  assert.doesNotMatch(prompt, /goal保留真实任务\+附澄清问题|goal写清真实任务\+澄清点|歧义时goal[^。\n]*澄清问题/);

  const goal = '将目标图片中的猫背景改为白色，保留主体和构图不变。';
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'edit_image',
    relation: 'followup',
    goal,
    goal_mode: 'replace',
    task_shape: 'single',
    resource_refs: [],
  }), {
    input: '把猫的背景改成白色。',
    attachments: [],
    context: {
      recent_messages: [{ index: 1, role: 'assistant', content: '有两张猫咪图片可供后续编辑' }],
      image_candidates: [
        { ...currentImage(1, 'cat-a', '一只橘猫'), source: 'history', target: 'previous' },
        { ...currentImage(2, 'cat-b', '一只黑猫'), source: 'history', target: 'previous' },
      ],
      file_candidates: [],
    },
  });
  assert.ok(inspected.route, inspected.reason || inspected.error);
  assert.strictEqual(inspected.route.readiness, 'needs_clarification');
  assert.strictEqual(inspected.route.userGoal, goal);
  assert.ok(inspected.route.clarificationQuestion);
  assert.doesNotMatch(inspected.route.userGoal, /澄清|第一张|第二张/);
  assert.strictEqual(inspected.route.dispatchContract, null);

  const fixture = fixtureCase('ambiguous-history-image-requires-clarification');
  for (const forbidden of ['需澄清', '请选择', '第一张还是第二张']) {
    assert.ok(fixture.expected.goal.forbidden.includes(forbidden), `missing ambiguity goal guard: ${forbidden}`);
  }
}

function testPromptAppliesResourcePriorityPerRequiredRole() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /资源选择[^。\n]*operation[^。\n]*必需角色/);
  assert.match(prompt, /各角色按P1→P5/);
  assert.match(prompt, /命中只停该角色[^。]*续查其他角色/);
  assert.doesNotMatch(prompt, /满足P1则不再看P2-P5/);

  const context = {
    recent_messages: [],
    image_candidates: [
      currentImage(1, 'target-current', '本轮唯一待编辑产品图'),
      currentImage(2, 'mask-explicit', '用户明确指定的蒙版'),
    ],
    file_candidates: [],
  };
  const catalog = routeService.buildRouteResourceCandidates({
    attachments: [
      { index: 1, id: 'target-current', image_id: 'target-current', name: 'product.png', type: 'image/png', is_image: true },
      { index: 2, id: 'mask-explicit', image_id: 'mask-explicit', name: 'mask.png', type: 'image/png', is_image: true },
    ],
    context,
    input: '用第二张作为蒙版修改我刚上传的产品图。',
  });
  const target = catalog.find(candidate => candidate.id === 'target-current');
  const mask = catalog.find(candidate => candidate.id === 'mask-explicit');
  assert.ok(target && mask);
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'edit_image',
    relation: 'new',
    goal: '使用指定蒙版修改本轮产品图，保留产品主体。',
    goal_mode: 'replace',
    task_shape: 'single',
    resource_refs: [
      { candidate_key: target.candidate_key, role: 'target' },
      { candidate_key: mask.candidate_key, role: 'mask' },
    ],
  }), {
    input: '用第二张作为蒙版修改我刚上传的产品图。',
    attachments: [],
    context,
  });
  assert.ok(inspected.route, inspected.reason || inspected.error);
  assert.strictEqual(inspected.route.dispatchAuthorized, true);
  assert.deepStrictEqual(
    inspected.route.dispatchContract.bindings.map(binding => binding.role).sort(),
    ['mask', 'target'],
  );
}


function testPromptRequiresHistoricalTextEvidenceBinding() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /resource_refs按执行事实(?:绑定)?(?:，不按|而非)relation/);
  assert.match(prompt, /(?:禁止仅|勿(?:仅)?)因followup\/continuation绑(?:定)?mN/);
  assert.match(prompt, /P3 quoted正文是消息证据来源：只有 quoted\/history 正文为goal提供必需事实时，才绑定对应mN=context/);
  assert.match(prompt, /若goal使用quoted\/history正文事实，必须绑定相应mN=context/);
  assert.match(prompt, /仅仅存在quoted不绑定/,
    'quoted message presence alone must not create an unnecessary context binding');
  assert.match(prompt, /即使已消解/);
  assert.match(prompt, /goal不能替代(?:资源)?证据/);

  for (const id of [
    'quoted-text-to-image-binds-message-on-first-route',
    'quoted-message-rewrite-binds-only-the-quoted-text',
  ]) {
    const fixture = fixtureCase(id);
    assert.strictEqual(fixture.expected.relation, 'followup');
    assert.ok(fixture.expected.resources.items.some(item => item.type === 'message' && item.role === 'context'),
      `${id} must keep the quoted message as execution evidence`);
  }
}
function testPromptRequiresSelfContainedReferenceGenerationGoal() {
  const prompt = routeService.ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /goal_mode=replace的图片goal须独立可执行/);
  assert.match(prompt, /未提供的创作要素保持未指定/);
  assert.match(prompt, /goal_mode=amend只写当前具体delta/);
  assert.match(prompt, /不复述前序base/);
  assert.match(prompt, /不得只写[^。]*(?:基于这个生成|参考上述内容生成|继续生成)/);

  const context = {
    recent_messages: [],
    image_candidates: [currentImage(1, 'style-ref', '蓝紫渐变移动端设计稿')],
    file_candidates: [],
  };
  const catalog = routeService.buildRouteResourceCandidates({ attachments: [], context, input: '参考这张图生成' });
  const reference = catalog.find(candidate => candidate.id === 'style-ref');
  assert.ok(reference);
  const goal = '采用参考图片的蓝紫渐变配色，生成一张移动端视觉稿。';
  const inspected = routeService.inspectModelRouteResult(JSON.stringify({
    operation: 'image_reference_gen',
    relation: 'new',
    goal,
    goal_mode: 'replace',
    task_shape: 'single',
    resource_refs: [{ candidate_key: reference.candidate_key, role: 'style_reference' }],
  }), {
    input: '参考这张图生成',
    attachments: [],
    context,
  });
  assert.ok(inspected.route, inspected.reason || inspected.error);
  assert.strictEqual(inspected.route.dispatchAuthorized, true);
  assert.strictEqual(inspected.route.dispatchContract.arguments.prompt, goal);

  const fixture = fixtureCase('quoted-image-reference-generation');
  for (const forbidden of ['基于这个生成', '参考上述内容生成', '继续生成']) {
    assert.ok(fixture.expected.goal.forbidden.includes(forbidden), `missing reference goal guard: ${forbidden}`);
  }
}

module.exports = [
  testPromptKeepsExecutionGoalSeparateFromClarificationUi,
  testPromptAppliesResourcePriorityPerRequiredRole,
  testPromptRequiresHistoricalTextEvidenceBinding,
  testPromptRequiresSelfContainedReferenceGenerationGoal,
];
