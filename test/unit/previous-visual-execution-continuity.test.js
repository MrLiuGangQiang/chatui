'use strict';

const assert = require('assert');

const imageRouteContext = require('../../client/core/image-route-context');
const routeService = require('../../client/services/route-service');
const submitHelpers = require('../../client/app/submit-workflow.helpers');

function attachmentContext(attachments) {
  return JSON.stringify({ attachments });
}

function imageQaPlan(input) {
  return {
    operation: 'image_qa',
    relation: 'followup',
    arguments: { prompt: input },
    bindings: [],
    constraints: [],
  };
}

function visualExecutionMarker(bindings) {
  return {
    schema_version: 'route_execution_anchor.v1',
    operation: 'image_qa',
    image_bindings: bindings,
  };
}

function testBareOrdinalVisualFollowupReusesThePriorSingleImageBinding() {
  const messages = [
    {
      role: 'user',
      rawText: '\u8bc6\u522b\u62fc\u56fe\u4e2d\u7b2c\u4e00\u5f20\u548c\u7b2c\u516b\u5f20\u7684\u6587\u5b57',
      attachmentContext: attachmentContext([
        { id: 'goldfish', name: 'goldfish.png', type: 'image/png', src: 'indexeddb://goldfish' },
      ]),
    },
    { role: 'assistant', content: '\u91d1\u9c7c' },
    {
      role: 'user',
      rawText: '\u7b2c\u4e00\u5f20\u548c\u7b2c\u516b\u5f20\u6587\u5b57\u662f\u4ec0\u4e48',
      attachmentContext: attachmentContext([
        { id: 'puzzle', name: 'puzzle.png', type: 'image/png', src: 'indexeddb://puzzle' },
      ]),
      routeExecutionAnchor: visualExecutionMarker([
        { source: 'current', reference_id: '', index: 1 },
      ]),
    },
    { role: 'assistant', content: '\u7b2c\u4e00\u5f20\uff1a\u52a9\u7406\uff1b\u7b2c\u516b\u5f20\uff1a\u8fd0\u7ef4\u3002' },
    { role: 'user', rawText: '\u518d\u8bc6\u522b\u4e00\u4e0b\u7b2c\u516b\u5f20' },
  ];

  const context = imageRouteContext.buildRouteContext({ messages });
  assert.deepStrictEqual(context.previous_visual_execution, {
    schema_version: 'previous_visual_execution.v1',
    operation: 'image_qa',
    source_message_index: 3,
    response_message_index: 4,
    image_count: 1,
    images: [{ reference_id: 'imgref_uploaded_3', index: 1 }],
    context_role: 'execution_state',
    instruction_authority: 'application_state',
  });

  const compiled = routeService.compileLocalRoute(imageQaPlan('\u518d\u8bc6\u522b\u4e00\u4e0b\u7b2c\u516b\u5f20'), {
    input: '\u518d\u8bc6\u522b\u4e00\u4e0b\u7b2c\u516b\u5f20',
    attachments: [],
    context,
  });

  assert.strictEqual(compiled.needClarification, false);
  assert.strictEqual(compiled.dispatchAuthorized, true);
  assert.strictEqual(compiled.operationType, 'image_qa');
  assert.deepStrictEqual(compiled.resources.map(resource => [resource.id, resource.reference_id, resource.source]), [
    ['img_imgref_uploaded_3_1', 'imgref_uploaded_3', 'history'],
  ]);
  assert.ok(!compiled.resources.some(resource => resource.id === 'img_imgref_uploaded_1_1'), 'the older goldfish must not enter the binding');
}

function testMultiplePriorVisualBindingsStillRequireAChoice() {
  const messages = [
    {
      role: 'user',
      rawText: '\u5206\u522b\u8bc6\u522b\u4e24\u5f20\u56fe',
      attachmentContext: attachmentContext([
        { id: 'left', name: 'left.png', type: 'image/png', src: 'indexeddb://left' },
        { id: 'right', name: 'right.png', type: 'image/png', src: 'indexeddb://right' },
      ]),
      routeExecutionAnchor: visualExecutionMarker([
        { source: 'current', reference_id: '', index: 1 },
        { source: 'current', reference_id: '', index: 2 },
      ]),
    },
    { role: 'assistant', content: '\u5df2\u8bc6\u522b\u3002' },
    { role: 'user', rawText: '\u518d\u8bc6\u522b\u4e00\u4e0b\u7b2c\u516b\u5f20' },
  ];
  const context = imageRouteContext.buildRouteContext({ messages });
  const compiled = routeService.compileLocalRoute(imageQaPlan('\u518d\u8bc6\u522b\u4e00\u4e0b\u7b2c\u516b\u5f20'), {
    input: '\u518d\u8bc6\u522b\u4e00\u4e0b\u7b2c\u516b\u5f20', attachments: [], context,
  });

  assert.strictEqual(context.previous_visual_execution.image_count, 2);
  assert.strictEqual(compiled.needClarification, true);
  assert.strictEqual(compiled.dispatchAuthorized, false);
}

function testExplicitImageOrdinalStillSelectsAResourceInsteadOfThePriorVisualAnchor() {
  const input = '\u518d\u8bc6\u522b\u4e00\u4e0b\u7b2c8\u5f20\u56fe\u7247';
  const context = {
    previous_visual_execution: {
      schema_version: 'previous_visual_execution.v1',
      operation: 'image_qa',
      image_count: 1,
      images: [{ reference_id: 'imgref_previous-answer', index: 1 }],
    },
    image_candidates: [
      { image_id: 'previous-answer', reference_id: 'imgref_previous-answer', index: 1, source: 'history' },
      { image_id: 'explicit-eighth', reference_id: 'imgref-history-set', index: 8, source: 'history' },
    ],
  };
  const compiled = routeService.compileLocalRoute(imageQaPlan(input), { input, attachments: [], context });

  assert.strictEqual(compiled.needClarification, false);
  assert.deepStrictEqual(compiled.resources.map(resource => resource.id), ['explicit-eighth']);
}

function testRouteExecutionAnchorPersistsOnlyReadOnlyVisualBindings() {
  const marker = submitHelpers.routeExecutionAnchor({
    operationType: 'image_qa',
    executionResources: {
      images: [{ source: 'current', reference_id: '', index: 1 }],
    },
  });
  assert.deepStrictEqual(marker, visualExecutionMarker([{ source: 'current', reference_id: '', index: 1 }]));
  assert.strictEqual(submitHelpers.routeExecutionAnchor({
    operationType: 'edit_image', executionResources: { images: [{ source: 'current', index: 1 }] },
  }), null);
}

module.exports = [
  testBareOrdinalVisualFollowupReusesThePriorSingleImageBinding,
  testMultiplePriorVisualBindingsStillRequireAChoice,
  testExplicitImageOrdinalStillSelectsAResourceInsteadOfThePriorVisualAnchor,
  testRouteExecutionAnchorPersistsOnlyReadOnlyVisualBindings,
];
