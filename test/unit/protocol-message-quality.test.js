'use strict';

const assert = require('assert');
const validator = require('../../server/validators/dispatch-contract.validator');

function testIntentBindingRejectionMessageIsHumanReadable() {
  assert.throws(
    () => validator.validateProxyExecutionRequest({
      requestPurpose: 'intent_recognition',
      bindingEvidence: [{ key: 'r1' }],
      payload: {},
    }, { targetPath: '/responses', method: 'POST' }),
    error => error?.code === 'INTENT_RECOGNITION_BINDINGS_FORBIDDEN'
      && error?.message === '意图识别请求不得携带资源绑定证据',
  );
}

module.exports = [
  testIntentBindingRejectionMessageIsHumanReadable,
];
