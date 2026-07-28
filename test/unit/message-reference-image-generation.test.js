'use strict';

const assert = require('assert');

const intentContract = require('../../client/core/intent-contract');
const routeService = require('../../client/services/route-service');

const QUOTED_MESSAGE_ID = 'display_ms0k5e48_jiz4h6w';
const QUOTED_MESSAGE_TEXT = 'A detailed assistant answer describing a small orange cat beside a moonlit window.';
const USER_INSTRUCTION = 'Generate an image based on the quoted message, preserving the cat description.';

function quotedMessageContext() {
  return {
    quoted_message: { index: 1, role: 'assistant', id: QUOTED_MESSAGE_ID },
    recent_messages: [{
      index: 1,
      id: QUOTED_MESSAGE_ID,
      role: 'assistant',
      content: QUOTED_MESSAGE_TEXT,
    }],
  };
}

function messageImageContract(role) {
  return {
    schema_version: 'task_contract.v4',
    operation: 'text_to_image',
    relation: 'followup',
    resources: [{
      key: 'r1',
      type: 'message',
      source: 'history',
      role,
      index: 1,
      id: QUOTED_MESSAGE_ID,
      reference_id: '',
      missing: false,
    }],
    directive: {
      mode: 'patch',
      base_resource_keys: ['r1'],
      unmentioned_policy: 'preserve',
      operations: [],
      constraints: [],
    },
    clarification: { question: '', resume_operation: '', unresolved_resources: [] },
    confidence: role === 'reference' ? 1 : 0.98,
    review_reasons: [],
    rationale: 'Generate from the explicitly quoted historical assistant message.',
  };
}

function testQuotedMessageTextToImageContractsBindAndComposeBothRoleVariants() {
  for (const role of ['reference', 'context']) {
    const contract = messageImageContract(role);
    assert.strictEqual(
      intentContract.hasExactContractShape(contract),
      true,
      `text_to_image must accept a historical message resource with role=${role}`,
    );

    const parsed = routeService.parseRouteResult(JSON.stringify(contract), {
      input: USER_INSTRUCTION,
      attachments: [],
      context: quotedMessageContext(),
    });
    assert.ok(parsed, `quoted message contract with role=${role} should be executable`);
    assert.strictEqual(parsed.operationType, 'text_to_image');
    assert.strictEqual(parsed.api, 'image_generation');
    assert.deepStrictEqual(parsed.messageRefs, [{
      key: 'r1',
      role: 'assistant',
      message_id: QUOTED_MESSAGE_ID,
      index: 1,
      source: 'history',
    }]);
    assert.ok(
      parsed.contextualImagePrompt.includes(QUOTED_MESSAGE_TEXT),
      `role=${role} must carry the uniquely bound message text into the image prompt`,
    );
    assert.ok(
      parsed.contextualImagePrompt.includes(USER_INSTRUCTION),
      `role=${role} must preserve the user's current image instruction`,
    );
  }
}

function testQuotedMessageTextToImageBindingFailsClosedForWrongIdentity() {
  const context = quotedMessageContext();
  const wrongId = messageImageContract('reference');
  wrongId.resources[0].id = 'display-other-message';
  assert.strictEqual(
    routeService.parseRouteResult(JSON.stringify(wrongId), {
      input: USER_INSTRUCTION,
      attachments: [],
      context,
    }),
    null,
    'a stale quoted message id must never fall back to another history message',
  );

  const wrongIndex = messageImageContract('context');
  wrongIndex.resources[0].index = 2;
  assert.strictEqual(
    routeService.parseRouteResult(JSON.stringify(wrongIndex), {
      input: USER_INSTRUCTION,
      attachments: [],
      context,
    }),
    null,
    'a quoted message index must resolve to the exact selected history slot',
  );
}

function testQuotedMessageTextToImageCanUseAnExplicitQuoteWithoutHistoryRows() {
  const contract = messageImageContract('reference');
  const context = {
    quoted_message: {
      index: 1,
      role: 'assistant',
      id: QUOTED_MESSAGE_ID,
      content: QUOTED_MESSAGE_TEXT,
    },
  };
  const parsed = routeService.parseRouteResult(JSON.stringify(contract), {
    input: USER_INSTRUCTION,
    attachments: [],
    context,
  });
  assert.ok(parsed, 'an explicit quote remains executable when its compact history row is omitted');
  assert.ok(parsed.contextualImagePrompt.includes(QUOTED_MESSAGE_TEXT));
  assert.ok(parsed.contextualImagePrompt.includes(USER_INSTRUCTION));
}

function testTextToImageRouteMustDeclareQuotedMessageInItsFirstContract() {
  const contract = messageImageContract('reference');
  contract.resources = [];
  contract.directive = {
    mode: 'standalone',
    base_resource_keys: [],
    unmentioned_policy: 'allow_change',
    operations: [],
    constraints: [],
  };
  contract.relation = 'new';

  const parsed = routeService.parseRouteResult(JSON.stringify(contract), {
    input: USER_INSTRUCTION,
    attachments: [],
    context: quotedMessageContext(),
  });

  assert.strictEqual(parsed, null, 'the runtime must reject an omitted quote instead of patching or silently dropping it');
}

function testQuotedMessageTextToImageFailsClosedWhenBoundBodyIsUnavailable() {
  const contract = messageImageContract('reference');
  const parsed = routeService.parseRouteResult(JSON.stringify(contract), {
    input: USER_INSTRUCTION,
    attachments: [],
    context: {
      quoted_message: { index: 1, role: 'assistant', id: QUOTED_MESSAGE_ID },
      recent_messages: [{ index: 1, role: 'assistant', id: QUOTED_MESSAGE_ID, content: '[quoted_message]' }],
    },
  });
  assert.strictEqual(parsed, null, 'a bound message without usable text must never silently degrade to current-input-only generation');
}

function testQuotedImageHistoryAliasRequiresAnExplicitQuote() {
  const contract = {
    schema_version: 'task_contract.v4',
    operation: 'image_qa',
    relation: 'followup',
    resources: [{
      key: 'r1',
      type: 'image',
      source: 'history',
      role: 'source',
      index: 1,
      id: 'img-quoted-only',
      reference_id: 'imgref-quoted-only',
      missing: false,
    }],
    directive: {
      mode: 'patch',
      base_resource_keys: ['r1'],
      unmentioned_policy: 'preserve',
      operations: [],
      constraints: [],
    },
    clarification: { question: '', resume_operation: '', unresolved_resources: [] },
    confidence: 0.9,
    review_reasons: [],
    rationale: 'The image candidate is only marked quoted, without a UI quote binding.',
  };
  const parsed = routeService.parseRouteResult(JSON.stringify(contract), {
    input: 'Describe this image.',
    attachments: [],
    // A quoted candidate without context.quoted_message is not an executable
    // historical binding and must not be accepted through the history alias.
    context: {
      image_candidates: [{
        index: 1,
        source: 'quoted',
        image_id: 'img-quoted-only',
        reference_id: 'imgref-quoted-only',
        target: 'previous',
      }],
    },
  });
  assert.strictEqual(parsed, null, 'quoted image aliases require an explicit UI quote');
}

function testQuotedImageHistoryAliasCannotCrossMessageIdentity() {
  const contract = {
    schema_version: 'task_contract.v4',
    operation: 'image_qa',
    relation: 'followup',
    resources: [{
      key: 'r1', type: 'image', source: 'history', role: 'source', index: 1,
      id: 'img-other-message', reference_id: 'imgref-other-message', missing: false,
    }],
    directive: {
      mode: 'patch', base_resource_keys: ['r1'], unmentioned_policy: 'preserve', operations: [], constraints: [],
    },
    clarification: { question: '', resume_operation: '', unresolved_resources: [] },
    confidence: 0.9,
    review_reasons: [],
    rationale: 'The quoted image belongs to a different historical message.',
  };
  const parsed = routeService.parseRouteResult(JSON.stringify(contract), {
    input: 'Describe the image.',
    context: {
      quoted_message: { index: 2, role: 'assistant', id: 'quoted-message-2' },
      image_candidates: [{
        index: 1, source: 'quoted', message_index: 3,
        image_id: 'img-other-message', reference_id: 'imgref-other-message', target: 'previous',
      }],
    },
  });
  assert.strictEqual(parsed, null, 'a history alias must stay tied to the explicitly quoted message, not merely any quoted candidate');
}

function testQuotedMessagePromptPreservesReferenceTextAndCurrentInstructionWithoutSilentTruncation() {
  const contract = messageImageContract('context');
  const context = quotedMessageContext();
  context.recent_messages[0].content = `${'A'.repeat(3500)}\n[quoted_image index=1 id=hidden]`;
  const parsed = routeService.parseRouteResult(JSON.stringify(contract), {
    input: 'Keep this current instruction at the end of the image prompt.',
    attachments: [],
    context,
  });
  assert.ok(parsed);
  assert.ok(parsed.contextualImagePrompt.includes('Keep this current instruction at the end of the image prompt.'));
  assert.ok(parsed.contextualImagePrompt.startsWith('A'.repeat(3500)), 'the complete bound reference text must reach the image prompt');
  assert.ok(parsed.contextualImagePrompt.length > 3500, 'the composed image prompt must retain both complete parts rather than silently truncating at 3200 characters');
  assert.ok(!parsed.contextualImagePrompt.includes('[quoted_image'), 'route-only quote markers must not reach the image model');
}

function testBoundHistoricalMessageIsNeverRemovedLocally() {
  const contract = messageImageContract('context');
  contract.resources[0].id = 'prior-dog-prompt';
  const currentInput = '再画一只狗，换个品种';
  const parsed = routeService.parseRouteResult(JSON.stringify(contract), {
    input: currentInput,
    context: {
      recent_messages: [{ index: 1, id: 'prior-dog-prompt', role: 'user', content: '画一只狗' }],
    },
  });
  assert.ok(parsed);
  assert.match(parsed.contextualImagePrompt, /^画一只狗\s+再画一只狗，换个品种$/);
  assert.strictEqual(parsed.taskContract.resources[0].id, 'prior-dog-prompt');
}

module.exports = [
  testQuotedMessageTextToImageContractsBindAndComposeBothRoleVariants,
  testQuotedMessageTextToImageBindingFailsClosedForWrongIdentity,
  testQuotedMessageTextToImageCanUseAnExplicitQuoteWithoutHistoryRows,
  testTextToImageRouteMustDeclareQuotedMessageInItsFirstContract,
  testQuotedMessageTextToImageFailsClosedWhenBoundBodyIsUnavailable,
  testQuotedImageHistoryAliasRequiresAnExplicitQuote,
  testQuotedImageHistoryAliasCannotCrossMessageIdentity,
  testQuotedMessagePromptPreservesReferenceTextAndCurrentInstructionWithoutSilentTruncation,
  testBoundHistoricalMessageIsNeverRemovedLocally,
];
