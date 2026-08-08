'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const chatService = require('../../client/services/chat-service');
const chatWorkflow = require('../../client/app/chat-workflow');
const { createCoreRoutes } = require('../../server/api/routes/core');
const { createRequestTraceLogger } = require('../../server/logging/request-trace');
const { makeExecutionFixture } = require('../helpers/dispatch-contract-fixture');

function traceRequest(body) {
  const text = JSON.stringify(body);
  const req = Readable.from([text]);
  req.method = 'POST';
  req.pathname = '/api/client-execution-trace';
  req.url = req.pathname;
  req.headers = { 'content-length': String(Buffer.byteLength(text)) };
  req._traceId = 'trace-client-rejection';
  req._rootTraceId = 'trace-client-rejection';
  return req;
}

async function testChatServiceReportsStructuredPreDispatchRejection() {
  const calls = [];
  const error = new TypeError('Execution context is missing a bound message: res:message:pending-submit-1');
  error.code = 'EXECUTION_CONTEXT_BINDING_MISSING';
  error.statusCode = 400;
  const ok = await chatService.reportExecutionRejection({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true };
    },
    submissionId: 'submit-client-rejection',
    jobId: 'chatjob-client-rejection',
    dispatchContract: { schema_version: 'dispatch_contract.v1' },
    bindingEvidence: [{ key: 'r1', type: 'message' }],
    contextProjection: {
      expected_message_resource_ids: ['res:message:pending-submit-1'],
      available_message_resource_ids: [],
    },
    error,
  });

  assert.strictEqual(ok, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, '/api/client-execution-trace');
  assert.strictEqual(calls[0].options.method, 'POST');
  assert.strictEqual(calls[0].options.keepalive, true);
  const body = JSON.parse(calls[0].options.body);
  assert.strictEqual(body.schema_version, 'client_execution_trace.v1');
  assert.strictEqual(body.event, 'execution.rejected');
  assert.strictEqual(body.submissionId, 'submit-client-rejection');
  assert.strictEqual(body.jobId, 'chatjob-client-rejection');
  assert.strictEqual(body.error.code, 'EXECUTION_CONTEXT_BINDING_MISSING');
  assert.deepStrictEqual(body.contextProjection.missing_message_resource_ids, undefined);
}


function testContextProjectionFailureReportsExpectedAvailableAndMissingMessageIds() {
  const reports = [];
  const pendingId = 'pending-submit-submit-msjxqlpe-w3a7fipl';
  const resourceId = `res:message:${pendingId}`;
  const contract = makeExecutionFixture({
    prompt: '这用几个关键字描述一下',
    operation: 'plain_chat',
    relation: 'followup',
    resources: [{
      key: 'r1', type: 'message', source: 'quoted', role: 'context', id: pendingId,
      resource_id: resourceId,
    }],
  });
  const workflow = chatWorkflow.createChatWorkflow({
    state: {},
    reportExecutionRejection: details => {
      reports.push(details);
      return Promise.resolve(true);
    },
  });
  const identityStrippedQuote = {
    role: 'user',
    content: '<quoted_message role="assistant">企业级智能问数核心点</quoted_message>',
  };

  assert.throws(
    () => workflow.applyExecutionContextPolicy([identityStrippedQuote], {
      dispatchContract: contract.dispatchContract,
      bindingEvidence: contract.executionResources.messages,
      submissionId: 'submit-client-rejection',
      jobId: 'chatjob-client-rejection',
    }),
    error => error?.code === 'EXECUTION_CONTEXT_BINDING_MISSING',
  );
  assert.strictEqual(reports.length, 1);
  assert.deepStrictEqual(reports[0].contextProjection.expected_message_resource_ids, [resourceId]);
  assert.deepStrictEqual(reports[0].contextProjection.available_message_resource_ids, []);
  assert.deepStrictEqual(reports[0].contextProjection.available_message_ids, []);
  assert.deepStrictEqual(reports[0].contextProjection.missing_message_resource_ids, [resourceId]);
  assert.strictEqual(reports[0].submissionId, 'submit-client-rejection');
  assert.strictEqual(reports[0].jobId, 'chatjob-client-rejection');
}

async function testClientExecutionTraceEndpointRecordsPreDispatchContextProjection() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-client-execution-trace-'));
  const file = path.join(root, 'request-trace.ndjson');
  const logger = createRequestTraceLogger({ enabled: true, root, filePath: file, onError: error => { throw error; } });
  const pendingId = 'pending-submit-submit-msjxqlpe-w3a7fipl';
  const contract = makeExecutionFixture({
    prompt: '这用几个关键字描述一下',
    operation: 'plain_chat',
    relation: 'followup',
    resources: [{
      key: 'r1', type: 'message', source: 'quoted', role: 'context', id: pendingId,
      resource_id: `res:message:${pendingId}`,
    }],
  });
  let response = null;
  const { routeCoreApi } = createCoreRoutes({
    appVersion: 'test',
    buildIdentity: { version: 'test' },
    readPublicConfig: () => ({}),
    sendJson: (res, status, body) => {
      response = { status, body };
      return response;
    },
    sendMethodNotAllowed: () => ({ status: 405 }),
    proxyImage: () => null,
    registerChatStreamJob: () => null,
    requestTrace: logger,
  });
  const resourceId = `res:message:${pendingId}`;
  const req = traceRequest({
    schema_version: 'client_execution_trace.v1',
    event: 'execution.rejected',
    submissionId: 'submit-client-rejection',
    jobId: 'chatjob-client-rejection',
    stage: 'client_context_projection',
    requestPurpose: 'final_execution',
    dispatchContract: contract.dispatchContract,
    bindingEvidence: contract.executionResources.messages,
    contextProjection: {
      input_message_count: 1,
      normalized_message_count: 1,
      selected_message_count: 0,
      quoted_message_count: 1,
      expected_message_resource_ids: [resourceId],
      available_message_resource_ids: [],
      available_message_ids: [],
      selected_message_resource_ids: [],
      missing_message_resource_ids: [resourceId],
    },
    error: {
      name: 'TypeError',
      code: 'EXECUTION_CONTEXT_BINDING_MISSING',
      statusCode: 400,
      message: `Execution context is missing a bound message: ${resourceId}`,
    },
  });

  await routeCoreApi(req, {});
  assert.deepStrictEqual(response, { status: 202, body: { recorded: true } });
  const events = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.strictEqual(events.length, 1);
  const event = events[0];
  assert.strictEqual(event.event, 'execution.rejected');
  assert.strictEqual(event.source, 'client_pre_dispatch');
  assert.strictEqual(event.submission_id, 'submit-client-rejection');
  assert.strictEqual(event.job_id, 'chatjob-client-rejection');
  assert.strictEqual(event.validation_stage, 'client_context_projection');
  assert.strictEqual(event.payload.available, false);
  assert.strictEqual(event.checks.prompt_match, null);
  assert.strictEqual(event.checks.binding_evidence_match, true);
  assert.deepStrictEqual(event.context_projection.expected_message_resource_ids, [resourceId]);
  assert.deepStrictEqual(event.context_projection.available_message_resource_ids, []);
  assert.deepStrictEqual(event.context_projection.missing_message_resource_ids, [resourceId]);
  assert.strictEqual(event.error.code, 'EXECUTION_CONTEXT_BINDING_MISSING');
}

module.exports = [
  testChatServiceReportsStructuredPreDispatchRejection,
  testContextProjectionFailureReportsExpectedAvailableAndMissingMessageIds,
  testClientExecutionTraceEndpointRecordsPreDispatchContextProjection,
];
