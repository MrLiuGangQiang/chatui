'use strict';

const assert = require('assert');
const imageInstruction = require('../../shared/image-instruction');
const validator = require('../../server/validators/dispatch-contract.validator');

function expectCode(action, code) {
  assert.throws(action, error => error?.code === code, `expected ${code}`);
}

function testImageInstructionProtocolRequiresAnExecutableInstructionOrClarification() {
  const ready = {
    schema_version: 'image_instruction.v1',
    status: 'ready',
    instruction: '一只橘猫坐在木窗台上，午后阳光，写实摄影。',
    clarification: '',
  };
  const unresolved = {
    schema_version: 'image_instruction.v1',
    status: 'needs_clarification',
    instruction: '',
    clarification: '请确认要采用哪个方案。',
  };

  assert.strictEqual(imageInstruction.hasExactImageInstruction(ready), true);
  assert.strictEqual(imageInstruction.hasExactImageInstruction(unresolved), true);
  assert.strictEqual(imageInstruction.hasExactImageInstruction({ ...ready, clarification: '不应同时存在' }), false);
  assert.strictEqual(imageInstruction.hasExactImageInstruction({ ...unresolved, instruction: '按照方案A生成' }), false);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('按照方案A重新生成'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('基于这个描述再生成一张图片。'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('一座雪山位于日出云海之上，电影感风景摄影。'), false);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference(ready.instruction), false);
}

function testImageInstructionMaterializationUsesOnlyTheNonExecutionChatProtocol() {
  const valid = validator.validateProxyExecutionRequest({
    requestPurpose: 'image_instruction_materialization',
    bindingEvidence: [],
    payload: { model: 'route-model', input: [] },
  }, { targetPath: '/responses', method: 'POST' });
  assert.strictEqual(valid.requestPurpose, 'image_instruction_materialization');

  expectCode(() => validator.validateProxyExecutionRequest({
    requestPurpose: 'image_instruction_materialization',
    payload: {},
  }, { targetPath: '/images/generations', method: 'POST' }), 'IMAGE_INSTRUCTION_MATERIALIZATION_TARGET_INVALID');
  expectCode(() => validator.validateProxyExecutionRequest({
    requestPurpose: 'image_instruction_materialization',
    dispatchContract: {},
    payload: {},
  }, { targetPath: '/responses', method: 'POST' }), 'IMAGE_INSTRUCTION_MATERIALIZATION_PLAN_FORBIDDEN');
  expectCode(() => validator.validateProxyExecutionRequest({
    requestPurpose: 'image_instruction_materialization',
    bindingEvidence: [{ key: 'r1' }],
    payload: {},
  }, { targetPath: '/responses', method: 'POST' }), 'IMAGE_INSTRUCTION_MATERIALIZATION_BINDINGS_FORBIDDEN');
}

module.exports = [
  testImageInstructionProtocolRequiresAnExecutableInstructionOrClarification,
  testImageInstructionMaterializationUsesOnlyTheNonExecutionChatProtocol,
];
