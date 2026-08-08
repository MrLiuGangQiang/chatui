'use strict';

const assert = require('assert');
const identity = require('../../client/core/resource-identity');

function testCanonicalResourceIdentityUnifiesOriginsWithoutUsingSourceOrIndex() {
  const uploaded = identity.resourceIdentity({ attachmentId: 'att-cat-1', source: 'current', sourceIndex: 1 }, 'image');
  const restored = identity.resourceIdentity({ resource_id: uploaded.resourceId, imageId: 'img-history-cat', source: 'history', sourceIndex: 8 }, 'image');
  assert.strictEqual(uploaded.resourceId, 'res:image:att-cat-1');
  assert.strictEqual(restored.resourceId, uploaded.resourceId);
  assert.strictEqual(identity.sameResourceIdentity(
    { resource_id: uploaded.resourceId, attachmentId: 'att-cat-1', source: 'current', sourceIndex: 1 },
    { resource_id: uploaded.resourceId, imageId: 'img-history-cat', source: 'history', sourceIndex: 8 },
    'image',
  ), true);
  assert.strictEqual(identity.canonicalResourceId('image', { source: 'history', sourceIndex: 8, reference_id: 'imgref-cat' }), '',
    'provenance and presentation indexes must never manufacture canonical identity');
}

function testResourceIdentitySupportsImagesFilesMessagesAndExplicitIds() {
  assert.strictEqual(identity.canonicalResourceId('image', { imageId: 'img-1' }), 'res:image:img-1');
  assert.strictEqual(identity.canonicalResourceId('file', { fileId: 'file-1' }), 'res:file:file-1');
  assert.strictEqual(identity.canonicalResourceId('message', { displayItemId: 'message-1' }), 'res:message:message-1');
  assert.strictEqual(identity.canonicalResourceId('image', { resource_id: 'resource://canonical-cat', imageId: 'legacy-cat' }), 'res:image:resource%3A%2F%2Fcanonical-cat');
}

function testEnsureResourceIdentityCreatesAndPersistsOneStableMarker() {
  const item = { name: 'cat.png', type: 'image/png' };
  const ensured = identity.ensureResourceIdentity(item, 'image', { idFactory: () => 'rid-test-cat' });
  assert.strictEqual(ensured, item);
  assert.strictEqual(item.imageId, 'rid-test-cat');
  assert.strictEqual(item.image_id, 'rid-test-cat');
  assert.strictEqual(item.resourceId, 'res:image:rid-test-cat');
  assert.strictEqual(item.resource_id, item.resourceId);
  assert.strictEqual(identity.ensureResourceIdentity(item, 'image', { idFactory: () => 'different' }).resourceId, 'res:image:rid-test-cat',
    'ensuring an already identified resource must never replace its identity');
}

function testDurableLocatorMigratesLegacyResourceWithoutIndexIdentity() {
  const first = identity.resourceIdentity({ persistedSrc: 'indexeddb://attachment-cat' }, 'image');
  const moved = identity.resourceIdentity({ persisted_src: 'indexeddb://attachment-cat', source: 'quoted', sourceIndex: 99 }, 'image');
  assert.match(first.resourceId, /^res:image:locator:/);
  assert.strictEqual(moved.resourceId, first.resourceId);
  assert.strictEqual(identity.resourceIdentity({ src: 'blob:https://example.test/transient' }, 'image').resourceId, '');
}

function testIdentityAliasesBridgePersistedAndRuntimeRepresentations() {
  const tokens = identity.identityTokens({
    resource_id: 'res:image:att-1',
    imageId: 'img-result-1',
    attachmentId: 'att-1',
    routeIdAliases: ['durable-store-1'],
  }, 'image');
  for (const value of [
    'res:image:att-1', 'img-result-1', 'res:image:img-result-1',
    'att-1', 'res:image:durable-store-1',
  ]) assert.ok(tokens.includes(value), `missing identity token ${value}`);
}

function testObjectShapedIdsNeverBecomeObjectObjectIdentity() {
  assert.strictEqual(identity.scalarIdentityValue([{ type: 'text', text: 'hello' }]), '');
  assert.strictEqual(identity.canonicalResourceId('message', { id: [{ type: 'text', text: 'hello' }] }), '');
  const message = { id: [{ type: 'text', text: 'hello' }], role: 'assistant' };
  identity.ensureResourceIdentity(message, 'message', { idFactory: () => 'message-stable-1' });
  assert.strictEqual(message.messageId, 'message-stable-1');
  assert.strictEqual(message.resourceId, 'res:message:message-stable-1');
  assert.ok(!identity.identityTokens(message, 'message').some(value => value.includes('[object Object]')));
}

function testDistinctExplicitCanonicalIdsNeverMergeThroughALegacyAlias() {
  const left = { resource_id: 'res:image:canonical-a', imageId: 'shared-legacy-id' };
  const right = { resource_id: 'res:image:canonical-b', imageId: 'shared-legacy-id' };
  assert.strictEqual(identity.sameResourceIdentity(left, right, 'image'), false);
}

function testLongNativeIdsRemainCollisionFree() {
  const prefix = 'x'.repeat(500);
  const left = identity.canonicalFromNative('image', `${prefix}A`);
  const right = identity.canonicalFromNative('image', `${prefix}B`);
  assert.notStrictEqual(left, right);
  assert.ok(left.endsWith('A'));
  assert.ok(right.endsWith('B'));
  assert.strictEqual(identity.stableHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
}

module.exports = [
  testCanonicalResourceIdentityUnifiesOriginsWithoutUsingSourceOrIndex,
  testResourceIdentitySupportsImagesFilesMessagesAndExplicitIds,
  testEnsureResourceIdentityCreatesAndPersistsOneStableMarker,
  testDurableLocatorMigratesLegacyResourceWithoutIndexIdentity,
  testIdentityAliasesBridgePersistedAndRuntimeRepresentations,
  testObjectShapedIdsNeverBecomeObjectObjectIdentity,
  testDistinctExplicitCanonicalIdsNeverMergeThroughALegacyAlias,
  testLongNativeIdsRemainCollisionFree,
];
