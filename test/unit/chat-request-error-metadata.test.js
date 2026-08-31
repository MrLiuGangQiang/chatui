'use strict';

const assert = require('assert');
const chatService = require('../../client/services/chat-service');

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

module.exports = [
  testHttpRequestErrorsPreserveStatusCodeAndProviderCode,
  testNetworkRequestErrorsRetainMachineReadableIdentity,
];
