'use strict';

const assert = require('assert');
const chatService = require('../../client/services/chat-service');
const jobService = require('../../client/services/job-service');

async function testHttpRequestErrorsPreserveStatusCodeAndProviderCode() {
  await assert.rejects(
    chatService.requestJson({
      fetchImpl: async () => ({ ok: false, status: 401 }),
      url: 'https://gateway.example/v1/chat/completions',
      baseUrl: 'https://gateway.example/v1',
      payload: { model: 'route-model' },
      toProxyUrl: () => '/api/chat/completions',
      parseResponseJson: async () => ({ error: { code: 'INVALID_API_KEY', message: 'invalid key' } }),
      normalizeError: (_error, body) => body.error.message,
    }),
    error => error?.statusCode === 401
      && error?.status === 401
      && error?.code === 'INVALID_API_KEY'
      && error?.retryable === false
      && error?.message === 'invalid key',
  );
}

async function testNetworkRequestErrorsRetainMachineReadableIdentity() {
  const cause = new Error('fetch failed');
  await assert.rejects(
    chatService.requestJson({
      fetchImpl: async () => { throw cause; },
      url: 'https://gateway.example/v1/chat/completions',
      baseUrl: 'https://gateway.example/v1',
      payload: { model: 'route-model' },
      toProxyUrl: () => '/api/chat/completions',
      parseResponseJson: async () => ({}),
      normalizeError: () => 'unexpected',
    }),
    error => error?.code === 'NETWORK_REQUEST_FAILED'
      && error?.retryable === true
      && error?.cause === cause,
  );
}

async function testRejectedImageJobStartPreservesServerStatusCodeAndCode() {
  await assert.rejects(
    jobService.startImageGenerationJob({
      payload: { model: 'gpt-image-pro', prompt: 'combined edit' },
      config: { baseUrl: 'https://api.example.test/v1', apiKey: 'secret' },
      jobId: 'imgjob-rejected-editor',
      mode: 'edit_image',
      files: [{ name: 'target.png', type: 'image/png', data: 'AAAA' }],
      masks: [{ name: 'mask.png', type: 'image/png', data: 'AAAA' }],
      requestPurpose: 'final_execution',
      dispatchContract: {},
      submissionId: 'image-edit-rejected',
      fetchImpl: async () => ({ ok: false, status: 400 }),
      parseResponseJson: async () => ({ error: { code: 'IMAGE_ROLE_MAP_MISMATCH', message: '图片用途信息不一致' } }),
      normalizeError: (_error, body) => body.error.message,
    }),
    error => error?.statusCode === 400
      && error?.status === 400
      && error?.code === 'IMAGE_ROLE_MAP_MISMATCH'
      && error?.retryable === false
      && error?.message === '图片用途信息不一致',
  );
}

module.exports = [
  testHttpRequestErrorsPreserveStatusCodeAndProviderCode,
  testNetworkRequestErrorsRetainMachineReadableIdentity,
  testRejectedImageJobStartPreservesServerStatusCodeAndCode,
];
