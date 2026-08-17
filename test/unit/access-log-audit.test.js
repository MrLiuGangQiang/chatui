'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { proxyAccessAudit } = require('../../server/jobs/common');
const { createAccessLogger } = require('../../server/logging/access-log');

function testProxyAccessAuditCorrelatesStructuredStagesWithoutPromptOrCredentials() {
  const audit = proxyAccessAudit({
    requestPurpose: 'intent_recognition',
    submissionId: 'submit-20260817-abc',
    apiKey: 'sk-should-never-appear',
    headers: { Authorization: 'Bearer secret-token' },
    payload: {
      model: 'route-model',
      input: [{ role: 'user', content: '画一个中国美女 一个俄罗斯美女 给我两个图' }],
      text: { format: { name: 'chatui_route_intent_v3' } },
    },
  });

  assert.deepStrictEqual(audit, {
    request_purpose: 'intent_recognition',
    submission_id: 'submit-20260817-abc',
    model: 'route-model',
    response_format: 'chatui_route_intent_v3',
  });
  const serialized = JSON.stringify(audit);
  assert.doesNotMatch(serialized, /中国美女|俄罗斯美女|sk-should-never-appear|secret-token/);
}

function testAccessLogWritesTheSafeProxyAuditFields() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatui-access-audit-'));
  try {
    const logger = createAccessLogger({ root, enabled: true, maxBytes: 1024 * 1024, rotations: 1 });
    const written = logger.log({
      method: 'POST',
      url: '/api/responses',
      headers: {},
      _accessAudit: {
        request_purpose: 'image_instruction_materialization',
        submission_id: 'submit-audit-1',
        model: 'route-model',
        response_format: 'chatui_image_instruction_v1',
      },
    }, {}, { statusCode: 200, route: 'proxy', traceId: 'trace-audit-1' });
    assert.strictEqual(written, true);

    const [line] = fs.readFileSync(path.join(root, 'temp', 'logs', 'access.ndjson'), 'utf8')
      .trim().split(/\r?\n/).map(entry => JSON.parse(entry));
    assert.strictEqual(line.request_purpose, 'image_instruction_materialization');
    assert.strictEqual(line.submission_id, 'submit-audit-1');
    assert.strictEqual(line.model, 'route-model');
    assert.strictEqual(line.response_format, 'chatui_image_instruction_v1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = [
  testProxyAccessAuditCorrelatesStructuredStagesWithoutPromptOrCredentials,
  testAccessLogWritesTheSafeProxyAuditFields,
];
