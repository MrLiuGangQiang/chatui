'use strict';

const assert = require('assert');
const registry = require('../../client/runtime/module-registry');

function testModuleRegistryUsesOneHiddenSymbolBackedCompositionBoundary() {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, registry.REGISTRY_SYMBOL);
  assert.ok(descriptor);
  assert.strictEqual(descriptor.enumerable, false);
  assert.strictEqual(descriptor.writable, false);
  assert.strictEqual(registry.resolve('moduleRegistry'), registry);
}

function testModuleRegistryRejectsInvalidAndConflictingRegistrations() {
  assert.throws(() => registry.register('', {}), /name is required/);
  assert.throws(() => registry.register('invalid', null), /api is required/);
  const api = Object.freeze({ value: 1 });
  const modules = globalThis[registry.REGISTRY_SYMBOL];
  try {
    assert.strictEqual(registry.register('unit.registry.fixture', api), api);
    assert.strictEqual(registry.register('unit.registry.fixture', api), api);
    assert.throws(() => registry.register('unit.registry.fixture', Object.freeze({ value: 2 })), /already exists/);
  } finally {
    modules.delete('unit.registry.fixture');
  }
}

module.exports = [
  testModuleRegistryUsesOneHiddenSymbolBackedCompositionBoundary,
  testModuleRegistryRejectsInvalidAndConflictingRegistrations,
];
