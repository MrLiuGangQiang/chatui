'use strict';

// Regression guard: the upload workflow previously exported a dead
// startTimedUploadPhase() helper whose raw setInterval handle had no cleanup
// path anywhere in the codebase. Upload progress must go through the managed
// uploadProgressTimers map (cleared via clearTimeout), never a raw interval.

const { readSource, assertNotIncludes } = require('../helpers/source-assertions');

function testUploadProgressNeverUsesUnmanagedIntervals() {
  const source = readSource('client/app/attachments-workflow.js');
  assertNotIncludes(
    source,
    'startTimedUploadPhase',
    'startTimedUploadPhase was removed as dead code with a leaking setInterval; do not reintroduce it',
  );
  assertNotIncludes(
    source,
    'setInterval(',
    'upload progress timers must use the managed uploadProgressTimers map with clearTimeout, not a raw setInterval',
  );
}

module.exports = [
  testUploadProgressNeverUsesUnmanagedIntervals,
];