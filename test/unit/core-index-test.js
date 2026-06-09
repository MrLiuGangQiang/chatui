#!/usr/bin/env node
const assert = require('assert');
const core = require('../../client/core');
const sessionConfig = require('../../client/app/session-config');
const formatting = require('../../client/app/formatting');
const markdownUtils = require('../../client/app/markdown-utils');
assert.strictEqual(typeof core.http.normalizeError, 'function');
assert.strictEqual(typeof core.reasoning.extractStreamDelta, 'function');
assert.strictEqual(typeof core.storage.readJsonStorage, 'function');
assert.strictEqual(typeof core.messages.sortCanonicalMessages, 'function');
assert.strictEqual(typeof core.models.extractModels, 'function');
assert.strictEqual(typeof core.attachments.isImageFile, 'function');
assert.strictEqual(typeof sessionConfig.getSessionChatModel, 'function');
assert.strictEqual(typeof formatting.formatElapsed, 'function');
assert.strictEqual(typeof markdownUtils.slugifyHeading, 'function');
console.log('core index ok');
