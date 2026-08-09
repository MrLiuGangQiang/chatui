'use strict';

const { createRequestPrincipalService } = require('../../server/security/request-principal');

const principalService = createRequestPrincipalService({
  secret: 'test-only-request-principal-secret-at-least-32-bytes',
  tenantId: 'test-tenant',
  cookieSecure: 'never',
});

function makeTestPrincipal() {
  return principalService.resolveRequest({ headers: {} }).principal;
}

function attachTestPrincipal(req, principal = makeTestPrincipal()) {
  Object.defineProperty(req, 'authPrincipal', {
    value: principal,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return req;
}

module.exports = { attachTestPrincipal, makeTestPrincipal, principalService };
