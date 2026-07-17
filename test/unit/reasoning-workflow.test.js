const assert = require('assert');
const reasoning = require('../../client/app/reasoning-workflow');
const coreReasoning = require('../../client/core/reasoning');

function testGpt5ReasoningUsesOnlyOpenAiEffort() {
  const workflow = reasoning.createReasoningWorkflow({
    state: { reasoningMode: true, reasoningType: 'high' },
  });

  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-5-mini' }),
    { reasoning_effort: 'high' },
    'GPT-5 models should use the OpenAI reasoning_effort option'
  );
  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-5.2' }),
    { reasoning_effort: 'high' },
    'versioned GPT-5 models should use the OpenAI reasoning_effort option'
  );
  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-4.1' }),
    {},
    'non-GPT-5 OpenAI models should not receive a reasoning payload'
  );
  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'qwen-plus' }),
    {},
    'third-party models should not receive provider compatibility payloads'
  );
  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-5', reasoning: false }),
    {},
    'explicitly disabled reasoning should not emit an OpenAI reasoning payload'
  );


  const disabledStateWorkflow = reasoning.createReasoningWorkflow({
    state: { reasoningMode: false, reasoningType: 'none' },
  });
  assert.deepStrictEqual(
    disabledStateWorkflow.reasoningPayloadOptions({ model: 'gpt-5', reasoning: true, reasoningEffort: 'high' }),
    { reasoning_effort: 'high' },
    'explicit request-scoped reasoning must override another active session disabling the global control'
  );

  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-5', reasoningEffort: 'xhigh' }),
    { reasoning_effort: 'xhigh' },
    'GPT-5 should retain the supported xhigh reasoning effort'
  );
  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-5', reasoningEffort: 'max' }),
    { reasoning_effort: 'max' },
    'GPT-5 should retain the supported max reasoning effort'
  );
  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-5', reasoningEffort: 'none' }),
    {},
    'none should disable the reasoning payload'
  );
  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-5', reasoningEffort: 'minimal' }),
    {},
    'unsupported legacy effort values should not be sent to the API'
  );
}


function testReasoningControlDisplaysRawEffortIdentifiers() {
  const createClassList = () => ({ toggle() {} });
  const toggle = { classList: createClassList(), setAttribute() {} };
  const menuButton = { classList: createClassList(), setAttribute() {} };
  const label = { textContent: '' };
  const items = ['low', 'medium', 'high', 'xhigh', 'max'].map(reasoningType => ({
    dataset: { reasoningType },
    classList: createClassList(),
    setAttribute() {},
  }));
  const controls = { reasoningToggle: toggle, reasoningMenuBtn: menuButton, reasoningTypeLabel: label };
  const workflow = reasoning.createReasoningWorkflow({
    state: { reasoningMode: true, reasoningType: 'max' },
    $: id => controls[id] || null,
    document: { querySelectorAll: () => items },
    isSessionBusy: () => false,
    // Guard against a legacy display-label helper being supplied by an app shell.
    reasoningTypeText: () => '\u6807\u51c6',
  });

  workflow.updateReasoningControls();

  assert.strictEqual(label.textContent, 'max', 'the selected effort control must always display the raw OpenAI effort identifier');
}

function testLegacyThinkingFieldsAreIgnoredByBrowserParser() {
  assert.deepStrictEqual(
    coreReasoning.extractStreamDelta({ output_text: 'answer', thinking: 'legacy', thinking_content: 'legacy', reasoning_details: 'legacy' }),
    { content: 'answer', reasoning: '' },
    'the browser parser should only accept OpenAI reasoning fields'
  );
}

module.exports = [testGpt5ReasoningUsesOnlyOpenAiEffort, testReasoningControlDisplaysRawEffortIdentifiers, testLegacyThinkingFieldsAreIgnoredByBrowserParser];
