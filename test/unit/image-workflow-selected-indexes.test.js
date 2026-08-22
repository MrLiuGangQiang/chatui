'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function testImageCompletionDestructuresSelectedIndexesBeforeUsingIt() {
  const source = fs.readFileSync(path.join(__dirname, '../../client/app/image-workflow.js'), 'utf8');
  assert.match(source, /usesPriorInput:\s*h,\s*isReferenceGeneration:\s*isRefGen,\s*selectedIndexes\s*=\s*\[\]/s,
    'the completion path must derive selectedIndexes from the prepared execution result before merging prior images');
  assert.match(source, /h && selectedIndexes\.length/,
    'the prior-image merge guard must continue to use the prepared selection');
}

module.exports = [testImageCompletionDestructuresSelectedIndexesBeforeUsingIt];
