'use strict';

const assert = require('assert');
const helpers = require('../../client/app/submit-workflow.helpers');
const routeService = require('../../client/services/route-service');

function executionResource({ key = 'r1', type = 'image', resourceId, id, source = 'history', role = 'target', index = 1, referenceId = '' } = {}) {
  return {
    key,
    type,
    source,
    role,
    index,
    id,
    resource_id: resourceId,
    reference_id: type === 'image' ? referenceId : '',
    identity_aliases: [],
    index_aliases: [],
  };
}

function route({ operation = 'edit_image', images = [], files = [], messages = [] } = {}) {
  return {
    executionResources: {
      version: 'execution_resources.v2',
      operation,
      images,
      files,
      messages,
    },
  };
}

function pools(sourcePools = {}, options = {}) {
  return helpers.buildExecutionResourcePools(sourcePools, {
    isImageFile: item => String(item?.type || '').startsWith('image/'),
    ...options,
  });
}

function testUserUploadAndAssistantHistoryShareOneRegistryWithoutIdentityCollision() {
  const selected = executionResource({ resourceId: 'res:image:assistant-cat', id: 'assistant-cat', source: 'history' });
  const media = helpers.projectRouteExecutionMedia(route({ images: [selected] }), pools({
    current: [{ resource_id: 'res:image:user-cat', imageId: 'user-cat', type: 'image/png', persistedSrc: 'indexeddb://user-cat', sourceIndex: 1 }],
    history: [{ resource_id: 'res:image:assistant-cat', imageId: 'assistant-cat', type: 'image/png', persistedSrc: 'indexeddb://assistant-cat', sourceIndex: 1 }],
  }));
  assert.strictEqual(media.targets[0].resource_id, 'res:image:assistant-cat');
  assert.strictEqual(media.targets[0].routeOriginSource, 'history');
}

function testCanonicalIdentityResolvesAcrossOriginChanges() {
  const selected = executionResource({ resourceId: 'res:image:cat', id: 'cat', source: 'history' });
  const media = helpers.projectRouteExecutionMedia(route({ images: [selected] }), pools({
    current: [{ resource_id: 'res:image:cat', imageId: 'cat-runtime', identity_aliases: ['cat'], type: 'image/png', persistedSrc: 'indexeddb://cat' }],
  }));
  assert.strictEqual(media.targets[0].routeSource, 'history');
  assert.strictEqual(media.targets[0].routeOriginSource, 'current');
  assert.strictEqual(media.targets[0].routeResourceId, 'res:image:cat');
}

function testSameCanonicalIdentityAndLocatorDeduplicatesAcrossPools() {
  const selected = executionResource({ resourceId: 'res:image:cat', id: 'cat', source: 'quoted' });
  const media = helpers.projectRouteExecutionMedia(route({ images: [selected] }), pools({
    current: [{ resource_id: 'res:image:cat', imageId: 'cat', type: 'image/png', persistedSrc: 'indexeddb://cat' }],
    history: [{ resource_id: 'res:image:cat', imageId: 'cat-history', type: 'image/png', persistedSrc: 'indexeddb://cat' }],
  }));
  assert.deepStrictEqual(media.targets[0].routeOriginSources.sort(), ['current', 'history']);
}

function testSameCanonicalIdentityWithDifferentLocatorsFailsClosed() {
  const selected = executionResource({ resourceId: 'res:image:cat', id: 'cat' });
  assert.throws(() => helpers.projectRouteExecutionMedia(route({ images: [selected] }), pools({
    current: [{ resource_id: 'res:image:cat', imageId: 'cat', type: 'image/png', persistedSrc: 'indexeddb://cat-a' }],
    history: [{ resource_id: 'res:image:cat', imageId: 'cat', type: 'image/png', persistedSrc: 'indexeddb://cat-b' }],
  })), error => error.code === 'EXECUTION_RESOURCE_ID_CONFLICT');
}

function testSameCanonicalIdentityWithTwoUnprovenObjectsFailsClosed() {
  const selected = executionResource({ resourceId: 'res:image:cat', id: 'cat' });
  assert.throws(() => helpers.projectRouteExecutionMedia(route({ images: [selected] }), pools({
    current: [{ resource_id: 'res:image:cat', imageId: 'cat', type: 'image/png' }],
    history: [{ resource_id: 'res:image:cat', imageId: 'cat', type: 'image/png' }],
  })), error => error.code === 'EXECUTION_RESOURCE_UNRESOLVED');
}

function testMissingCanonicalIdentityFailsClosed() {
  const selected = executionResource({ resourceId: 'res:image:missing', id: 'missing' });
  assert.throws(() => helpers.projectRouteExecutionMedia(route({ images: [selected] }), pools({ current: [] })),
    error => error.code === 'EXECUTION_RESOURCE_UNRESOLVED');
}

function testQuotedHistoryAndContextAreProvenanceNotIdentity() {
  for (const source of ['quoted', 'history', 'context']) {
    const selected = executionResource({ resourceId: 'res:image:cat', id: 'cat', source });
    const media = helpers.projectRouteExecutionMedia(route({ images: [selected] }), pools({
      current: [{ resource_id: 'res:image:cat', imageId: 'cat', type: 'image/png', persistedSrc: 'indexeddb://cat' }],
    }));
    assert.strictEqual(media.targets[0].routeSource, source);
    assert.strictEqual(media.targets[0].routeOriginSource, 'current');
  }
}

function testPresentationIndexesAndReferencesNeverMergeDifferentResources() {
  const selected = executionResource({ resourceId: 'res:image:assistant-cat', id: 'assistant-cat', source: 'history', index: 1, referenceId: 'same-ref' });
  const media = helpers.projectRouteExecutionMedia(route({ images: [selected] }), pools({
    current: [{ resource_id: 'res:image:user-cat', imageId: 'user-cat', referenceId: 'same-ref', sourceIndex: 1, type: 'image/png', persistedSrc: 'indexeddb://user-cat' }],
    history: [{ resource_id: 'res:image:assistant-cat', imageId: 'assistant-cat', referenceId: 'same-ref', sourceIndex: 1, type: 'image/png', persistedSrc: 'indexeddb://assistant-cat' }],
  }));
  assert.strictEqual(media.targets[0].imageId, 'assistant-cat');
}

function testTypeNamespaceSeparatesImageAndFileWithSameNativeId() {
  const image = executionResource({ key: 'r1', type: 'image', resourceId: 'res:image:shared', id: 'shared', source: 'current', role: 'source' });
  const file = executionResource({ key: 'r2', type: 'file', resourceId: 'res:file:shared', id: 'shared', source: 'current', role: 'attachment' });
  const media = helpers.projectRouteExecutionMedia(route({ operation: 'multimodal_qa', images: [image], files: [file] }), pools({
    current: [
      { imageId: 'shared', type: 'image/png', persistedSrc: 'indexeddb://shared-image' },
      { fileId: 'shared', type: 'text/plain', text: 'shared file body' },
    ],
  }));
  assert.strictEqual(media.chatImages[0].resource_id, 'res:image:shared');
  assert.strictEqual(media.chatFiles[0].resource_id, 'res:file:shared');
}

function testRestoredHistoryUsesCanonicalIdentityInsteadOfPosition() {
  const selected = executionResource({ resourceId: 'res:image:restored-cat', id: 'route-cat', source: 'history', index: 8 });
  const media = helpers.projectRouteExecutionMedia(route({ images: [selected] }), pools({
    history: [
      { resource_id: 'res:image:decoy', imageId: 'decoy', type: 'image/png', sourceIndex: 8, persistedSrc: 'indexeddb://decoy' },
      { resource_id: 'res:image:restored-cat', imageId: 'durable-cat', identity_aliases: ['route-cat'], type: 'image/png', sourceIndex: 2, persistedSrc: 'indexeddb://restored-cat' },
    ],
  }));
  assert.strictEqual(media.targets[0].imageId, 'durable-cat');
  assert.strictEqual(media.targets[0].routeIndex, 8);
}

function testMessagesUseTheSameCanonicalRegistry() {
  const message = executionResource({ key: 'r1', type: 'message', resourceId: 'res:message:answer-1', id: 'answer-1', source: 'quoted', role: 'assistant' });
  const media = helpers.projectRouteExecutionMedia(route({ operation: 'plain_chat', messages: [message] }), pools({}, {
    messages: [{ id: 'answer-1', role: 'assistant', content: 'selected answer' }],
  }));
  assert.strictEqual(media.chatMessages[0].resource_id, 'res:message:answer-1');
  assert.strictEqual(media.chatMessages[0].routeOriginSource, 'history');
}

function testEighthModelCandidateBindsAssistantHistoryImageByCanonicalIdentity() {
  const intent = {
    operation: 'edit_image',
    relation: 'new',
    goal: '测试用户目标',
    resource_refs: [{ candidate_key: 'i8', role: 'target' }],
  };
  const imageCandidates = Array.from({ length: 8 }, (_value, index) => {
    const candidateIndex = index + 1;
    const selected = candidateIndex === 8;
    return {
      index: candidateIndex,
      source_index: candidateIndex,
      source: selected ? 'history' : 'current',
      target: 'previous',
      image_id: selected ? 'idle-4.png' : `other-${candidateIndex}`,
      reference_id: selected ? 'imgref-idle-4' : `ref-${candidateIndex}`,
      description: selected ? 'assistant generated idle-4.png' : `other image ${candidateIndex}`,
    };
  });
  const inspected = routeService.inspectModelRouteResult(JSON.stringify(intent), {
    input: '修改之前生成的图片，把猫的表情改为惊讶。',
    attachments: [],
    context: { recent_messages: [], image_candidates: imageCandidates, file_candidates: [] },
  });
  assert.ok(inspected.route, `the route intent must compile locally: ${inspected.reason}`);
  const compiled = inspected.route;
  assert.strictEqual(compiled.dispatchContract.schema_version, 'dispatch_contract.v1');
  assert.strictEqual(compiled.dispatchContract.bindings[0].resource_id, 'res:image:idle-4.png');
  assert.strictEqual(compiled.resources[0].resource_id, 'res:image:idle-4.png');
  assert.strictEqual(compiled.executionResources.version, 'execution_resources.v2');
  assert.strictEqual(compiled.executionResources.images[0].resource_id, 'res:image:idle-4.png');

  const media = helpers.projectRouteExecutionMedia(compiled, pools({
    current: [{ resource_id: 'res:image:user-upload', imageId: 'user-upload', type: 'image/png', persistedSrc: 'indexeddb://user-upload' }],
    history: [{ resource_id: 'res:image:idle-4.png', imageId: 'idle-4.png', type: 'image/png', persistedSrc: 'indexeddb://idle-4' }],
  }));
  assert.strictEqual(media.targets[0].imageId, 'idle-4.png');
  assert.strictEqual(media.targets[0].resource_id, 'res:image:idle-4.png');
  assert.strictEqual(media.targets[0].routeOriginSource, 'history');
}

function testRouteMessageCandidatePreservesExplicitCanonicalIdentity() {
  const catalog = routeService.buildRouteResourceCandidates({
    attachments: [],
    context: {
      recent_messages: [{
        index: 1,
        id: 'runtime-alias',
        resource_id: 'res:message:canonical-answer',
        role: 'assistant',
        content: 'selected answer',
      }],
      quoted_message: {
        index: 1,
        id: 'runtime-alias',
        resource_id: 'res:message:canonical-answer',
        role: 'assistant',
      },
      image_candidates: [],
      file_candidates: [],
    },
  });
  const message = catalog.find(candidate => candidate.type === 'message');
  assert.ok(message);
  assert.strictEqual(message.resource_id, 'res:message:canonical-answer');
  assert.ok(message.identity_aliases.includes('runtime-alias'));
}

module.exports = [
  testUserUploadAndAssistantHistoryShareOneRegistryWithoutIdentityCollision,
  testCanonicalIdentityResolvesAcrossOriginChanges,
  testSameCanonicalIdentityAndLocatorDeduplicatesAcrossPools,
  testSameCanonicalIdentityWithDifferentLocatorsFailsClosed,
  testSameCanonicalIdentityWithTwoUnprovenObjectsFailsClosed,
  testMissingCanonicalIdentityFailsClosed,
  testQuotedHistoryAndContextAreProvenanceNotIdentity,
  testPresentationIndexesAndReferencesNeverMergeDifferentResources,
  testTypeNamespaceSeparatesImageAndFileWithSameNativeId,
  testRestoredHistoryUsesCanonicalIdentityInsteadOfPosition,
  testMessagesUseTheSameCanonicalRegistry,
  testEighthModelCandidateBindsAssistantHistoryImageByCanonicalIdentity,
  testRouteMessageCandidatePreservesExplicitCanonicalIdentity,
];
