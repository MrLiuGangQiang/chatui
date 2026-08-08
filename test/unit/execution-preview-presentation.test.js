"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const submitHelpers = require("../../client/app/submit-workflow.helpers");
const presentation = require("../../client/features/clarification/presentation");
const imageRouteContext = require("../../client/core/image-route-context");
const imageReferences = require("../../client/core/image-references");

function testImageEditPreviewNamesTheTargetAndRequestedChange() {
  const preview = submitHelpers.buildExecutionPreviewText({
    operationType: "edit_image",
    editInstruction: "把背景改成雪山",
  }, {
    targets: [{ description: "橘猫坐在窗边", name: "cat.png" }],
  });

  assert.strictEqual(preview, "将修改：橘猫坐在窗边；修改内容：把背景改成雪山");
}

function testImagePreviewUsesAPlainFallbackWhenTheOriginalNameIsUnavailable() {
  const preview = submitHelpers.buildExecutionPreviewText({
    operationType: "edit_image",
    editInstruction: "换成黑色",
  }, { targets: [{}] });

  assert.strictEqual(preview, "将修改：第1张图片；修改内容：换成黑色");
}

function testPreviewShowsTheActualChosenImageWithoutCreatingAnotherHistoryImage() {
  const referenceId = imageReferences.makeImageReferenceId('cat-result');
  const imageId = imageReferences.makeImageItemId(referenceId, 1);
  const preview = presentation.buildExecutionPreviewPresentation({
    operationType: 'edit_image',
    editInstruction: '把背景改成雪山',
    imageRefs: [{ role: 'target', image_id: imageId, reference_id: referenceId, index: 1, source: 'history' }],
    executionResources: { targets: [{ id: imageId, reference_id: referenceId, index: 1, label: '橘猫坐在窗边' }] },
  }, {
    messages: [{
      role: 'assistant', displayItemId: 'cat-result',
      content: '[图片生成完成] 橘猫坐在窗边',
      imageContext: JSON.stringify({
        prompt: '橘猫坐在窗边', mode: 'image', target: 'previous',
        attachments: [{ name: 'cat.png', type: 'image/png', src: 'indexeddb://cat-preview' }],
      }),
    }],
  });

  assert.match(preview.html, /data-route-execution-preview="1"/);
  assert.match(preview.html, /data-persisted-src="indexeddb:\/\/cat-preview"/);
  assert.ok(preview.text.includes('橘猫坐在窗边'));
  assert.ok(preview.text.includes('把背景改成雪山'));
  assert.deepStrictEqual(imageRouteContext.extractPersistedImageRefs(preview.html), [],
    'the display-only preview must never be remembered as another generated image');
}

function testFinalResultKeepsOnlyTheNewImageInHistoryWhenItAlsoShowsTheChosenSource() {
  const referenceId = imageReferences.makeImageReferenceId('cat-result');
  const imageId = imageReferences.makeImageItemId(referenceId, 1);
  const preview = presentation.buildExecutionPreviewPresentation({
    operationType: 'edit_image',
    editInstruction: '把背景改成雪山',
    imageRefs: [{ role: 'target', image_id: imageId, reference_id: referenceId, index: 1, source: 'history' }],
    executionResources: { targets: [{ id: imageId, reference_id: referenceId, index: 1, label: '橘猫坐在窗边' }] },
  }, {
    messages: [{
      role: 'assistant', displayItemId: 'cat-result',
      imageContext: JSON.stringify({
        prompt: '橘猫坐在窗边', mode: 'image', target: 'previous',
        attachments: [{ name: 'cat.png', type: 'image/png', src: 'indexeddb://cat-preview' }],
      }),
    }],
  });
  const references = imageRouteContext.collectRecentImageReferences({
    messages: [{
      role: 'assistant',
      displayItemId: 'snowy-cat-result',
      html: `${preview.html}<img data-persisted-src="indexeddb://new-snowy-cat" data-filename="snowy-cat.png" />`,
      imageContext: JSON.stringify({ prompt: '橘猫坐在雪山前', mode: 'edit_image', attachments: [] }),
    }],
    limit: 6,
  });

  assert.strictEqual(references.length, 1);
  assert.strictEqual(references[0].count, 1,
    'the selected source thumbnail must not become a second generated image in history');
  assert.deepStrictEqual(references[0].images.map(item => item.src), ['indexeddb://new-snowy-cat']);
  assert.deepStrictEqual(references[0].images.map(item => item.filename), ['snowy-cat.png']);
}

function testImageWorkflowKeepsExecutionPreviewInternal() {
  const imageWorkflow = fs.readFileSync(path.join(__dirname, "../../client/app/image-workflow.js"), "utf8");
  const submitWorkflow = fs.readFileSync(path.join(__dirname, "../../client/app/submit-workflow.js"), "utf8");
  assert.ok(imageWorkflow.includes("const pendingImageFeedback = status => pendingFeedbackHtml(status);"));
  assert.ok(imageWorkflow.includes("b.metaText || `RT ${v}`"));
  assert.ok(!imageWorkflow.includes("executionPreviewText"));
  assert.ok(!imageWorkflow.includes("executionPreviewHtml"));
  assert.ok(!submitWorkflow.includes("executionPreviewText"));
  assert.ok(!submitWorkflow.includes("executionPreviewHtml"));
}

module.exports = [
  testImageEditPreviewNamesTheTargetAndRequestedChange,
  testImagePreviewUsesAPlainFallbackWhenTheOriginalNameIsUnavailable,
  testPreviewShowsTheActualChosenImageWithoutCreatingAnotherHistoryImage,
  testFinalResultKeepsOnlyTheNewImageInHistoryWhenItAlsoShowsTheChosenSource,
  testImageWorkflowKeepsExecutionPreviewInternal,
];
