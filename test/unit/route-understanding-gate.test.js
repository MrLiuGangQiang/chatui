'use strict';

const assert = require('assert');
const routeService = require('../../client/services/route-service');
const routeIntentWorkflow = require('../../client/app/route-intent-workflow');

function testContextualFollowupUsesUnderstandingPath() {
  assert.strictEqual(routeService.shouldRunUnderstanding('这个呢', [], {
    previous_resource_execution: { operation: 'image_qa' },
  }), true, 'an active prior resource execution turns an anaphoric follow-up into a contextual route');

  assert.strictEqual(routeService.shouldRunUnderstanding('这个效果怎么样', [], {
    conversation_focus: { schema_version: 'conversation_focus.v1', kind: 'image' },
  }), true, 'an active conversation focus turns a short visual follow-up into a contextual route');

  assert.strictEqual(routeService.shouldRunUnderstanding('画一只猫', [], {
    previous_execution: { operation: 'text_to_image' },
  }), false, 'a self-contained generation request still keeps the simple path');
}

function testQuotedEvidenceTakesUnderstandingPathEvenWithEmptyInput() {
  assert.strictEqual(routeService.shouldRunUnderstanding('', [], {
    quoted_message: { role: 'user', content: '上一张图', id: 'quoted-1' },
  }), true, 'an empty turn that quotes a message must run the understand node');

  assert.strictEqual(routeService.shouldRunUnderstanding('', [], {
    file_candidates: [{ source: 'quoted', index: 1 }],
  }), true, 'an empty turn with a quoted file must run the understand node');

  assert.strictEqual(routeService.shouldRunUnderstanding('', [], {
    image_candidates: [{ source: 'quoted', index: 1 }],
  }), true, 'an empty turn with a quoted image must run the understand node');

  assert.strictEqual(routeService.shouldRunUnderstanding('', [], {}), false,
    'an empty turn with no quoted anchor still keeps the deterministic/simple path');
}

function workflowHarness(routeOutputs = []) {
  const calls = [];
  let routeIndex = 0;
  const workflow = routeIntentWorkflow.createRouteIntentWorkflow({
    state: { mode: 'chat', autoMode: true, sessions: [], messages: [] },
    getConfig: () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'route-secret', routeModel: 'route-model', chatModel: 'chat-model' }),
    getSessionRouteModel: () => 'route-model',
    getSessionChatModel: () => 'chat-model',
    buildRouteAttachmentMetadata: () => [],
    requestJson: async (url, payload, apiKey, options = {}) => {
      const name = payload?.text?.format?.name;
      const system = (payload?.input || []).find(message => message && message.role === 'system');
      calls.push({ name, systemContent: system ? system.content : null });
      if (name === 'chatui_intent_understanding_v1') {
        return {
          output_text: JSON.stringify({
            schema_version: 'intent_understanding.v1',
            dependency: 'followup',
            actions: [{ index: 1, kind: 'plain_text', target: '解释引用内容', resolved_refs: [] }],
          }),
        };
      }
      if (name === 'chatui_route_intent_v3') {
        const overrides = routeOutputs[routeIndex] || {};
        routeIndex += 1;
        return {
          output_text: JSON.stringify(Object.assign({
            operation: 'plain_chat',
            relation: 'followup',
            goal: '解释引用内容',
            goal_mode: 'replace',
            resource_refs: [],
            task_shape: 'single',
          }, overrides)),
        };
      }
      throw new Error('unexpected request ' + String(name || '<missing>'));
    },
  });
  return { workflow, calls };
}

async function testEmptyQuotedWorkflowRunsUnderstandingBeforeRoute() {
  const previous = globalThis.ChatUIRouteService;
  globalThis.ChatUIRouteService = routeService;
  try {
    const harness = workflowHarness();
    const route = await harness.workflow.getEffectiveRoute('', [], 'session-1', null, {
      quoted_message: { role: 'user', content: '解释引用内容', id: 'quoted-1' },
    });

    assert.strictEqual(route.outcome, 'ready');
    const understandingCalls = harness.calls.filter(call => call.name === 'chatui_intent_understanding_v1');
    const routeCalls = harness.calls.filter(call => call.name === 'chatui_route_intent_v3');
    assert.strictEqual(understandingCalls.length, 1,
      'an empty quoted turn must run the understand node before routing');
    assert.strictEqual(routeCalls.length, 1);
    assert.strictEqual(routeCalls[0].systemContent, routeService.ROUTE_NODE_SYSTEM_PROMPT_COMPACT,
      'the resolved empty quoted turn must use the CoT compact route prompt');
    assert.ok(harness.calls.findIndex(call => call.name === 'chatui_intent_understanding_v1')
      < harness.calls.findIndex(call => call.name === 'chatui_route_intent_v3'),
      'understanding must be requested before the route node');
  } finally {
    if (previous === undefined) delete globalThis.ChatUIRouteService;
    else globalThis.ChatUIRouteService = previous;
  }
}

module.exports = [
  testContextualFollowupUsesUnderstandingPath,
  testQuotedEvidenceTakesUnderstandingPathEvenWithEmptyInput,
  testEmptyQuotedWorkflowRunsUnderstandingBeforeRoute,
];
