'use strict';

const assert = require('assert');
const { JSDOM } = require('jsdom');
const choiceWorkflow = require('../../client/app/clarification-choice-workflow');
const clarification = require('../../shared/clarification-answer');
const clarificationAnswer = require('../../shared/clarification-answer');
const clarificationRelation = require('../../shared/clarification-relation');

function makePending() {
  return clarification.createPendingClarification({
    messages: [{ role: 'user', content: '把两张图合成一张' }],
    clarificationText: '请选择两张图片',
    routeInfo: {
      mode: 'image',
      api: 'clarify',
      readiness: 'needs_clarification',
      needClarification: true,
      operationType: 'image_reference_gen',
      relation: 'new',
      resources: [],
      clarificationSlots: [
            { key: 'r1', type: 'image', role: 'reference', reason: 'ambiguous', choices: [
              { key: 'c1', source: 'history', index: 1, id: 'image-a', resource_id: 'res:image:image-a', reference_id: 'ref-a', label: '图片 A' },
              { key: 'c2', source: 'history', index: 2, id: 'image-b', resource_id: 'res:image:image-b', reference_id: 'ref-b', label: '图片 B' },
            ] },
            { key: 'r2', type: 'image', role: 'style_reference', reason: 'ambiguous', choices: [
              { key: 'c3', source: 'history', index: 3, id: 'image-c', resource_id: 'res:image:image-c', reference_id: 'ref-c', label: '图片 C' },
              { key: 'c4', source: 'history', index: 4, id: 'image-d', resource_id: 'res:image:image-d', reference_id: 'ref-d', label: '图片 D' },
            ] },
      ],
    },
  });
}

function makeRelationPending() {
  return clarification.createPendingRelationClarification(makePending(), {
    input: '这个呢',
    sourceMessageIndex: 3,
  });
}

function makeRelationDom(pending) {
  const relation = pending.relationClarification;
  const dom = new JSDOM(`<!doctype html><div id="messages"><div class="message" data-clarification-id="${relation.clarification_id}"><div class="clarification-presentation"><button class="clarification-relation-choice-button" data-pending-id="${relation.pending_id}" data-relation-decision="continue" data-choice-label="继续原任务">继续原任务</button><button class="clarification-relation-choice-button" data-pending-id="${relation.pending_id}" data-relation-decision="new_task" data-choice-label="开始新任务">开始新任务</button></div></div></div>`);
  return dom;
}

function makeDom(id) {
  const dom = new JSDOM(`<!doctype html><div id="messages"><div class="message" data-clarification-id="${id}"><div class="clarification-presentation"><ul>
    <li><button class="clarification-choice-button" data-resource-key="r1" data-choice-key="c2" data-choice-label="图片 B" aria-pressed="false">图片 B</button></li>
    <li><button class="clarification-choice-button" data-resource-key="r1" data-choice-key="c1" data-choice-label="图片 A" aria-pressed="false">图片 A</button></li>
    <li><button class="clarification-choice-button" data-resource-key="r2" data-choice-key="c4" data-choice-label="图片 D" aria-pressed="false">图片 D</button></li>
    <li><button class="clarification-choice-button" data-resource-key="r2" data-choice-key="c3" data-choice-label="图片 C" aria-pressed="false">图片 C</button></li>
  </ul><span class="clarification-choice-hint"></span></div></div></div>`);
  return dom;
}

async function click(workflow, button) {
  await workflow.onChoiceClick({
    target: button,
    preventDefault() {},
    stopPropagation() {},
  });
}

async function testClickSelectionUsesLocalProtocolAndSupportsPartialThenComplete() {
  const pending = makePending();
  const dom = makeDom(pending.id);
  const state = { activeSessionId: 'session-1', sessions: [{ id: 'session-1', pendingClarification: pending }] };
  const submissions = [];
  const workflow = choiceWorkflow.createClarificationChoiceWorkflow({
    state,
    document: dom.window.document,
    messages: dom.window.document.getElementById('messages'),
    saveSessionsMeta() {},
    onSubmit: async event => submissions.push(event),
  });
  assert.strictEqual(workflow.bind(), true);

  const first = dom.window.document.querySelector('[data-resource-key="r1"][data-choice-key="c2"]');
  await click(workflow, first);
  assert.strictEqual(submissions.length, 0, 'a partial local selection must not submit or call the route model');
  assert.strictEqual(state.sessions[0].pendingClarification.clarificationAnswer.answers[0].choice_key, 'c2');
  assert.strictEqual(first.getAttribute('aria-pressed'), 'true');

  const second = dom.window.document.querySelector('[data-resource-key="r2"][data-choice-key="c4"]');
  await click(workflow, second);
  assert.strictEqual(submissions.length, 1);
  assert.strictEqual(clarificationAnswer.hasExactClarificationAnswer(submissions[0].__chatuiClarificationAnswer), true);
  assert.deepStrictEqual(submissions[0].__chatuiClarificationAnswer.answers, [
    { resource_key: 'r1', choice_key: 'c2' },
    { resource_key: 'r2', choice_key: 'c4' },
  ]);
}

async function testLegacyRenderedArgumentChoiceIsCanonicalizedBeforeSubmission() {
  const pending = {
    id: 'clarify-legacy-size',
    originalText: '画一只猫，尺寸 1024x1024 和 1024x1536',
    clarificationText: '请选择图片尺寸。',
    routeInfo: {
      clarificationSlots: [{
        key: 'r_arg_size', type: 'text', role: 'source', reason: 'ambiguous', choices: [
          { key: 'v_1024x1024', label: '方图', value: '1024x1024' },
          { key: 'v_1024x1536', label: '竖图', value: '1024x1536' },
        ],
      }],
    },
  };
  const dom = new JSDOM(`<!doctype html><div id="messages"><div class="message" data-clarification-id="${pending.id}"><div class="clarification-presentation"><button class="clarification-choice-button" data-resource-key="r_arg_size" data-choice-key="v_1024x1536" data-choice-label="竖图">竖图</button></div></div></div>`);
  const state = { activeSessionId: 'session-1', sessions: [{ id: 'session-1', pendingClarification: pending }] };
  const submissions = [];
  const workflow = choiceWorkflow.createClarificationChoiceWorkflow({
    state,
    document: dom.window.document,
    messages: dom.window.document.getElementById('messages'),
    saveSessionsMeta() {},
    onSubmit: async event => submissions.push(event),
  });

  await click(workflow, dom.window.document.querySelector('.clarification-choice-button'));
  assert.strictEqual(submissions.length, 1);
  const answer = submissions[0].__chatuiClarificationAnswer;
  assert.strictEqual(clarificationAnswer.hasExactClarificationAnswer(answer), true);
  assert.deepStrictEqual(answer.answers, [{ resource_key: 'p1', choice_key: 'v2' }]);
  assert.deepStrictEqual(
    clarificationAnswer.applyClarificationAnswer(answer, state.sessions[0].pendingClarification.routeInfo.clarificationSlots, { clarificationId: pending.id }).selectedParameters,
    { size: '1024x1536' },
  );
}

async function testStaleAndIllegalChoicesAreRejectedLocally() {
  const pending = makePending();
  const dom = makeDom(pending.id);
  const stale = dom.window.document.createElement('button');
  stale.className = 'clarification-choice-button';
  stale.dataset.resourceKey = 'r1';
  stale.dataset.choiceKey = 'c2';
  const staleMessage = dom.window.document.createElement('div');
  staleMessage.className = 'message';
  staleMessage.dataset.clarificationId = 'clarify-stale';
  staleMessage.appendChild(stale);
  dom.window.document.getElementById('messages').appendChild(staleMessage);
  const toasts = [];
  const submissions = [];
  const state = { activeSessionId: 'session-1', sessions: [{ id: 'session-1', pendingClarification: pending }] };
  const workflow = choiceWorkflow.createClarificationChoiceWorkflow({
    state,
    document: dom.window.document,
    messages: dom.window.document.getElementById('messages'),
    toast: message => toasts.push(message),
    onSubmit: async event => submissions.push(event),
  });

  await click(workflow, stale);
  assert.strictEqual(submissions.length, 0);
  assert.strictEqual(toasts.length, 1);

  const illegal = dom.window.document.createElement('button');
  illegal.className = 'clarification-choice-button';
  illegal.dataset.resourceKey = 'r1';
  illegal.dataset.choiceKey = 'c99';
  dom.window.document.querySelector('.message[data-clarification-id] .clarification-presentation').appendChild(illegal);
  await click(workflow, illegal);
  assert.strictEqual(submissions.length, 0);
  assert.strictEqual(toasts.length, 2);
  assert.strictEqual(state.sessions[0].pendingClarification.clarificationAnswer, null);
}

async function testUnbindStopsFurtherLocalChoiceHandling() {
  const pending = makePending();
  const dom = makeDom(pending.id);
  const state = { activeSessionId: 'session-1', sessions: [{ id: 'session-1', pendingClarification: pending }] };
  let submissions = 0;
  const workflow = choiceWorkflow.createClarificationChoiceWorkflow({
    state,
    document: dom.window.document,
    messages: dom.window.document.getElementById('messages'),
    onSubmit: async () => { submissions += 1; },
  });
  workflow.bind();
  workflow.unbind();
  const button = dom.window.document.querySelector('[data-resource-key="r1"][data-choice-key="c2"]');
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(submissions, 0);
  assert.strictEqual(state.sessions[0].pendingClarification.clarificationAnswer, null);
}

async function testRelationChoiceUsesVersionedLocalAnswerWithoutFreeTextGuessing() {
  const pending = makeRelationPending();
  const dom = makeRelationDom(pending);
  const state = { activeSessionId: 'session-1', sessions: [{ id: 'session-1', pendingClarification: pending }] };
  const submissions = [];
  const workflow = choiceWorkflow.createClarificationChoiceWorkflow({
    state,
    document: dom.window.document,
    messages: dom.window.document.getElementById('messages'),
    onSubmit: async event => submissions.push(event),
  });
  const button = dom.window.document.querySelector('[data-relation-decision="continue"]');
  await click(workflow, button);
  assert.strictEqual(submissions.length, 1);
  const answer = submissions[0].__chatuiClarificationRelationAnswer;
  assert.strictEqual(clarificationRelation.hasExactRelationAnswer(answer), true);
  assert.strictEqual(answer.decision, 'continue');
  assert.strictEqual(submissions[0].__chatuiClarificationLabel, '继续原任务');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(submissions[0], 'promptText'), false);
  assert.strictEqual(pending.relationClarification.input, '这个呢');
}

async function testRelationChoiceRejectsStaleOrIllegalDecisionLocally() {
  const pending = makeRelationPending();
  const dom = makeRelationDom(pending);
  const stale = dom.window.document.createElement('button');
  stale.className = 'clarification-relation-choice-button';
  stale.dataset.pendingId = pending.id;
  stale.dataset.relationDecision = 'continue';
  const staleMessage = dom.window.document.createElement('div');
  staleMessage.className = 'message';
  staleMessage.dataset.clarificationId = 'relation-stale';
  staleMessage.appendChild(stale);
  dom.window.document.getElementById('messages').appendChild(staleMessage);
  const toasts = [];
  const submissions = [];
  const state = { activeSessionId: 'session-1', sessions: [{ id: 'session-1', pendingClarification: pending }] };
  const workflow = choiceWorkflow.createClarificationChoiceWorkflow({
    state,
    document: dom.window.document,
    messages: dom.window.document.getElementById('messages'),
    toast: message => toasts.push(message),
    onSubmit: async event => submissions.push(event),
  });
  await click(workflow, stale);
  assert.strictEqual(submissions.length, 0);
  assert.strictEqual(toasts.length, 1);

  const illegal = dom.window.document.querySelector('[data-relation-decision="continue"]');
  illegal.dataset.relationDecision = 'guess';
  await click(workflow, illegal);
  assert.strictEqual(submissions.length, 0);
  assert.strictEqual(toasts.length, 2);
}

module.exports = [
  testClickSelectionUsesLocalProtocolAndSupportsPartialThenComplete,
  testLegacyRenderedArgumentChoiceIsCanonicalizedBeforeSubmission,
  testStaleAndIllegalChoicesAreRejectedLocally,
  testUnbindStopsFurtherLocalChoiceHandling,
  testRelationChoiceUsesVersionedLocalAnswerWithoutFreeTextGuessing,
  testRelationChoiceRejectsStaleOrIllegalDecisionLocally,
];
