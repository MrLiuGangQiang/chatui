const assert = require('assert');
const reasoning = require('../../client/app/reasoning-workflow');
const coreReasoning = require('../../client/core/reasoning');

const responsesReasoning = effort => ({ reasoning: { effort, summary: 'auto' } });

function testGpt5ReasoningUsesResponsesReasoningEnvelope() {
  const workflow = reasoning.createReasoningWorkflow({
    state: { reasoningMode: true, reasoningType: 'high' },
  });

  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-5-mini' }),
    responsesReasoning('high'),
    'GPT-5 models should use the Responses reasoning envelope',
  );
  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-5.2' }),
    responsesReasoning('high'),
    'versioned GPT-5 models should use the Responses reasoning envelope',
  );
  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-4.1' }),
    {},
    'non-GPT-5 OpenAI models should not receive a reasoning payload',
  );
  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'qwen-plus' }),
    {},
    'third-party models should not receive provider compatibility payloads',
  );
  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-5', reasoning: false }),
    {},
    'explicitly disabled reasoning should not emit a Responses reasoning payload',
  );

  const disabledStateWorkflow = reasoning.createReasoningWorkflow({
    state: { reasoningMode: false, reasoningType: 'none' },
  });
  assert.deepStrictEqual(
    disabledStateWorkflow.reasoningPayloadOptions({ model: 'gpt-5', reasoning: true, reasoningEffort: 'high' }),
    responsesReasoning('high'),
    'explicit request-scoped reasoning must override another active session disabling the global control',
  );

  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-5', reasoningEffort: 'xhigh' }),
    responsesReasoning('xhigh'),
    'GPT-5 should retain the supported xhigh reasoning effort',
  );
  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-5', reasoningEffort: 'max' }),
    responsesReasoning('max'),
    'GPT-5 should retain the supported max reasoning effort',
  );
  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-5', reasoningEffort: 'none' }),
    {},
    'none should disable the reasoning payload',
  );
  assert.deepStrictEqual(
    workflow.reasoningPayloadOptions({ model: 'gpt-5', reasoningEffort: 'minimal' }),
    {},
    'unsupported legacy effort values should not be sent to the API',
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
    reasoningTypeText: () => '标准',
  });

  workflow.updateReasoningControls();

  assert.strictEqual(label.textContent, 'max', 'the selected effort control must always display the raw Responses effort identifier');
}

function testLegacyThinkingFieldsAreIgnoredByBrowserParser() {
  assert.deepStrictEqual(
    coreReasoning.extractStreamDelta({ output_text: 'answer', thinking: 'legacy', thinking_content: 'legacy', reasoning_details: 'legacy' }),
    { content: 'answer', reasoning: '' },
    'the browser parser should only accept OpenAI reasoning fields',
  );
}

function testIsReasoningControlLockedFallsBackWhenDepsLacksSessionBusy() {
  // Regression: the with() removal wrote deps.isSessionBusy, but production's
  // createReasoningWorkflow deps do not include isSessionBusy (only tests pass
  // it). In production the with(deps) block fell through to the global
  // isSessionBusy declared by the entry bundle; the explicit deps.* lookup broke
  // bootstrap with "deps.isSessionBusy is not a function". The instruction must
  // fall back to the global when deps does not provide it.
  globalThis.isSessionBusy = () => false;
  try {
    const workflow = reasoning.createReasoningWorkflow({ state: { activeSessionId: 'session-a' } });
    assert.strictEqual(workflow.isReasoningControlLocked(), false,
      'a production-shaped deps (no isSessionBusy) must fall back to the global without crashing');
    // When deps provides it, the deps value wins.
    const withDeps = reasoning.createReasoningWorkflow({ state: { activeSessionId: 'b' }, isSessionBusy: () => true });
    assert.strictEqual(withDeps.isReasoningControlLocked(), true);
  } finally {
    delete globalThis.isSessionBusy;
  }
}

module.exports = [
  testGpt5ReasoningUsesResponsesReasoningEnvelope,
  testReasoningControlDisplaysRawEffortIdentifiers,
  testIsReasoningControlLockedFallsBackWhenDepsLacksSessionBusy,
  testLegacyThinkingFieldsAreIgnoredByBrowserParser,
];
