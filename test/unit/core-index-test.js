#!/usr/bin/env node
const assert = require('assert');
const core = require('../../client/core');
assert.strictEqual(typeof core.http.normalizeError, 'function');
assert.strictEqual(typeof core.reasoning.extractStreamDelta, 'function');
assert.strictEqual(typeof core.storage.readJsonStorage, 'function');
assert.strictEqual(typeof core.messages.sortCanonicalMessages, 'function');
assert.strictEqual(typeof core.models.extractModels, 'function');
assert.strictEqual(typeof core.attachments.isImageFile, 'function');
console.log('core index ok');
