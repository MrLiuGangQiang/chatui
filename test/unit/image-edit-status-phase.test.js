'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const imageWorkflow = require('../../client/app/image-workflow');

function testImageEditStatusNeverRegressesFromGenerationBackToUpload() {
  const phase = imageWorkflow.createImageStatusPhase();
  assert.strictEqual(phase.current(), 'preparing');
  assert.strictEqual(phase.beginUpload(), true);
  assert.strictEqual(phase.current(), 'uploading');
  assert.strictEqual(phase.beginGeneration(), true);
  assert.strictEqual(phase.current(), 'generating');
  assert.strictEqual(phase.beginUpload(), false, 'a late XMLHttpRequest upload progress event must not replace the generation status');
  assert.strictEqual(phase.current(), 'generating');

  const source = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  assert.match(source, /!requiresImageEdit && startImageGenerationStatus\(\)/, 'image edits must defer the generation status until the upload request is accepted');
  assert.match(source, /startImageGenerationStatus\(\);\s*\(t\.skipDurableSnapshot \|\| saveDurableImageJob\(\{\s*id: i\.id,/, 'accepted image edits must transition to generation before polling the managed job');
  assert.match(source, /!imageStatusPhase\.beginUpload\(\) \|\| shouldSuppressRunUi/, 'late upload progress must be ignored after generation begins');
}

module.exports = [
  testImageEditStatusNeverRegressesFromGenerationBackToUpload,
];
