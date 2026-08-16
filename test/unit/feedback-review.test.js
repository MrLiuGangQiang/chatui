const assert = require('assert');

const feedbackReview = require('../../server/services/feedback-review.service');

function mockResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); },
  };
}

function upstreamReview(content) {
  return mockResponse(200, { output_text: JSON.stringify(content) });
}

function reviewResult(overrides = {}) {
  return {
    schema_version: feedbackReview.FEEDBACK_REVIEW_SCHEMA_VERSION,
    has_problem_description: true,
    has_reproduction_description: true,
    has_expected_result: true,
    reasonable: true,
    message: '',
    ...overrides,
  };
}

function testFeedbackReviewPromptAndParserRequireAllThreeSections() {
  const payload = feedbackReview.createFeedbackReviewPayload({
    model: 'gpt-test',
    content: '点击会话后没有切换。打开移动端侧栏并点击另一个会话即可复现。期望切换到所选会话。\n\n【模型信息（自动填写）】\n意图识别模型：route-test\n聊天模型：gpt-test',
  });
  assert.strictEqual(payload.model, 'gpt-test');
  assert.strictEqual(payload.text.format.type, 'json_schema');
  assert.strictEqual(payload.text.format.strict, true);
  assert.deepStrictEqual(payload.text.format.schema.required, [
    'schema_version',
    'has_problem_description',
    'has_reproduction_description',
    'has_expected_result',
    'reasonable',
    'message',
  ]);
  assert.strictEqual(Object.hasOwn(payload, 'response_format'), false);
  assert.strictEqual(Object.hasOwn(payload, 'messages'), false);
  assert.ok(payload.input[0].content.includes('问题描述'));
  assert.ok(payload.input[0].content.includes('复现描述'));
  assert.ok(payload.input[0].content.includes('期望结果'));
  assert.ok(payload.input[0].content.includes('不可信数据'));
  const feedbackEnvelope = JSON.parse(payload.input[1].content);
  const reviewedFeedback = feedbackEnvelope.feedback;
  assert.strictEqual(feedbackEnvelope.output_format, 'json');
  assert.ok(reviewedFeedback.includes('点击会话后没有切换'));
  assert.ok(!reviewedFeedback.includes('模型信息') && !reviewedFeedback.includes('route-test'), 'automatic model context must not count toward feedback completeness');

  const accepted = feedbackReview.parseFeedbackReviewResult(JSON.stringify(reviewResult()));
  assert.deepStrictEqual(accepted, { accepted: true, missingSections: [], message: '' });

  const rejected = feedbackReview.parseFeedbackReviewResult(JSON.stringify(reviewResult({
    has_reproduction_description: false,
    has_expected_result: false,
    reasonable: false,
    message: '描述不完整',
  })));
  assert.deepStrictEqual(rejected.missingSections, ['reproduction_description', 'expected_result']);
  assert.strictEqual(rejected.accepted, false);
  assert.strictEqual(rejected.message, '描述不完整');

  const rejectedWithoutModelReason = feedbackReview.parseFeedbackReviewResult(JSON.stringify(reviewResult({
    has_reproduction_description: false,
    reasonable: false,
    message: '',
  })));
  assert.strictEqual(rejectedWithoutModelReason.message, '反馈内容不完整，请补充：复现描述。');

  const unreasonable = feedbackReview.parseFeedbackReviewResult(JSON.stringify(reviewResult({
    reasonable: false,
    message: '复现步骤与问题现象不对应，请补充实际触发条件。',
  })));
  assert.strictEqual(unreasonable.accepted, false);
  assert.strictEqual(unreasonable.message, '复现步骤与问题现象不对应，请补充实际触发条件。');
}

async function testFeedbackReviewerRepairsOneInvalidModelResponse() {
  const requests = [];
  const responses = [
    mockResponse(200, { output_text: '{"reasonable":true}' }),
    upstreamReview(reviewResult()),
  ];
  const reviewer = feedbackReview.createFeedbackReviewer({
    baseUrl: 'https://example.test/v1',
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return responses.shift();
    },
  });
  const result = await reviewer.review('问题、复现和期望均已描述', { apiKey: 'sk-test', model: 'gpt-test' });
  assert.strictEqual(result.accepted, true);
  assert.strictEqual(requests.length, 2);
  assert.strictEqual(requests[0].url, 'https://example.test/v1/responses');
  assert.ok(requests[0].body.text?.format);
  assert.strictEqual(Object.hasOwn(requests[0].body, 'messages'), false);
  assert.ok(requests[1].body.input.at(-1).content.includes('上一条输出未通过'));
}

async function testFeedbackReviewerRetriesWithoutUnsupportedStructuredOutput() {
  const requests = [];
  const reviewer = feedbackReview.createFeedbackReviewer({
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      if (requests.length === 1) {
        return mockResponse(400, { error: { message: 'text.format json_schema is unsupported' } });
      }
      return upstreamReview(reviewResult({
        has_problem_description: false,
        reasonable: false,
        message: '请描述实际问题',
      }));
    },
  });
  const result = await reviewer.review('只有复现和期望', { apiKey: 'sk-test', model: 'weak-model' });
  assert.strictEqual(requests.length, 2);
  assert.ok(requests[0].text?.format);
  assert.strictEqual(requests[1].text, undefined);
  assert.ok(Array.isArray(requests[1].input));
  assert.strictEqual(result.accepted, false);
  assert.deepStrictEqual(result.missingSections, ['problem_description']);
}

async function testFeedbackReviewerFailsClosedAfterTwoInvalidResponses() {
  let calls = 0;
  const reviewer = feedbackReview.createFeedbackReviewer({
    fetchImpl: async () => {
      calls += 1;
      return mockResponse(200, { output_text: 'not-json' });
    },
  });
  await assert.rejects(
    reviewer.review('内容无法被审核模型结构化', { apiKey: 'sk-test', model: 'weak-model' }),
    error => error?.code === 'INVALID_FEEDBACK_REVIEW' && error?.statusCode === 502,
  );
  assert.strictEqual(calls, 2);
}

module.exports = [
  testFeedbackReviewPromptAndParserRequireAllThreeSections,
  testFeedbackReviewerRepairsOneInvalidModelResponse,
  testFeedbackReviewerRetriesWithoutUnsupportedStructuredOutput,
  testFeedbackReviewerFailsClosedAfterTwoInvalidResponses,
];
