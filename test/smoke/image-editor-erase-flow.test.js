'use strict';

const assert = require('assert');

const maskEditor = require('../../client/features/image-editor/mask-editor');
const { createImageEditorWorkflow } = require('../../client/app/image-editor-workflow');
const payloadService = require('../../server/services/image-edit-payload.service');

function installFileReader() {
  const previous = global.FileReader;
  class FakeFileReader {
    readAsDataURL(blob) {
      this.result = `data:${blob?.type || 'image/png'};base64,AAAA`;
      queueMicrotask(() => this.onload && this.onload());
    }
  }
  global.FileReader = FakeFileReader;
  return () => {
    if (previous === undefined) delete global.FileReader;
    else global.FileReader = previous;
  };
}

async function testEraseFlowCarriesMaskFromEditorToUpstreamMultipart() {
  const restore = installFileReader();
  try {
    const strokes = [{ x: 0.5, y: 0.5, radius: 0.1 }];
    assert.strictEqual(maskEditor.maskAlphaAtPoint(strokes, 0.5, 0.5), 0,
      'the painted region must become the transparent edit area');
    assert.strictEqual(maskEditor.maskAlphaAtPoint(strokes, 0.1, 0.1), 255,
      'untouched pixels must stay opaque');

    const calls = [];
    const workflow = createImageEditorWorkflow({
      state: { activeSessionId: 'session-smoke', sessions: [{ id: 'session-smoke', messages: [] }], messages: [] },
      toast: () => {},
      isSessionBusy: () => false,
      sendImage: async (prompt, options) => { calls.push({ prompt, options }); },
      makeClientImageJobId: () => 'imgjob-smoke',
    });
    await workflow.applyImageEdit({
      sessionId: 'session-smoke',
      imageBlob: { type: 'image/png' },
      filename: 'target.png',
      edit: {
        mode: 'erase',
        maskBlob: { type: 'image/png' },
        prompt: 'Remove the selected area and fill it naturally with the surrounding background.',
      },
    });
    assert.strictEqual(calls.length, 1);
    const { options } = calls[0];
    assert.strictEqual(options.dispatchContract.operation, 'edit_image');
    assert.strictEqual((options.executionMedia.masks || []).length, 1,
      'the editor flow must project exactly one mask into execution media');

    const multipart = payloadService.buildImageEditMultipartBody(
      { model: 'gpt-image-2.5-sunburst', prompt: options.prompt, background: 'auto' },
      [{ name: 'target.png', type: 'image/png', data: Buffer.from('PNG-TARGET').toString('base64') }],
      { masks: [{ name: 'mask.png', type: 'image/png', data: Buffer.from('PNG-MASK').toString('base64') }] },
    );
    const text = multipart.body.toString('utf8');
    assert.ok(text.includes('name="image"'), 'the target image must be part of the upstream multipart body');
    assert.ok(text.includes('name="mask"'), 'the mask must be part of the upstream multipart body');
    assert.ok(text.includes('filename="mask.png"'), 'the mask filename must survive sanitisation');
  } finally {
    restore();
  }
}

module.exports = [
  testEraseFlowCarriesMaskFromEditorToUpstreamMultipart,
];
