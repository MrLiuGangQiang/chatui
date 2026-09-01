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
  // Negated references are self-contained: the model explicitly says it does
  // NOT reuse a previous design/plan, so no downstream resolution is needed.
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('不参考或沿用之前的设计，重新设计一张住宅平面图。'), false,
    'a negated reference must not be treated as an unresolved instruction reference');
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('不要根据之前的方案，直接画一只猫。'), false);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('重新设计，无需沿用上面那个方案。'), false);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('请勿参考之前的版本，从零开始画。'), false);

  // A genuine reference (including one negated across a sentence boundary)
  // must still be rejected.
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('根据之前的方案生成。'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('参考上面那个版本，改一下配色。'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('根据上面的方案生成。不要参考之前的版本。'), true);

  // Cross-turn style/consistency references are equally unresolvable for an
  // image provider that never sees earlier turns: they must be rejected even
  // though the subject ("一只狗") is otherwise self-contained.
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference(
    '一只狗的插画，风格与之前生成的猫的插画保持一致，但主体是一只狗。狗的姿态和表情活泼友好，背景简洁，色彩明亮。',
  ), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('风格与之前生成的猫的插画保持一致，主体换成一只狗。'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('画一只狗，风格和上一张图一样'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('延续之前的插画风格，画一只狗'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('配色与之前那张保持一致'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('和之前一样，但要一只狗'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('风格照搬之前生成的猫的插画'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('水墨风格与之前一致'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('same style as the previous image, but a dog'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('consistent with the previous illustration'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('keep the previous style'), true);

  // References that name the actually bound input itself are resolvable, and
  // same-instruction style comparisons without a conversational deictic are
  // self-contained.
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('保持与参考图一致的插画风格，主体是一只狗'), false);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('水墨风格与工笔风格保持一致'), false);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('主体与原图保持一致，只把背景换成蓝色'), false);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('不要和之前一样的风格，画一只狗'), false);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('和上次不同，这次要一只狗'), false);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('保留人物面部细节，背景简洁'), false);

  // Turn-position provenance names an image by where it appeared in the
  // conversation. The provider receives no conversation, only the instruction
  // text and the bound input images, so it must be rejected the same way as a
  // cross-turn style reference; addressing the bound target directly is fine.
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference(
    '在最近生成的那张猫的插画基础上，将背景替换为雪山前的草地场景。保持猫的主体形象、姿态、表情和插画风格不变，只改变背景：草地为前景，远处是覆盖着白雪的山峰，天空清澈明亮，整体色调清新自然。',
  ), true, 'a recency-positioned edit target is unresolvable for the provider');
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('把上一张图改成黑白'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('上次画的猫的图片换成黑色背景'), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference(
    'the most recently generated illustration with mountains in the background',
  ), true);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference(
    '在这张猫的插画的基础上，将背景替换为雪山前的草地场景。保持猫的主体形象、姿态、表情和插画风格不变。',
  ), false, 'addressing the bound target directly is resolvable');
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('把这张图的背景换成蓝色'), false);
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('不要基于最近生成的那张图，重新画一只猫。'), false,
    'a negated provenance reference is self-contained');
  assert.strictEqual(imageInstruction.hasUnresolvedImageInstructionReference('在修改之前的姿态保持不变，只把背景换成蓝色'), false,
    'an intra-instruction 之前 is not turn positioning');
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
