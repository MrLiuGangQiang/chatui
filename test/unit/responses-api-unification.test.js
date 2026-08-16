'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const chatService = require('../../client/services/chat-service');
const routeService = require('../../client/services/route-service');
const feedbackReview = require('../../server/services/feedback-review.service');
const evaluationCli = require('../../scripts/evaluate-intent-routing');
const imageEditPayload = require('../../server/services/image-edit-payload.service');

const ROOT = path.resolve(__dirname, '../..');

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function sourceFiles(rootRelative) {
  const root = path.join(ROOT, rootRelative);
  const output = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        output.push(path.relative(ROOT, absolute).replace(/\\/g, '/'));
      }
    }
  };
  visit(root);
  return output;
}

function testRuntimeTextPayloadBuildersUseResponsesContract() {
  const routePayload = routeService.buildRoutePayload({
    model: 'route-model', input: '总结一下', attachments: [], context: {},
  });
  const imagePlanPayload = routeService.buildImagePlanPayload({
    model: 'route-model', input: '画一只猫和一只狗', goal: '分别画猫和狗', attachments: [], context: {},
  });
  const finalChatPayload = chatService.buildResponsesPayload('chat-model', [
    { role: 'system', content: 'Answer concisely.' },
    { role: 'user', content: 'Hello.' },
  ], {
    stream: false,
    responseFormat: routeService.ROUTE_INTENT_RESPONSE_FORMAT,
  });
  const feedbackPayload = feedbackReview.createFeedbackReviewPayload({ model: 'review-model', content: '问题、复现和期望均已描述。' });

  for (const [label, payload] of [
    ['route intent', routePayload],
    ['image plan', imagePlanPayload],
    ['final chat', finalChatPayload],
    ['feedback review', feedbackPayload],
  ]) {
    assert.ok(Array.isArray(payload.input), `${label} must use Responses input`);
    assert.strictEqual(Object.hasOwn(payload, 'messages'), false, `${label} must not emit Chat Completions messages`);
  }
  assert.ok(routePayload.text?.format?.schema, 'route intent must retain strict Responses structured output');
  assert.ok(imagePlanPayload.text?.format?.schema, 'image planning must retain strict Responses structured output');
  assert.strictEqual(routePayload.stream, false, 'route intent must explicitly disable streaming');
  assert.strictEqual(imagePlanPayload.stream, false, 'image planning must explicitly disable streaming');
  assert.strictEqual(finalChatPayload.stream, false, 'all explicit non-streaming Responses calls must serialize stream=false');
  assert.deepStrictEqual(finalChatPayload.text.format, {
    type: 'json_schema',
    name: routeService.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.name,
    strict: true,
    schema: routeService.ROUTE_INTENT_RESPONSE_FORMAT.json_schema.schema,
  });
  assert.ok(feedbackPayload.text?.format?.schema, 'feedback review must use Responses text.format');
  assert.strictEqual(evaluationCli.endpointFor('https://gateway.example/v1'), 'https://gateway.example/v1/responses');
}

function testActiveTextCallsitesKeepResponsesPrimaryWithOneNonStreamingRouteFallback() {
  const expectedLegacyChatCompletionFiles = [
    'client/app/route-intent-workflow.js',
    'server/jobs/chat.js',
    'server/logging/request-trace.js',
    'server/proxy/openai.js',
    'server/validators/dispatch-contract.validator.js',
    'shared/config/context-budget.js',
  ];
  const actualLegacyChatCompletionFiles = [
    ...sourceFiles('client'),
    ...sourceFiles('server'),
    ...sourceFiles('scripts'),
    ...sourceFiles('shared'),
  ].filter(relativePath => source(relativePath).includes('/chat/completions'))
    .sort();
  assert.deepStrictEqual(actualLegacyChatCompletionFiles, expectedLegacyChatCompletionFiles,
    'only the explicit route gateway fallback and existing proxy/job compatibility boundaries may retain /chat/completions');

  const chatWorkflow = source('client/app/chat-workflow.js');
  const routeWorkflow = source('client/app/route-intent-workflow.js');
  const captionWorkflow = source('client/app/image-caption-workflow.js');
  const feedbackService = source('server/services/feedback-review.service.js');
  const evaluator = source('scripts/evaluate-intent-routing.js');

  assert.match(chatWorkflow, /chatApi\s*=\s*["']responses["']/,
    'ordinary final chats must persist and stream with the Responses transport');
  assert.match(chatWorkflow, /buildResponsesRequestPayload\(/,
    'ordinary final chats must use the shared Responses payload builder');
  assert.match(routeWorkflow, /\$\{baseUrl\}\/responses/,
    'route intent recognition and multi-image planning must call Responses first');
  assert.match(routeWorkflow, /isNonStreamingResponsesEmptyStreamChunks/,
    'the route transport fallback must be gated by the exact non-streaming Responses gateway defect');
  assert.match(routeWorkflow, /chatCompletionsPayloadFromResponsesPayload/,
    'the route fallback must translate the strict Responses payload before using Chat Completions');
  assert.match(routeWorkflow, /\$\{baseUrl\}\/chat\/completions/,
    'the only active Chat Completions route call is the guarded one-shot fallback');
  assert.match(captionWorkflow, /\$\{baseUrl\}\/responses/,
    'background image tags must call Responses');
  assert.match(feedbackService, /\/responses/,
    'feedback review must call Responses');
  assert.match(evaluator, /\$\{normalized\}\/responses/,
    'the route evaluator must exercise the production Responses path');
}

function testImagesRemainOnImagesApi() {
  assert.strictEqual(imageEditPayload.imageJobTargetPath('image'), '/images/generations');
  assert.strictEqual(imageEditPayload.imageJobTargetPath('edit_image'), '/images/edits');
}

module.exports = [
  testRuntimeTextPayloadBuildersUseResponsesContract,
  testActiveTextCallsitesKeepResponsesPrimaryWithOneNonStreamingRouteFallback,
  testImagesRemainOnImagesApi,
];
