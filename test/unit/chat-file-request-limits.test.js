const assert = require('assert');
const { Readable } = require('stream');

const fileInputs = require('../../shared/file-inputs');
const {
  CHAT_BODY_BYTES,
  CHAT_VISUAL_BODY_BYTES,
  CHAT_FILE_BODY_BYTES,
  MAX_FILE_INPUT_DECODED_BYTES,
  extractProxyRequest,
  isResponsesFileDataRequest,
  inspectFileDataUri,
  inspectResponsesFileData,
  validateChatRequestBody,
} = require('../../server/jobs/common');
const { releaseChatJobFileData, summarizeChatPayload } = require('../../server/jobs/chat');
const safeLog = require('../../server/logging/safe-log');

function responsesRequestBody(fileData, extraPayload = {}) {
  return {
    baseUrl: 'https://api.example.com/v1',
    api: 'responses',
    payload: {
      model: 'gpt-test',
      input: [{
        role: 'user',
        content: [
          { type: 'input_file', filename: 'sample.txt', file_data: fileData },
          { type: 'input_text', text: 'Summarize this file.' },
        ],
      }],
      ...extraPayload,
    },
  };
}

function mockResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = '') { this.body += String(body || ''); },
  };
}

async function extractBody(url, body) {
  const raw = JSON.stringify(body);
  const request = Readable.from([raw]);
  request.url = url;
  request.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw, 'utf8')),
  };
  const response = mockResponse();
  const extracted = await extractProxyRequest(request, response);
  return { extracted, response, rawBytes: Buffer.byteLength(raw, 'utf8') };
}

function responseErrorCode(response) {
  return JSON.parse(response.body)?.error?.code;
}

function testFileDataUriValidationAndDecodedAggregateLimit() {
  assert.strictEqual(MAX_FILE_INPUT_DECODED_BYTES, fileInputs.MAX_REQUEST_BYTES);
  assert.strictEqual(CHAT_FILE_BODY_BYTES, 72 * 1024 * 1024);
  assert.strictEqual(isResponsesFileDataRequest({ api: 'responses' }, '/api/chat-jobs'), true);
  assert.strictEqual(isResponsesFileDataRequest({ api: 'responses' }, '/api/chat-stream-jobs'), true);
  assert.strictEqual(isResponsesFileDataRequest({}, '/api/responses'), true);
  assert.strictEqual(isResponsesFileDataRequest({ api: 'responses' }, '/api/chat/completions'), false);

  const inspected = inspectFileDataUri('data:text/plain;base64,SGVsbG8=');
  assert.deepStrictEqual(inspected, {
    decodedBytes: 5,
    fileDataBytes: 'data:text/plain;base64,SGVsbG8='.length,
    mediaType: 'text/plain',
  });
  assert.throws(
    () => inspectFileDataUri('data:text/plain;base64,%%%='),
    error => error?.statusCode === 400 && error?.code === 'INVALID_FILE_DATA'
  );
  assert.throws(
    () => inspectFileDataUri('data:text/plain;base64,AB=='),
    error => error?.statusCode === 400 && error?.code === 'INVALID_FILE_DATA'
  );

  const twoFiles = responsesRequestBody('data:text/plain;base64,QUJD');
  twoFiles.payload.input[0].content.splice(1, 0, {
    type: 'input_file',
    filename: 'second.txt',
    file_data: 'data:text/plain;base64,REVG',
  });
  assert.deepStrictEqual(
    inspectResponsesFileData(twoFiles, { requestUrl: '/api/chat-stream-jobs', maxDecodedBytes: 7 }),
    {
      count: 2,
      decodedBytes: 6,
      fileDataBytes: 'data:text/plain;base64,QUJD'.length + 'data:text/plain;base64,REVG'.length,
    }
  );
  assert.throws(
    () => inspectResponsesFileData(twoFiles, { requestUrl: '/api/chat-stream-jobs', maxDecodedBytes: 6 }),
    error => error?.statusCode === 413 && error?.code === 'FILE_INPUT_REQUEST_TOO_LARGE'
  );
}

function testPlainVisualAndFileRequestTiersStayIsolated() {
  const plain = { payload: { model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] } };
  assert.strictEqual(validateChatRequestBody(plain, { requestUrl: '/api/chat/completions', bodyBytes: CHAT_BODY_BYTES }).kind, 'plain');
  assert.throws(
    () => validateChatRequestBody(plain, { requestUrl: '/api/chat/completions', bodyBytes: CHAT_BODY_BYTES + 1 }),
    error => error?.statusCode === 413 && error?.code === 'PAYLOAD_TOO_LARGE'
  );

  const visual = {
    payload: {
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }],
    },
  };
  assert.strictEqual(validateChatRequestBody(visual, { requestUrl: '/api/responses', bodyBytes: CHAT_VISUAL_BODY_BYTES }).kind, 'visual');
  assert.throws(
    () => validateChatRequestBody(visual, { requestUrl: '/api/responses', bodyBytes: CHAT_VISUAL_BODY_BYTES + 1 }),
    error => error?.statusCode === 413 && error?.code === 'PAYLOAD_TOO_LARGE'
  );

  const fileData = 'data:text/plain;base64,QUJD';
  const canonicalFile = responsesRequestBody(fileData);
  assert.strictEqual(validateChatRequestBody(canonicalFile, {
    requestUrl: '/api/chat-stream-jobs',
    bodyBytes: fileData.length + CHAT_BODY_BYTES,
  }).kind, 'file');
  assert.throws(
    () => validateChatRequestBody(canonicalFile, {
      requestUrl: '/api/chat-stream-jobs',
      bodyBytes: fileData.length + CHAT_BODY_BYTES + 1,
    }),
    error => error?.statusCode === 413 && error?.code === 'PAYLOAD_TOO_LARGE'
  );

  const wrongLocation = {
    api: 'responses',
    payload: { metadata: { type: 'input_file', file_data: fileData } },
  };
  assert.throws(
    () => validateChatRequestBody(wrongLocation, { requestUrl: '/api/chat-stream-jobs', bodyBytes: CHAT_BODY_BYTES + 1 }),
    error => error?.statusCode === 413 && error?.code === 'PAYLOAD_TOO_LARGE'
  );
}

async function testManagedResponsesJobAcceptsBase64FileBeyondVisualLimit() {
  const encoded = Buffer.alloc(9 * 1024 * 1024, 0x61).toString('base64');
  const body = responsesRequestBody(`data:application/pdf;base64,${encoded}`);
  const { extracted, response, rawBytes } = await extractBody('/api/chat-stream-jobs', body);
  assert.ok(rawBytes > CHAT_VISUAL_BODY_BYTES, 'fixture must exceed the image-only request ceiling');
  assert.ok(rawBytes < CHAT_FILE_BODY_BYTES, 'fixture must remain below the absolute file JSON ceiling');
  assert.ok(extracted, `expected accepted file request, got ${response.body}`);
  assert.strictEqual(extracted.body.payload.input[0].content[0].type, 'input_file');
  assert.strictEqual(response.status, 0);
}

async function testMalformedManagedFileDataReturnsStable400() {
  const body = responsesRequestBody('data:text/plain;base64,not valid base64');
  const { extracted, response } = await extractBody('/api/chat-stream-jobs', body);
  assert.strictEqual(extracted, null);
  assert.strictEqual(response.status, 400);
  assert.strictEqual(responseErrorCode(response), 'INVALID_FILE_DATA');
}

function testChatJobReleasesFileDataAndLogsOnlySummaries() {
  const fileData = 'data:application/pdf;base64,QUJD';
  const payload = responsesRequestBody(fileData).payload;
  const job = { payload: structuredClone(payload) };
  const upstreamBody = JSON.stringify({ ...job.payload, stream: true });

  assert.ok(upstreamBody.includes(fileData), 'serialized upstream request must retain the file data');
  assert.strictEqual(releaseChatJobFileData(job), 1);
  const retainedPart = job.payload.input[0].content[0];
  assert.strictEqual(Object.hasOwn(retainedPart, 'file_data'), false);
  assert.strictEqual(retainedPart.filename, 'sample.txt');

  const summary = summarizeChatPayload(payload);
  assert.strictEqual(JSON.stringify(summary).includes(fileData), false);
  assert.strictEqual(safeLog.redactValue({ file_data: fileData }).file_data, '[data-url-redacted]');
}

module.exports = [
  testFileDataUriValidationAndDecodedAggregateLimit,
  testPlainVisualAndFileRequestTiersStayIsolated,
  testManagedResponsesJobAcceptsBase64FileBeyondVisualLimit,
  testMalformedManagedFileDataReturnsStable400,
  testChatJobReleasesFileDataAndLogsOnlySummaries,
];
